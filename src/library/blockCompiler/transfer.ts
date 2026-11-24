import type { TStateSlot } from "./compile";
import type { TWorkletState } from "$library/workletState";

// Живая нода, которая умеет отдавать и принимать своё состояние.
// Имена ключей в состоянии — те же, что у шаблона компилятора (y1, phase, count, env…).
export type TStateNode = {
  readWorkletState?(): Promise<TWorkletState | null>;
  writeWorkletState?(state: TWorkletState): void;
};

export const isStateNode = (node: unknown): node is Required<TStateNode> => (
  !!node && typeof node === 'object' &&
  typeof (node as TStateNode).readWorkletState === 'function' &&
  typeof (node as TStateNode).writeWorkletState === 'function'
);
// Состояния петель (`delayed`) живут только внутри процессора: у живой ноды им соответствия нет
const isTransferable = (slot: TStateSlot) => slot.name !== 'delayed';

const byNode = (slots: TStateSlot[]) => {
  const map = new Map<number, TStateSlot[]>();

  for (const slot of slots) {
    if (!isTransferable(slot))
      continue;

    const list = map.get(slot.node);

    if (list)
      list.push(slot);
    else
      map.set(slot.node, [slot]);
  }

  return map;
};

// Снимок состояния живых нод для запуска процессора: ключи — слоты компилятора.
// Ноды без состояния и опоздавшие (нет ответа) просто пропускаются.
export async function snapshotNodes(slots: TStateSlot[], nodes: readonly unknown[]): Promise<TWorkletState> {
  const seed: TWorkletState = {};

  await Promise.all([...byNode(slots)].map(async ([index, list]) => {
    const node = nodes[index];

    if (!isStateNode(node))
      return;

    const state = await node.readWorkletState();

    if (!state)
      return;

    for (const slot of list)
      if (Object.hasOwn(state, slot.name))
        seed[slot.key] = state[slot.name];
  }));

  return seed;
}

// Раскладывает состояние процессора по живым нодам: каждая получает свои ключи.
// Ручки состояния у ноды проверяют типы сами, лишнее просто игнорируется.
export function restoreNodes(slots: TStateSlot[], nodes: readonly unknown[], state: TWorkletState) {
  if (!state || typeof state !== 'object')
    return;

  for (const [index, list] of byNode(slots)) {
    const node = nodes[index];

    if (!isStateNode(node))
      continue;

    const payload: TWorkletState = {};
    var any = false;

    for (const slot of list) {
      if (!Object.hasOwn(state, slot.key))
        continue;

      payload[slot.name] = state[slot.key];
      any = true;
    }

    if (any)
      node.writeWorkletState(payload);
  }
}
