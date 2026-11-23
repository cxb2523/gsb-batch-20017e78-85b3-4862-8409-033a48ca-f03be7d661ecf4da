import { describe, it, expect, beforeEach } from 'vitest';
import { WasmPhysicsSimulation } from '../WasmPhysicsSimulation';
import type { TopToken, TraderEdge } from '../WasmPhysicsSimulation';
import type { PhysicsCommand } from '../physics-worker';
import type { WorkerBridgeLike } from '../worker';
import type { WasmSimulationLike } from '../wasm-loader';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function token(tokenAddress: string, volume = 1000): TopToken {
  return {
    tokenAddress,
    symbol: tokenAddress.toUpperCase(),
    name: `Token ${tokenAddress}`,
    chain: 'solana',
    trades: 10,
    volume,
    nativeSymbol: 'SOL',
  };
}

function trade(trader: string, tokenAddress: string): TraderEdge {
  return { trader, tokenAddress, chain: 'solana', trades: 1, volume: 100 };
}

function agentId(trader: string, tokenAddress: string): string {
  return `agent:${trader}:${tokenAddress}`;
}

/** Insertion order and index maps are private; tests read them structurally. */
function mirror(sim: WasmPhysicsSimulation) {
  return sim as unknown as {
    insertionOrder: string[];
    nodeIndexMap: Map<string, number>;
    nodeMap: Map<string, { id: string; x: number; y: number; z: number }>;
  };
}

/**
 * Minimal in-memory stand-in for the wasm-bindgen Simulation.
 * Enumerates nodes in insertion order like the Rust engine, and moves every
 * node deterministically per tick so position frames are easy to verify.
 */
class MockWasmSimulation implements WasmSimulationLike {
  ids: string[] = [];
  edges: Array<[string, string]> = [];
  calls: string[] = [];
  frame = 0;
  private pos = new Map<string, [number, number, number]>();

  add_node(id: string, x: number, y: number, z: number): void {
    this.calls.push(`add_node:${id}`);
    if (!this.pos.has(id)) {
      this.ids.push(id);
      this.pos.set(id, [x, y, z]);
    }
  }

  remove_node(id: string): void {
    this.calls.push(`remove_node:${id}`);
    this.ids = this.ids.filter((other) => other !== id);
    this.pos.delete(id);
    this.edges = this.edges.filter(([s, t]) => s !== id && t !== id);
  }

  add_edge(source: string, target: string): void {
    this.calls.push(`add_edge:${source}->${target}`);
    if (!this.pos.has(source) || !this.pos.has(target)) return;
    if (this.edges.some(([s, t]) => s === source && t === target)) return;
    this.edges.push([source, target]);
  }

  remove_edge(source: string, target: string): void {
    this.calls.push(`remove_edge:${source}->${target}`);
    this.edges = this.edges.filter(([s, t]) => !(s === source && t === target));
  }

  tick(): Float64Array {
    this.frame++;
    for (let i = 0; i < this.ids.length; i++) {
      const [x, y, z] = this.pos.get(this.ids[i])!;
      // Deterministic motion that encodes both frame and insertion index.
      this.pos.set(this.ids[i], [x + i + 1, y + i + 1, z + i + 1]);
    }
    return this.get_positions();
  }

  get_positions(): Float64Array {
    const out = new Float64Array(this.ids.length * 3);
    for (let i = 0; i < this.ids.length; i++) {
      const [x, y, z] = this.pos.get(this.ids[i])!;
      out[i * 3] = x;
      out[i * 3 + 1] = y;
      out[i * 3 + 2] = z;
    }
    return out;
  }

  set_alpha(): void {
    /* recorded via calls by the owning test when relevant */
  }

  set_mouse_repulsion(): void {
    /* no-op */
  }
}

/**
 * Worker bridge double. Mirrors the same insertion-order semantics as the WASM
 * engine and replays position frames through the registered handler.
 */
class MockWorkerBridge implements WorkerBridgeLike {
  ids: string[] = [];
  edges: Array<[string, string]> = [];
  commands: PhysicsCommand[] = [];
  batches: PhysicsCommand[][] = [];
  tickCount = 0;
  lastFrame: Float64Array | null = null;
  disposed = false;
  /** When false, tick() queues its frame for manual delivery (async worker). */
  autoDispatch = true;
  queuedFrames: Float64Array[] = [];
  private pos = new Map<string, [number, number, number]>();
  private handler: ((positions: Float64Array) => void) | null = null;

  waitReady(): Promise<void> {
    return Promise.resolve();
  }

  setPositionsHandler(handler: (positions: Float64Array) => void): void {
    this.handler = handler;
  }

  /** Deliver the oldest queued frame, as a late async message would. */
  dispatchNext(): void {
    const frame = this.queuedFrames.shift();
    if (frame) this.handler?.(frame);
  }

  addNode(id: string, x: number, y: number, z: number): void {
    this.commands.push({ type: 'addNode', id, x, y, z, nodeType: 0, radius: 0 });
    if (!this.pos.has(id)) {
      this.ids.push(id);
      this.pos.set(id, [x, y, z]);
    }
  }

  batch(commands: PhysicsCommand[]): void {
    this.batches.push(commands);
    this.commands.push(...commands);
    for (const cmd of commands) this.apply(cmd);
  }

  private apply(cmd: PhysicsCommand): void {
    switch (cmd.type) {
      case 'addEdge':
        if (!this.pos.has(cmd.source) || !this.pos.has(cmd.target)) return;
        if (this.edges.some(([s, t]) => s === cmd.source && t === cmd.target)) return;
        this.edges.push([cmd.source, cmd.target]);
        return;
      case 'removeEdge':
        this.edges = this.edges.filter(
          ([s, t]) => !(s === cmd.source && t === cmd.target),
        );
        return;
      case 'removeNode':
        this.ids = this.ids.filter((id) => id !== cmd.id);
        this.pos.delete(cmd.id);
        this.edges = this.edges.filter(([s, t]) => s !== cmd.id && t !== cmd.id);
        return;
      default:
        return;
    }
  }

  tick(): void {
    this.tickCount++;
    for (let i = 0; i < this.ids.length; i++) {
      const [x, y, z] = this.pos.get(this.ids[i])!;
      this.pos.set(this.ids[i], [x + i + 1, y + i + 1, z + i + 1]);
    }
    const frame = new Float64Array(this.ids.length * 3);
    for (let i = 0; i < this.ids.length; i++) {
      const [x, y, z] = this.pos.get(this.ids[i])!;
      frame[i * 3] = x;
      frame[i * 3 + 1] = y;
      frame[i * 3 + 2] = z;
    }
    this.lastFrame = frame;
    if (this.autoDispatch) {
      this.handler?.(frame);
    } else {
      this.queuedFrames.push(frame);
    }
  }

  setAlpha(): void {
    /* alpha changes are asserted through the command log by other tests */
  }

  setMouseRepulsion(): void {
    /* no-op */
  }

  dispose(): void {
    this.disposed = true;
    this.handler = null;
  }

  removeNodeCommands(): string[] {
    return this.commands
      .filter((c): c is Extract<PhysicsCommand, { type: 'removeNode' }> => c.type === 'removeNode')
      .map((c) => c.id);
  }
}

/**
 * Assert that every mirror node's position equals the backend frame at its
 * own index — i.e. insertion order and position output stay aligned.
 */
function expectPositionsAligned(
  sim: WasmPhysicsSimulation,
  idsInOrder: string[],
  frame: Float64Array,
): void {
  expect(frame.length).toBe(idsInOrder.length * 3);
  for (let i = 0; i < idsInOrder.length; i++) {
    const node = sim.getNode(idsInOrder[i]);
    expect(node, `node ${idsInOrder[i]} should still exist`).toBeDefined();
    expect(node!.x).toBeCloseTo(frame[i * 3], 10);
    expect(node!.y).toBeCloseTo(frame[i * 3 + 1], 10);
    expect(node!.z).toBeCloseTo(frame[i * 3 + 2], 10);
  }
  // Nothing outside the backend's node set may be written into the mirror.
  expect(mirror(sim).insertionOrder).toEqual(idsInOrder);
}

function expectNoDanglingEdges(sim: WasmPhysicsSimulation, backendEdges: Array<[string, string]>): void {
  const live = new Set(mirror(sim).nodeMap.keys());
  for (const edge of sim.getEdges()) {
    expect(live.has(edge.sourceId), `dangling source ${edge.sourceId}`).toBe(true);
    expect(live.has(edge.targetId), `dangling target ${edge.targetId}`).toBe(true);
  }
  for (const [s, t] of backendEdges) {
    expect(live.has(s), `backend dangling source ${s}`).toBe(true);
    expect(live.has(t), `backend dangling target ${t}`).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WasmPhysicsSimulation — deletion & mirror consistency', () => {
  describe('worker backend', () => {
    let bridge: MockWorkerBridge;
    let sim: WasmPhysicsSimulation;

    beforeEach(() => {
      bridge = new MockWorkerBridge();
      sim = new WasmPhysicsSimulation({ physics: 'wasm', workerBridge: bridge });
    });

    it('removes a hub, its agents, and every edge that touched them', () => {
      sim.update([token('A'), token('B')], [
        trade('bob', 'A'),
        trade('carol', 'A'),
        trade('alice', 'B'),
      ]);

      expect(sim.getHubNodes().map((n) => n.id).sort()).toEqual(['A', 'B']);
      expect(sim.getAgentNodes().map((n) => n.id).sort()).toEqual(
        [agentId('alice', 'B'), agentId('bob', 'A'), agentId('carol', 'A')].sort(),
      );

      // Drop hub A from the ranking; only B and its trader remain.
      sim.update([token('B')], [trade('alice', 'B')]);

      expect(sim.getHubNodes().map((n) => n.id)).toEqual(['B']);
      expect(sim.getAgentNodes().map((n) => n.id)).toEqual([agentId('alice', 'B')]);
      expect(sim.getNode('A')).toBeUndefined();
      expect(sim.getNode(agentId('bob', 'A'))).toBeUndefined();
      expect(sim.getNode(agentId('carol', 'A'))).toBeUndefined();

      // Only the surviving hub and its agent remain; the A–B hub edge and all
      // A-bound agent edges are gone, leaving exactly agent(alice:B)→B.
      expect(sim.getEdges()).toEqual([
        expect.objectContaining({
          sourceId: agentId('alice', 'B'),
          targetId: 'B',
        }),
      ]);

      // remove_node reached the worker for the hub and both of its agents.
      const removed = bridge.removeNodeCommands();
      expect(removed).toContain('A');
      expect(removed).toContain(agentId('bob', 'A'));
      expect(removed).toContain(agentId('carol', 'A'));
      // Deleted endpoints never linger in backend topology.
      expect(bridge.ids).not.toContain('A');
      expectNoDanglingEdges(sim, bridge.edges);
    });

    it('issues edge removals before node removals in a single batch', () => {
      sim.update([token('A'), token('B')], [trade('bob', 'A'), trade('alice', 'B')]);

      const batchesBefore = bridge.batches.length;
      sim.update([token('B')], [trade('alice', 'B')]);

      const removalBatch = bridge.batches[batchesBefore];
      expect(removalBatch).toBeDefined();
      const removeEdgeIdx = removalBatch.findIndex((c) => c.type === 'removeEdge');
      const removeNodeIdx = removalBatch.findIndex((c) => c.type === 'removeNode');
      expect(removeEdgeIdx).toBeGreaterThanOrEqual(0);
      expect(removeNodeIdx).toBeGreaterThan(removeEdgeIdx);
      // The dead A–B hub edge must be explicitly removed.
      expect(removalBatch).toContainEqual({
        type: 'removeEdge',
        source: 'A',
        target: 'B',
      });
    });

    it('removes an agent that stops trading while its hub stays', () => {
      sim.update([token('A')], [trade('bob', 'A'), trade('carol', 'A')]);
      expect(sim.getAgentNodes()).toHaveLength(2);

      // Bob goes quiet; carol keeps trading on the same hub.
      sim.update([token('A')], [trade('carol', 'A')]);

      expect(sim.getNode('A')).toBeDefined();
      expect(sim.getNode(agentId('bob', 'A'))).toBeUndefined();
      expect(sim.getAgentNodes().map((n) => n.id)).toEqual([agentId('carol', 'A')]);

      // Only carol's edge remains; bob's edge is gone everywhere.
      expect(sim.getEdges()).toEqual([
        expect.objectContaining({ sourceId: agentId('carol', 'A'), targetId: 'A' }),
      ]);
      expect(bridge.removeNodeCommands()).toContain(agentId('bob', 'A'));
      expect(bridge.edges).toEqual([[agentId('carol', 'A'), 'A']]);
      expectNoDanglingEdges(sim, bridge.edges);
    });

    it('keeps final graph consistent for a mixed add/remove update', () => {
      sim.update([token('A'), token('B')], [
        trade('bob', 'A'),
        trade('alice', 'B'),
      ]);

      // A leaves the ranking, C joins; bob disappears, dave appears on C.
      sim.update([token('B'), token('C')], [
        trade('alice', 'B'),
        trade('dave', 'C'),
      ]);

      expect(sim.getHubNodes().map((n) => n.id).sort()).toEqual(['B', 'C']);
      expect(sim.getAgentNodes().map((n) => n.id).sort()).toEqual(
        [agentId('alice', 'B'), agentId('dave', 'C')].sort(),
      );
      expect(sim.getNode('A')).toBeUndefined();
      expect(sim.getNode(agentId('bob', 'A'))).toBeUndefined();

      const edges = sim.getEdges();
      // B–C hub link, agent(alice:B)→B, agent(dave:C)→C.
      expect(edges).toHaveLength(3);
      expect(edges).toContainEqual(
        expect.objectContaining({ sourceId: 'B', targetId: 'C' }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({ sourceId: agentId('dave', 'C'), targetId: 'C' }),
      );
      expect(edges).toContainEqual(
        expect.objectContaining({ sourceId: agentId('alice', 'B'), targetId: 'B' }),
      );
      expectNoDanglingEdges(sim, bridge.edges);

      // Worker's node order matches the mirror's insertion order exactly.
      expect(bridge.ids).toEqual(mirror(sim).insertionOrder);
      expect(bridge.edges).toHaveLength(3);
    });

    it('writes tick positions back by insertion order after deletions', () => {
      sim.update([token('A'), token('B'), token('C')], [trade('bob', 'A')]);
      sim.tick();
      sim.tick();

      // Delete A (and its agent); mirror index space must shift cleanly.
      sim.update([token('B'), token('C')], []);

      for (let round = 0; round < 3; round++) {
        sim.tick();
        expect(bridge.lastFrame).not.toBeNull();
        expectPositionsAligned(sim, bridge.ids, bridge.lastFrame!);
      }
    });

    it('drops stale frames produced before a topology change', () => {
      bridge.autoDispatch = false;
      sim.update([token('A'), token('B')], []);
      sim.tick();

      // One frame is in flight, sized for the old 2-node topology.
      expect(bridge.queuedFrames).toHaveLength(1);
      expect(bridge.queuedFrames[0].length).toBe(2 * 3);

      // Shrink to one node before the in-flight frame is delivered. A frame
      // of the wrong size alone would be rejected, so also check a same-size
      // swap below; here we assert nothing is written from the old frame.
      sim.update([token('B')], []);
      const before = { ...sim.getNode('B')! };

      bridge.dispatchNext();
      const after = sim.getNode('B')!;
      expect(after.x).toBe(before.x);
      expect(after.y).toBe(before.y);
      expect(after.z).toBe(before.z);

      // Subsequent ticks apply normally and stay aligned.
      bridge.autoDispatch = true;
      for (let round = 0; round < 2; round++) {
        sim.tick();
        expectPositionsAligned(sim, bridge.ids, bridge.lastFrame!);
      }
    });

    it('does not mis-assign a same-sized frame from before a topology swap', () => {
      bridge.autoDispatch = false;
      sim.update([token('A'), token('B')], []);
      sim.tick();

      // Same node count, different identities/order: a bare length check would
      // let the in-flight frame land on the wrong nodes.
      sim.update([token('C'), token('D')], []);
      expect(mirror(sim).insertionOrder).toEqual(['C', 'D']);

      const cBefore = { ...sim.getNode('C')! };
      const dBefore = { ...sim.getNode('D')! };

      bridge.dispatchNext();

      expect(sim.getNode('C')!.x).toBe(cBefore.x);
      expect(sim.getNode('D')!.x).toBe(dBefore.x);

      // The next (post-update) frame applies and is aligned.
      bridge.autoDispatch = true;
      sim.tick();
      expectPositionsAligned(sim, bridge.ids, bridge.lastFrame!);
      expect(bridge.ids).toEqual(['C', 'D']);
    });

    it('rebuilds index bookkeeping after dispose and a subsequent update', () => {
      sim.update([token('A'), token('B')], [trade('bob', 'A')]);
      sim.dispose();

      expect(bridge.disposed).toBe(true);
      expect(mirror(sim).insertionOrder).toEqual([]);
      expect(mirror(sim).nodeIndexMap.size).toBe(0);

      // Previously removed/cleaned indices must not be reused.
      sim.update([token('X')], [trade('zoe', 'X')]);

      expect(sim.getHubNodes().map((n) => n.id)).toEqual(['X']);
      expect(sim.getAgentNodes().map((n) => n.id)).toEqual([agentId('zoe', 'X')]);
      expect(sim.getNode('A')).toBeUndefined();

      const order = mirror(sim).insertionOrder;
      expect(order).toEqual(['X', agentId('zoe', 'X')]);
      expect(mirror(sim).nodeIndexMap.get('X')).toBe(0);
      expect(mirror(sim).nodeIndexMap.get(agentId('zoe', 'X'))).toBe(1);
      // Index map and insertion order must agree for every mirrored node.
      order.forEach((id, i) => {
        expect(mirror(sim).nodeIndexMap.get(id)).toBe(i);
      });
    });
  });

  describe('main-thread wasm backend', () => {
    let wasm: MockWasmSimulation;
    let sim: WasmPhysicsSimulation;

    beforeEach(() => {
      wasm = new MockWasmSimulation();
      sim = new WasmPhysicsSimulation({ physics: 'wasm', wasmSimulation: wasm });
    });

    it('calls remove_node directly and keeps backend edges clean', () => {
      sim.update([token('A'), token('B')], [trade('bob', 'A'), trade('alice', 'B')]);
      sim.update([token('B')], [trade('alice', 'B')]);

      expect(wasm.calls).toContain('remove_node:A');
      expect(wasm.calls).toContain(`remove_node:${agentId('bob', 'A')}`);
      expect(wasm.ids).not.toContain('A');
      expectNoDanglingEdges(sim, wasm.edges);
    });

    it('aligns consecutive ticks with insertion order after a mixed update', () => {
      sim.update([token('A'), token('B')], [trade('bob', 'A')]);
      sim.tick();
      sim.update([token('B'), token('C')], [trade('dave', 'C')]);

      for (let round = 0; round < 4; round++) {
        sim.tick();
        expectPositionsAligned(sim, wasm.ids, wasm.get_positions());
      }

      expect(sim.getHubNodes().map((n) => n.id).sort()).toEqual(['B', 'C']);
      expect(sim.getAgentNodes().map((n) => n.id)).toEqual([agentId('dave', 'C')]);
      expect(wasm.ids).toEqual(mirror(sim).insertionOrder);
    });
  });

  describe('js fallback', () => {
    it('is a no-op for the backend but still maintains the mirror', () => {
      const sim = new WasmPhysicsSimulation({ physics: 'js' });

      sim.update([token('A'), token('B')], [trade('bob', 'A')]);
      expect(sim.activeBackend).toBe('js');
      expect(sim.getHubNodes()).toHaveLength(2);

      sim.tick();
      sim.update([token('B')], []);

      expect(sim.getHubNodes().map((n) => n.id)).toEqual(['B']);
      expect(sim.getAgentNodes()).toHaveLength(0);
      expect(sim.getEdges()).toHaveLength(0);
      expect(sim.getNode('A')).toBeUndefined();
      expectNoDanglingEdges(sim, []);
      expect(mirror(sim).insertionOrder).toEqual(['B']);
      expect(mirror(sim).nodeIndexMap.get('B')).toBe(0);
    });
  });
});
