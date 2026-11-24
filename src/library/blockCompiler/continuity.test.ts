import { TCompiled, TGraph, TLink, compileBlock, paramDefaults, restoreNodes, snapshotNodes } from ".";
import { TWorkletState, cloneState } from "$library/workletState";
import { compile, processorSource } from "$library/expression";
import { describe, expect, it } from "vitest";

// Сквозной сценарий «Compiled ↔ несобранный блок»: состояние переносится по слотам компилятора
// (y1 ↔ n:expr:y1) через transfer.ts — тем же путём, что и в Group. Проверяем, что y1 продолжается.

const SR = 48000;
const hidden = ['globalThis', 'window', 'self', 'global', 'process', 'eval', 'Function', 'require', 'fetch'];

type Kernel = ((ins: (Float32Array | undefined)[], outs: Float32Array[], ps: Float32Array[], n: number, frame: number) => void) & {
  state(next?: TWorkletState): TWorkletState;
};

const graph = (nodes: string[], configs: Record<string, unknown>[], connect: TLink[], keys?: string[]): TGraph => ({
  nodes,
  configs: configs.map(config => ({ x: 0, y: 0, ...config })),
  connect,
  keys,
});

// Блок: Group Input → Expression(y1 + a) → Group Output
const feedbackGraph = (keys = ['in', 'expr', 'out']) => graph(
  ['GroupInput', 'Expression', 'GroupOutput'],
  [{ slot: 'in' }, { expression: 'y1 + a', _a: 0, _b: 0, _c: 0, _d: 0 }, { slot: 'out' }],
  [[[0, 0], [1, 0]], [[1, 4], [2, 0]]],
  keys
);

const loadBlock = (keys?: string[]) => {
  const g = feedbackGraph(keys);
  const result = compileBlock(g);
  if (!result.ok) throw new Error(result.reason);

  const run = new Function(...hidden, 'sampleRate', `return ${result.source};`)(...hidden.map(() => undefined), SR) as (sr: number) => Kernel;
  const kernel = run(SR);
  const defaults = paramDefaults(g, result.params);

  return {
    get states() {
      return (result as TCompiled).states;
    },
    step(values: number[]) {
      const ins = [Float32Array.from(values)];
      const outs = [new Float32Array(values.length)];
      const ps = result.params.map((_, k) => new Float32Array([defaults[k]]));
      kernel(ins, outs, ps, values.length, 0);
      return [...outs[0]];
    },
    readState: async () => kernel.state(),
    writeState: (state: TWorkletState) => kernel.state(state),
  };
};

// Живая нода Expression: один процессор, как в Expression.tsx; снаружи — те же read/writeWorkletState
type ExpressionProcessor = {
  port: { onmessage: ((event: { data: unknown; }) => void) | null; postMessage(message: unknown): void; };
  process(inputs: unknown[], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

const loadExpression = (source: string) => {
  const result = compile(source);
  if (!result.ok) throw result.error;

  const registered: Record<string, new () => ExpressionProcessor> = {};

  class AudioWorkletProcessor {
    port = { onmessage: null as ((event: { data: unknown; }) => void) | null, postMessage: () => { } };
  }

  // Процессору Expression нужен настоящий Function: он сам собирает ядро через new Function
  new Function(...hidden, 'registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentFrame', 'Function',
    `(() => { ${processorSource('LiveExpression')} })()`)(
    ...hidden.map(() => undefined),
    (name: string, ctor: never) => registered[name] = ctor,
    AudioWorkletProcessor, SR, 0, Function
  );

  const processor = new registered.LiveExpression();
  processor.port.onmessage!({ data: { kernel: result.kernel } });

  return {
    step(values: number[]) {
      const out = [new Float32Array(values.length)];
      processor.process([], [out], {
        a: Float32Array.from(values),
        b: new Float32Array([0]),
        c: new Float32Array([0]),
        d: new Float32Array([0]),
      });
      return [...out[0]];
    },
    // Как у ноды Expression: состояние — { y1 }
    readWorkletState: async (): Promise<TWorkletState> => {
      var reply: TWorkletState = {};
      const original = processor.port.postMessage;

      processor.port.postMessage = (message: unknown) => {
        const data = message as { action?: string; state?: TWorkletState };
        if (data.action === 'reply' && data.state)
          reply = data.state;
        original(message);
      };

      processor.port.onmessage!({ data: { type: 'w-nodes:state', action: 'get', id: 1 } });
      processor.port.postMessage = original;
      return reply;
    },
    writeWorkletState: (state: TWorkletState) => {
      processor.port.onmessage!({ data: { type: 'w-nodes:state', action: 'set', state } });
    },
  };
};

// Ноды в порядке графа: у блока Expression — вторая (индекс 1)
const liveNodes = (expression: ReturnType<typeof loadExpression>) => [{}, expression, {}];

describe('compiled block continuity across the compiled/uncompiled boundary', () => {
  it('keeps the same feedback formula continuous when switching to compiled', async () => {
    // Несобранный блок: живая нода Expression играет 6 сэмплов
    const live = loadExpression('y1 + a');
    const before = live.step([0, 1, 2, 3, 4, 5]);

    // Включили Compiled: снимок живых нод уходит в процессор блока по слотам
    const block = loadBlock();
    const seed = await snapshotNodes(block.states, liveNodes(live));
    block.writeState(seed);
    const after = block.step([6, 7, 8, 9]);

    // Эталон: одной непрерывной формулой на 10 сэмплов
    const reference = loadExpression('y1 + a');
    const whole = reference.step([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    expect([...before, ...after]).toEqual(whole);
  });

  it('keeps going when switching back to uncompiled', async () => {
    // Собранный блок играет 5 сэмплов
    const block = loadBlock();
    const before = block.step([0, 1, 2, 3, 4]);

    // Выключили Compiled: снимок процессора раскладывается по живым нодам
    const live = loadExpression('y1 + a');
    restoreNodes(block.states, liveNodes(live), await block.readState());
    const after = live.step([5, 6, 7]);

    const reference = loadExpression('y1 + a');
    const whole = reference.step([0, 1, 2, 3, 4, 5, 6, 7]);

    expect([...before, ...after]).toEqual(whole);
  });

  it('survives several toggles without drift', async () => {
    const reference = loadExpression('y1 + a');
    const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const whole = reference.step(values);

    const visible: number[] = [];
    var state: TWorkletState = {};

    for (let chunk = 0; chunk < 3; chunk++) {
      const slice = values.slice(chunk * 4, chunk * 4 + 4);

      if (chunk % 2 === 0) {
        // Несобранный: живая нода
        const live = loadExpression('y1 + a');
        restoreNodes(loadBlock().states, liveNodes(live), state);
        visible.push(...live.step(slice));
        state = await snapshotNodes(loadBlock().states, liveNodes(live));
      } else {
        // Собранный: процессор блока
        const block = loadBlock();
        block.writeState(state);
        visible.push(...block.step(slice));
        state = cloneState(await block.readState());
      }
    }

    expect(visible).toEqual(whole);
  });
});
