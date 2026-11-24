import {
  STATE_GET,
  STATE_MESSAGE,
  STATE_REPLY,
  STATE_SET,
  cloneState,
  mergeState,
  pushState,
  requestState,
  stateHelpersSource,
} from ".";
import { describe, expect, it, vi } from "vitest";

// Встраиваемые строки должны вести себя ровно как функции модуля
const embedded = () => {
  const registered: Record<string, unknown> = {};
  new Function(`${stateHelpersSource}\nreturn { cloneState, mergeState };`)();
  const factory = new Function(`${stateHelpersSource}\nreturn { cloneState: cloneState, mergeState: mergeState };`);
  Object.assign(registered, factory());
  return registered as { cloneState: typeof cloneState; mergeState: typeof mergeState; };
};

describe('worklet state value rules', () => {
  it('keeps only finite numbers and real booleans', () => {
    const target = { a: 1, b: true, c: 'x' };

    mergeState(target, { a: 2, b: false, c: 'y' });

    expect(target).toEqual({ a: 2, b: false, c: 'x' });
    expect(mergeState({ a: 1 }, { a: Infinity }).a).toBe(1);
    expect(mergeState({ a: 1 }, { a: NaN }).a).toBe(1);
    expect(mergeState({ a: 1 }, { a: '2' }).a).toBe(1);
    expect(mergeState({ b: true }, { b: 1 }).b).toBe(true);
  });

  it('ignores unknown keys and non-object payloads', () => {
    expect(mergeState({ a: 1 }, { b: 2 })).toEqual({ a: 1 });
    expect(mergeState({ a: 1 }, null as unknown as object)).toEqual({ a: 1 });
    expect(mergeState({ a: 1 }, [2] as unknown as object)).toEqual({ a: 1 });
  });

  it('updates known fields of nested objects only', () => {
    const target = { env: { gate: 0, stage: 0 } } as Record<string, unknown>;

    mergeState(target, { env: { gate: 1, stage: 3, extra: 9 } });

    expect(target).toEqual({ env: { gate: 1, stage: 3 } });
  });

  it('clones nested objects on one level', () => {
    const env = { gate: 1 };
    const copy = cloneState({ env, n: 2 });

    expect(copy).toEqual({ env: { gate: 1 }, n: 2 });
    expect(copy.env).not.toBe(env);
  });

  it('the embedded source behaves like the module functions', () => {
    const { cloneState: embeddedClone, mergeState: embeddedMerge } = embedded();

    for (const [current, next] of [
      [{ a: 1, b: true }, { a: 5, b: false }],
      [{ a: 1 }, { a: NaN }],
      [{ env: { gate: 0 } }, { env: { gate: 1 } }],
      [{ a: 1 }, { z: 1 }],
    ] as [Record<string, unknown>, unknown][]) {
      const a = structuredClone(current);
      const b = structuredClone(current);

      expect(mergeState(a, next)).toEqual(embeddedMerge(b, next));
      expect(cloneState(a)).toEqual(embeddedClone(b));
    }
  });
});

// Фальшивый порт процессора: отвечает на запросы состояния
const port = (state: Record<string, unknown>) => {
  const listeners = new Set<(event: { data: unknown; }) => void>();

  return {
    sent: [] as unknown[],
    postMessage(message: unknown) {
      this.sent.push(message);

      const data = message as { action?: string; id?: number; state?: Record<string, unknown> };

      if (data.action === STATE_GET) {
        queueMicrotask(() => {
          for (const listener of listeners)
            listener({ data: { type: STATE_MESSAGE, action: STATE_REPLY, id: data.id, state: { ...state } } });
        });
      } else if (data.action === STATE_SET) {
        Object.assign(state, data.state ?? {});
      }
    },
    addEventListener(_type: 'message', listener: (event: { data: unknown; }) => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: { data: unknown; }) => void) {
      listeners.delete(listener);
    },
  };
};

describe('worklet state messages', () => {
  it('asks for a snapshot and resolves with it', async () => {
    const channel = port({ y1: 4, env: { gate: 1 } });
    await expect(requestState(channel)).resolves.toEqual({ y1: 4, env: { gate: 1 } });
    expect(channel.sent[0]).toMatchObject({ type: STATE_MESSAGE, action: STATE_GET });
  });

  it('resolves with an empty snapshot when the processor is silent', async () => {
    vi.useFakeTimers();
    const silent = { postMessage() { }, addEventListener() { }, removeEventListener() { } };
    const promise = requestState(silent, 50);

    await vi.advanceTimersByTimeAsync(60);
    await expect(promise).resolves.toEqual({});
    vi.useRealTimers();
  });

  it('ignores replies to older requests and unrelated messages', async () => {
    const listeners = new Set<(event: { data: unknown; }) => void>();
    const channel = {
      sent: [] as unknown[],
      postMessage(message: unknown) {
        this.sent.push(message);

        if ((message as { action?: string; }).action !== STATE_GET)
          return;

        const id = (message as { id: number; }).id;

        queueMicrotask(() => {
          const reply = (replyId: number, state: Record<string, unknown>) => {
            for (const listener of listeners)
              listener({ data: { type: STATE_MESSAGE, action: STATE_REPLY, id: replyId, state } });
          };

          // Мусор и ответ на позавчерашний запрос не должны закрыть текущий
          reply(id - 5, { y1: -1 });
          reply(id + 1, { y1: -2 });
          for (const listener of listeners)
            listener({ data: 'not a state message' });
          reply(id, { y1: 4 });
        });
      },
      addEventListener(_type: 'message', listener: (event: { data: unknown; }) => void) {
        listeners.add(listener);
      },
      removeEventListener(_type: 'message', listener: (event: { data: unknown; }) => void) {
        listeners.delete(listener);
      },
    };

    await expect(requestState(channel)).resolves.toEqual({ y1: 4 });
  });

  it('sends the state to apply', () => {
    const channel = port({ y1: 0 });
    pushState(channel, { y1: 7 });

    expect(channel.sent.at(-1)).toEqual({ type: STATE_MESSAGE, action: STATE_SET, state: { y1: 7 } });
  });
});
