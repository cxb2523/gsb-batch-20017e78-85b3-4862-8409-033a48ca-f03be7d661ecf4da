import { TCompiled, TStateSlot, blockProcessorSource, paramName } from "$library/blockCompiler";
import { TWorkletState, requestState } from "$library/workletState";

import { STOP_MESSAGE } from "$library/expression";
import { SignalNode } from "../lib/signalNode";
import type { TPair } from "./routing";
import { ctx } from "../ctx";
import { defineRuntimeWorklet } from "../lib/runtimeWorklet";
import { dispose } from "$library/dispose";
import { pipe } from "../lib/pipe";

// Скомпилированный блок, который сейчас звучит
export type TProgram = {
  key: string;
  signals: unknown[];
  // Соединения «вход блока → выход блока» мимо процессора
  passthrough: TPair<AudioNode>[];
  // Слоты состояния, которые понимает этот процессор
  states: TStateSlot[];
  // Снимок состояния процессора: по нему следующая сборка продолжает счёт
  readState(): Promise<TWorkletState>;
  stop(): void;
};

type TBuildOptions = {
  key: string;
  result: TCompiled;
  signals: unknown[];
  defaults: number[];
  outer(id: string): AudioNode;
  onError(): void;
  // Состояние, с которого новый процессор начинает счёт. Функция вызывается после загрузки
  // модуля, прямо перед созданием узла: снимок берётся как можно позже, без разрыва звука.
  seed?: TWorkletState | (() => Promise<TWorkletState>);
};

// Один AudioWorkletNode на весь блок: вход процессора на каждый входной слот, выход — на выходной.
// Каждый вход и выход — один канал: внутри блока всё моно, как и у параметров нод.
export async function buildProgram({ key, result, signals, defaults, outer, onError, seed }: TBuildOptions): Promise<TProgram> {
  const passthrough = result.passthrough.map(([a, b]): TPair<AudioNode> => [outer(a), outer(b)]);
  const states = result.states;

  if (!result.outputs.length)
    return { key, signals, passthrough, states, readState: async () => ({}), stop() { } };

  const processor = await defineRuntimeWorklet(`block:${result.source}`, name => blockProcessorSource(name, result));
  // Снимок берём после загрузки модуля, чтобы перерыв между старой и новой программой был минимальным
  const initial = typeof seed === 'function' ? await seed() : seed;
  const node = new AudioWorkletNode(ctx, processor, {
    numberOfInputs: result.inputs.length,
    numberOfOutputs: result.outputs.length,
    outputChannelCount: result.outputs.map(() => 1),
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    // Начальное состояние применяется в конструкторе процессора — до первого process()
    processorOptions: initial && Object.keys(initial).length ? { state: initial } : undefined,
  });

  node.onprocessorerror = onError;

  const unwire = dispose(
    ...result.inputs.map((id, k) => {
      const gain = outer(id);
      gain.connect(node, 0, k);
      return () => gain.disconnect(node, 0, k);
    }),
    ...result.outputs.map((id, k) => {
      const gain = outer(id);
      node.connect(gain, k, 0);
      return () => node.disconnect(gain, k, 0);
    }),
    ...result.params.map((_, k) => {
      const param = node.parameters.get(paramName(k))!;
      const signal = signals[k];

      // Значение без провода идёт из ConstantSourceNode самой ноды: ручки работают без перекомпиляции
      if (signal instanceof SignalNode) {
        param.value = 0;
        return pipe(signal.node, param);
      }

      param.value = defaults[k];
    }),
  );

  return {
    key,
    signals,
    passthrough,
    states,
    readState: () => requestState(node.port),
    stop() {
      node.onprocessorerror = null;
      unwire();
      node.port.postMessage(STOP_MESSAGE);
    },
  };
}
