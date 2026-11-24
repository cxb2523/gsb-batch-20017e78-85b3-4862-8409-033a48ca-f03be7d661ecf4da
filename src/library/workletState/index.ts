// Протокол состояния AudioWorklet'ов: снимок и восстановление без пересоздания процессора.
// Состояние — только числа, булевы и плоские объекты из них, чтобы переживать structured clone.
// Одни и те же правила вшиваются в сгенерированные исходники процессоров (stateHelpersSource),
// поэтому здесь нет ничего, кроме строк и чистых функций.

export const STATE_MESSAGE = 'w-nodes:state';
export const STATE_GET = 'get';
export const STATE_SET = 'set';
export const STATE_REPLY = 'reply';

// Сколько ждём ответа процессора. Дольше — считаем, что он уже не работает.
export const STATE_TIMEOUT = 200;

export type TWorkletState = Record<string, unknown>;

// Вид значения состояния: по нему состояние проверяется при переносе между процессорами
export type TStateKind = 'number' | 'boolean' | 'object';

// Минимальный порт, которого достаточно для обмена состоянием
export type TStatePort = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown; }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown; }) => void): void;
};

export const isRecord = (value: unknown): value is Record<string, unknown> => (
  !!value && typeof value === 'object' && !Array.isArray(value)
);

// Копия состояния для передачи наружу: вложенные объекты копируются на один уровень
export const cloneState = (source: TWorkletState): TWorkletState => {
  const copy: TWorkletState = {};

  for (const key in source) {
    const value = source[key];
    copy[key] = isRecord(value) ? { ...value } : value;
  }

  return copy;
};
// Накатывает source на target на месте: только известные ключи и только значения того же вида.
// Число — конечное число, булево — булево, объект — известные числовые и булевы поля.
export const mergeState = (target: TWorkletState, source: unknown): TWorkletState => {
  if (!isRecord(source))
    return target;

  for (const key in target) {
    if (!Object.hasOwn(source, key))
      continue;

    const current = target[key];
    const next = source[key];

    if (typeof current === 'number') {
      if (typeof next === 'number' && Number.isFinite(next))
        target[key] = next;
    } else if (typeof current === 'boolean') {
      if (typeof next === 'boolean')
        target[key] = next;
    } else if (isRecord(current) && isRecord(next)) {
      for (const field in current) {
        const a = current[field], b = next[field];

        if (typeof a === 'number') {
          if (typeof b === 'number' && Number.isFinite(b))
            current[field] = b;
        } else if (typeof a === 'boolean') {
          if (typeof b === 'boolean')
            current[field] = b;
        }
      }
    }
  }

  return target;
};

// Исходники cloneState/mergeState для встраивания в процессоры. Правила совпадают
// с функциями выше — это проверяет workletState.test.ts.
export const stateHelpersSource = [
  'function cloneState(source) {',
  '  const copy = {};',
  '  for (const key in source) {',
  '    const value = source[key];',
  '    copy[key] = value && typeof value === "object" && !Array.isArray(value) ? Object.assign({}, value) : value;',
  '  }',
  '  return copy;',
  '}',
  'function mergeState(target, source) {',
  '  if (!source || typeof source !== "object" || Array.isArray(source))',
  '    return target;',
  '  for (const key in target) {',
  '    if (!Object.hasOwn(source, key))',
  '      continue;',
  '    const current = target[key];',
  '    const next = source[key];',
  '    if (typeof current === "number") {',
  '      if (typeof next === "number" && Number.isFinite(next))',
  '        target[key] = next;',
  '    } else if (typeof current === "boolean") {',
  '      if (typeof next === "boolean")',
  '        target[key] = next;',
  '    } else if (current && typeof current === "object" && !Array.isArray(current)) {',
  '      if (!next || typeof next !== "object" || Array.isArray(next))',
  '        continue;',
  '      for (const field in current) {',
  '        const a = current[field], b = next[field];',
  '        if (typeof a === "number") {',
  '          if (typeof b === "number" && Number.isFinite(b))',
  '            current[field] = b;',
  '        } else if (typeof a === "boolean") {',
  '          if (typeof b === "boolean")',
  '            current[field] = b;',
  '        }',
  '      }',
  '    }',
  '  }',
  '  return target;',
  '}',
].join('\n');

var requestCount = 0;

// Снимок состояния процессора. Таймаут — не ошибка: просто пустой снимок.
export const requestState = (port: TStatePort, timeout = STATE_TIMEOUT) => (
  new Promise<TWorkletState>((resolve) => {
    const id = ++requestCount;
    var settled = false;
    var timer: ReturnType<typeof setTimeout> | undefined;

    const finish = (state: TWorkletState) => {
      if (settled)
        return;

      settled = true;

      if (timer !== undefined)
        clearTimeout(timer);

      port.removeEventListener('message', onMessage);
      resolve(state);
    };

    const onMessage = (event: { data: unknown; }) => {
      const data = event.data;

      if (isRecord(data) && data.type === STATE_MESSAGE && data.action === STATE_REPLY && data.id === id)
        finish(isRecord(data.state) ? data.state : {});
    };

    timer = setTimeout(() => finish({}), timeout);
    port.addEventListener('message', onMessage);
    port.postMessage({ type: STATE_MESSAGE, action: STATE_GET, id });
  })
);

// Восстановление состояния процессора. Ответ не ждём: сообщения порта идут по порядку.
export const pushState = (port: TStatePort, state: TWorkletState) => {
  port.postMessage({ type: STATE_MESSAGE, action: STATE_SET, state });
};
