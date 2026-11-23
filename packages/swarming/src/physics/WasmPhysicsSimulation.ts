// ============================================================================
// WasmPhysicsSimulation — drop-in replacement for ForceGraphSimulation
//
// Uses the WASM physics engine via Web Worker for off-thread simulation.
// Falls back to main-thread WASM or d3-force-3d JavaScript as needed.
//
// API is compatible with @web3viz/core ForceGraphSimulation:
//   - update(topTokens, traderEdges)
//   - tick()
//   - getHubNodes(), getAgentNodes(), getEdges()
//   - getNode(id)
//   - reheat(alpha)
//   - dispose()
// ============================================================================

import type { PhysicsBackend, PhysicsMode } from './auto-detect';
import { resolvePhysicsMode } from './auto-detect';
import type { PhysicsCommand } from './physics-worker';
import { PhysicsWorkerBridge, type WorkerBridgeLike } from './worker';
import type { WasmSimulationLike } from './wasm-loader';

// Re-export types that match @web3viz/core
export interface GraphNode {
  id: string;
  type: 'hub' | 'agent';
  label: string;
  radius: number;
  color: string;
  hubTokenAddress?: string;
  x?: number;
  y?: number;
  z?: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  source: string | GraphNode;
  target: string | GraphNode;
}

export interface TopToken {
  tokenAddress: string;
  symbol: string;
  name: string;
  chain: string;
  trades: number;
  volume: number;
  nativeSymbol: string;
  source?: string;
}

export interface TraderEdge {
  trader: string;
  tokenAddress: string;
  chain: string;
  trades: number;
  volume: number;
  source?: string;
}

export interface WasmPhysicsConfig {
  /** Physics mode: 'auto', 'wasm', or 'js' */
  physics?: PhysicsMode;
  /** Maximum number of agent nodes */
  maxAgentNodes?: number;
  /** Hub base radius */
  hubBaseRadius?: number;
  /** Hub max radius */
  hubMaxRadius?: number;
  /** Agent radius */
  agentRadius?: number;
  /** Hub node colors */
  hubColors?: string[];
  /** Agent node color */
  agentColor?: string;
  /** Charge strength for hubs */
  hubChargeStrength?: number;
  /** Charge strength for agents */
  agentChargeStrength?: number;
  /** Center force strength */
  centerStrength?: number;
  /** Collision force strength */
  collisionStrength?: number;
  /** Hub-to-hub link distance */
  hubLinkDistance?: number;
  /** Agent-to-hub link distance */
  agentLinkDistanceBase?: number;
  /** Alpha decay rate */
  alphaDecay?: number;
  /** Velocity decay rate */
  velocityDecay?: number;
  /** Barnes-Hut theta (higher = faster but less accurate) */
  theta?: number;
  /** URL to WASM file (optional) */
  wasmUrl?: string;
  /**
   * Pre-built worker bridge. When provided, initialization is skipped and the
   * bridge is used directly. Intended for tests and custom worker transports.
   */
  workerBridge?: WorkerBridgeLike;
  /**
   * Pre-built main-thread WASM simulation. When provided, initialization is
   * skipped and the simulation is used directly. Intended for tests.
   */
  wasmSimulation?: WasmSimulationLike;
}

const DEFAULT_CONFIG = {
  maxAgentNodes: 5000,
  hubBaseRadius: 0.8,
  hubMaxRadius: 3.0,
  agentRadius: 0.06,
  hubColors: [
    '#1a1a2e', '#16213e', '#0f3460', '#2c2c54',
    '#1b1b2f', '#3d3d6b', '#2a2d3e', '#1e3163',
  ],
  agentColor: '#555566',
  hubChargeStrength: -200,
  agentChargeStrength: -8,
  centerStrength: 0.03,
  collisionStrength: 0.7,
  hubLinkDistance: 25,
  agentLinkDistanceBase: 5,
  alphaDecay: 0.01,
  velocityDecay: 0.4,
  theta: 0.9,
};

type ResolvedConfig = typeof DEFAULT_CONFIG &
  Pick<WasmPhysicsConfig, 'physics' | 'wasmUrl' | 'workerBridge' | 'wasmSimulation'>;

interface InternalNode {
  id: string;
  type: 'hub' | 'agent';
  label: string;
  radius: number;
  color: string;
  hubTokenAddress?: string;
  x: number;
  y: number;
  z: number;
}

interface InternalEdge {
  sourceId: string;
  targetId: string;
}

/**
 * WASM-accelerated force graph simulation with the same API as ForceGraphSimulation.
 *
 * Internally manages a WASM simulation (via Worker or main-thread) and keeps
 * a mirror of the node/edge state for querying.
 *
 * The mirror's `insertionOrder` always matches the order in which the backend
 * enumerates nodes (WASM's `get_positions` / the worker's tick response), so
 * positions can be written back by index without ambiguity.
 */
export class WasmPhysicsSimulation {
  // Public state (mirrors ForceGraphSimulation)
  nodes: InternalNode[] = [];
  edges: InternalEdge[] = [];

  private config: ResolvedConfig;
  private nodeMap = new Map<string, InternalNode>();
  private nodeIndexMap = new Map<string, number>(); // id -> index in insertionOrder
  private insertionOrder: string[] = [];

  // WASM backend
  private backend: PhysicsBackend;
  private worker: WorkerBridgeLike | null = null;
  private wasmSim: WasmSimulationLike | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  // Latest positions from WASM
  private latestPositions: Float64Array | null = null;
  /**
   * Bumped whenever the node set/order changes. Worker tick responses are
   * asynchronous, so a frame requested before an update can arrive after it;
   * tagging each tick request with the topology version lets us drop such
   * stale frames instead of writing positions to the wrong nodes.
   */
  private topologyVersion = 0;
  private pendingTickVersions: number[] = [];

  constructor(config: WasmPhysicsConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Injected backends skip async initialization entirely (tests, custom
    // transports). This must happen before any update()/tick() call.
    if (config.workerBridge) {
      this.backend = 'wasm-worker';
      this.worker = config.workerBridge;
      this.worker.setPositionsHandler?.((positions) => this.handleWorkerPositions(positions));
      this.initialized = true;
      this.initPromise = config.workerBridge.waitReady();
      return;
    }

    if (config.wasmSimulation) {
      this.backend = 'wasm';
      this.wasmSim = config.wasmSimulation;
      this.initialized = true;
      this.initPromise = Promise.resolve();
      return;
    }

    this.backend = resolvePhysicsMode(config.physics ?? 'auto');
    this.initPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    const wasmConfig = {
      chargeStrength: this.config.hubChargeStrength,
      agentChargeStrength: this.config.agentChargeStrength,
      linkDistance: this.config.hubLinkDistance,
      agentLinkDistance: this.config.agentLinkDistanceBase,
      linkStrength: 0.1,
      agentLinkStrength: 0.3,
      centerPull: this.config.centerStrength,
      collisionRadius: 0.3,
      collisionStrength: this.config.collisionStrength,
      alphaDecay: this.config.alphaDecay,
      velocityDecay: this.config.velocityDecay,
      theta: this.config.theta ?? 0.9,
    };

    if (this.backend === 'wasm-worker') {
      try {
        this.worker = new PhysicsWorkerBridge({
          config: wasmConfig,
          wasmUrl: this.config.wasmUrl,
          onPositions: (positions) => {
            this.handleWorkerPositions(positions);
          },
        });
        await this.worker.waitReady();
        this.initialized = true;
        return;
      } catch {
        // Fall back to main-thread WASM
        this.backend = 'wasm';
      }
    }

    if (this.backend === 'wasm') {
      try {
        const { loadWasmPhysics } = await import('./wasm-loader');
        const wasm = await loadWasmPhysics(this.config.wasmUrl);
        this.wasmSim = new wasm.Simulation(wasmConfig);
        this.initialized = true;
        return;
      } catch {
        // Fall back to JS
        this.backend = 'js';
      }
    }

    // JS fallback — no WASM available, simulation will be a no-op
    // The consumer should use ForceGraphSimulation from @web3viz/core instead
    this.initialized = true;
    console.warn(
      '[WasmPhysicsSimulation] WASM not available. ' +
      'Falling back to no-op. Use ForceGraphSimulation from @web3viz/core for JS fallback.'
    );
  }

  /** Wait for WASM initialization to complete. */
  async ready(): Promise<void> {
    if (this.initPromise) await this.initPromise;
  }

  /** Which backend is active? */
  get activeBackend(): PhysicsBackend {
    return this.backend;
  }

  /** Feed new data into the simulation (same API as ForceGraphSimulation). */
  update(topTokens: TopToken[], traderEdges: TraderEdge[]): void {
    const c = this.config;
    let changed = false;

    // ---------------------------------------------------------------------
    // 1. Determine what the new input implies
    // ---------------------------------------------------------------------

    const hubAddresses = new Set<string>();
    for (let i = 0; i < topTokens.length; i++) {
      hubAddresses.add(topTokens[i].tokenAddress);
    }

    // Every agent that the current input mentions on a live hub.
    const desiredAgentIds = new Set<string>();
    for (const edge of traderEdges) {
      if (!hubAddresses.has(edge.tokenAddress)) continue;
      desiredAgentIds.add(agentIdFor(edge.trader, edge.tokenAddress));
    }

    // ---------------------------------------------------------------------
    // 2. Remove hubs/agents that the input no longer contains
    // ---------------------------------------------------------------------

    const removedIds: string[] = [];
    for (const node of this.nodes) {
      if (node.type === 'hub') {
        if (!hubAddresses.has(node.id)) removedIds.push(node.id);
      } else if (!desiredAgentIds.has(node.id)) {
        removedIds.push(node.id);
      }
    }

    if (removedIds.length > 0) {
      const removedSet = new Set(removedIds);

      // Edges touching a removed node are dead in the backend too. Removing
      // them explicitly (before removing the nodes) keeps the backend free of
      // dangling endpoints even for engines whose remove_node leaves edges.
      const deadEdges = this.edges.filter(
        (e) => removedSet.has(e.sourceId) || removedSet.has(e.targetId),
      );
      this.wasmRemoveTopology(deadEdges, removedIds);

      // Mirror cleanup: nodeMap, nodes[], insertionOrder and nodeIndexMap.
      for (const id of removedIds) this.nodeMap.delete(id);
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        if (removedSet.has(this.nodes[i].id)) this.nodes.splice(i, 1);
      }
      this.insertionOrder = this.insertionOrder.filter((id) => !removedSet.has(id));
      this.reindexInsertionOrder();

      // Positions produced before the topology change no longer line up.
      this.latestPositions = null;
      changed = true;
    }

    // ---------------------------------------------------------------------
    // 3. Add hubs from top tokens
    // ---------------------------------------------------------------------

    const maxVol = topTokens[0]?.volume || 1;
    for (let i = 0; i < topTokens.length; i++) {
      const t = topTokens[i];
      const existing = this.nodeMap.get(t.tokenAddress);
      const scaledRadius =
        c.hubBaseRadius + (t.volume / maxVol) * (c.hubMaxRadius - c.hubBaseRadius);

      if (existing) {
        existing.radius = scaledRadius;
        existing.label = t.symbol || t.name;
        continue;
      }

      // Spherical distribution using golden angle
      const phi = Math.acos(1 - 2 * (i + 0.5) / Math.max(topTokens.length, 1));
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const dist = 15 + Math.random() * 5;
      const node: InternalNode = {
        id: t.tokenAddress,
        type: 'hub',
        label: t.symbol || t.name,
        radius: scaledRadius,
        color: c.hubColors[i % c.hubColors.length],
        x: Math.sin(phi) * Math.cos(theta) * dist,
        y: Math.sin(phi) * Math.sin(theta) * dist,
        z: Math.cos(phi) * dist,
      };
      this.registerNode(node);
      changed = true;

      this.wasmAddNode(node.id, node.x, node.y, node.z, 0, node.radius);
    }

    // ---------------------------------------------------------------------
    // 4. Add agent nodes from trader edges (respecting the node budget)
    // ---------------------------------------------------------------------

    const agentCount = this.nodes.reduce(
      (count, n) => (n.type === 'agent' ? count + 1 : count),
      0,
    );
    const budget = c.maxAgentNodes - agentCount;
    let added = 0;

    for (const edge of traderEdges) {
      if (!hubAddresses.has(edge.tokenAddress)) continue;
      const agentId = agentIdFor(edge.trader, edge.tokenAddress);
      if (this.nodeMap.has(agentId)) continue;
      if (added >= budget) break;

      const hub = this.nodeMap.get(edge.tokenAddress);
      const aPhi = Math.acos(1 - 2 * Math.random());
      const aTheta = Math.random() * Math.PI * 2;
      const dist = 2 + Math.random() * 4;
      const node: InternalNode = {
        id: agentId,
        type: 'agent',
        label: edge.trader.slice(0, 6),
        radius: c.agentRadius,
        color: c.agentColor,
        hubTokenAddress: edge.tokenAddress,
        x: (hub?.x ?? 0) + Math.sin(aPhi) * Math.cos(aTheta) * dist,
        y: (hub?.y ?? 0) + Math.sin(aPhi) * Math.sin(aTheta) * dist,
        z: (hub?.z ?? 0) + Math.cos(aPhi) * dist,
      };
      this.registerNode(node);
      added++;
      changed = true;

      this.wasmAddNode(node.id, node.x, node.y, node.z, 1, node.radius);
    }

    // ---------------------------------------------------------------------
    // 5. Rebuild edges from the surviving nodes only
    // ---------------------------------------------------------------------

    if (changed) {
      const previousEdges = this.edges;
      const nextEdges = this.buildEdges();
      this.edges = nextEdges;

      // Only newly created edges need to be sent — anything that disappeared
      // was already removed alongside its endpoint in step 2.
      const previousKeys = new Set(previousEdges.map(edgeKey));
      const added = nextEdges.filter((e) => !previousKeys.has(edgeKey(e)));

      this.wasmSyncEdges(added);
      this.wasmSetAlpha(0.3);
      // Anything queued from before the topology change is stale.
      this.topologyVersion++;
      this.latestPositions = null;
    }
  }

  /** Advance the simulation by one tick. */
  tick(): void {
    if (this.backend === 'wasm-worker' && this.worker) {
      this.pendingTickVersions.push(this.topologyVersion);
      this.worker.tick();
      // Positions will arrive async via onPositions callback
      // For synchronous access, use the latest cached positions
      if (this.latestPositions) {
        this.syncPositionsFromWasm(this.latestPositions);
      }
    } else if (this.backend === 'wasm' && this.wasmSim) {
      const positions = this.wasmSim.tick();
      this.syncPositionsFromWasm(positions);
    }
    // JS fallback: no-op (use ForceGraphSimulation instead)
  }

  /** Get hub nodes with current positions. */
  getHubNodes(): GraphNode[] {
    return this.nodes
      .filter((n) => n.type === 'hub')
      .map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        radius: n.radius,
        color: n.color,
        x: n.x,
        y: n.y,
        z: n.z,
      }));
  }

  /** Get agent nodes with current positions. */
  getAgentNodes(): GraphNode[] {
    return this.nodes
      .filter((n) => n.type === 'agent')
      .map((n) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        radius: n.radius,
        color: n.color,
        hubTokenAddress: n.hubTokenAddress,
        x: n.x,
        y: n.y,
        z: n.z,
      }));
  }

  /** Get all edges. */
  getEdges(): GraphEdge[] {
    return this.edges.map((e) => ({
      sourceId: e.sourceId,
      targetId: e.targetId,
      source: e.sourceId,
      target: e.targetId,
    }));
  }

  /** Get a single node by ID. */
  getNode(id: string): GraphNode | undefined {
    const n = this.nodeMap.get(id);
    if (!n) return undefined;
    return {
      id: n.id,
      type: n.type,
      label: n.label,
      radius: n.radius,
      color: n.color,
      hubTokenAddress: n.hubTokenAddress,
      x: n.x,
      y: n.y,
      z: n.z,
    };
  }

  /** Reheat the simulation. */
  reheat(alpha = 0.5): void {
    this.wasmSetAlpha(alpha);
  }

  /** Set mouse repulsion force. */
  setMouseRepulsion(x: number, y: number, z: number, strength: number, radius: number): void {
    if (this.worker) {
      this.worker.setMouseRepulsion(x, y, z, strength, radius);
    } else if (this.wasmSim) {
      this.wasmSim.set_mouse_repulsion(x, y, z, strength, radius);
    }
  }

  /** Stop and clean up. */
  dispose(): void {
    if (this.worker) {
      this.worker.dispose();
      this.worker = null;
    }
    this.wasmSim = null;
    this.latestPositions = null;
    this.pendingTickVersions = [];
    this.nodes = [];
    this.edges = [];
    this.nodeMap.clear();
    this.nodeIndexMap.clear();
    this.insertionOrder = [];
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply a flat [x0,y0,z0, x1,y1,z1, ...] frame to the mirror.
   *
   * The backend enumerates nodes in `insertionOrder`; reject frames whose
   * length does not match the current topology rather than writing positions
   * to the wrong nodes.
   */
  private syncPositionsFromWasm(positions: Float64Array | number[]): void {
    const expected = this.insertionOrder.length * 3;
    if (positions.length !== expected) return;

    for (let i = 0; i < this.insertionOrder.length; i++) {
      const node = this.nodeMap.get(this.insertionOrder[i]);
      if (!node) continue;
      node.x = positions[i * 3];
      node.y = positions[i * 3 + 1];
      node.z = positions[i * 3 + 2];
    }
  }

  /**
   * Handle an async frame from the worker.
   *
   * Frames are delivered in the order ticks were requested. Pop the version
   * that was current when the corresponding tick was sent; if it predates the
   * latest topology change the frame's indices refer to a different node set,
   * so drop it rather than mis-assigning positions.
   */
  private handleWorkerPositions(positions: Float64Array | number[]): void {
    const version = this.pendingTickVersions.shift();
    if (version !== undefined && version !== this.topologyVersion) return;

    // A fallback getPositions() frame or a frame whose length no longer fits.
    if (positions.length !== this.insertionOrder.length * 3) return;

    this.latestPositions = positions instanceof Float64Array ? positions : Float64Array.from(positions);
    this.syncPositionsFromWasm(positions);
  }

  /** Register a new node in every mirror index. */
  private registerNode(node: InternalNode): void {
    this.nodeMap.set(node.id, node);
    this.nodes.push(node);
    this.nodeIndexMap.set(node.id, this.insertionOrder.length);
    this.insertionOrder.push(node.id);
  }

  /** Rebuild id -> index after a removal. */
  private reindexInsertionOrder(): void {
    this.nodeIndexMap.clear();
    for (let i = 0; i < this.insertionOrder.length; i++) {
      this.nodeIndexMap.set(this.insertionOrder[i], i);
    }
  }

  /** Build the edge set implied by the current mirror nodes. */
  private buildEdges(): InternalEdge[] {
    const newEdges: InternalEdge[] = [];
    const hubNodes = this.nodes.filter((n) => n.type === 'hub');

    // Hub-to-hub (fully connected)
    for (let i = 0; i < hubNodes.length; i++) {
      for (let j = i + 1; j < hubNodes.length; j++) {
        newEdges.push({ sourceId: hubNodes[i].id, targetId: hubNodes[j].id });
      }
    }

    // Agent-to-hub
    for (const node of this.nodes) {
      if (
        node.type === 'agent' &&
        node.hubTokenAddress &&
        this.nodeMap.has(node.hubTokenAddress)
      ) {
        newEdges.push({ sourceId: node.id, targetId: node.hubTokenAddress });
      }
    }

    return newEdges;
  }

  private wasmAddNode(
    id: string,
    x: number,
    y: number,
    z: number,
    nodeType: number,
    radius: number,
  ): void {
    if (this.worker) {
      this.worker.addNode(id, x, y, z, nodeType, radius);
    } else if (this.wasmSim) {
      this.wasmSim.add_node(id, x, y, z, nodeType, radius);
    }
  }

  /**
   * Remove nodes and the edges that referenced them from the backend.
   * Edges are removed first so engines that ignore remove_edge for missing
   * nodes still end up clean.
   */
  private wasmRemoveTopology(deadEdges: InternalEdge[], nodeIds: string[]): void {
    if (this.worker) {
      const commands: PhysicsCommand[] = [];
      for (const e of deadEdges) {
        commands.push({ type: 'removeEdge', source: e.sourceId, target: e.targetId });
      }
      for (const id of nodeIds) {
        commands.push({ type: 'removeNode', id });
      }
      this.worker.batch(commands);
    } else if (this.wasmSim) {
      for (const e of deadEdges) {
        this.wasmSim.remove_edge(e.sourceId, e.targetId);
      }
      for (const id of nodeIds) {
        this.wasmSim.remove_node(id);
      }
    }
    // JS fallback: mirror-only, nothing to send.
  }

  private wasmSyncEdges(edges: InternalEdge[]): void {
    if (edges.length === 0) return;
    if (this.worker) {
      // Batch edge additions for efficiency
      const commands = edges.map((e) => ({
        type: 'addEdge' as const,
        source: e.sourceId,
        target: e.targetId,
      }));
      this.worker.batch(commands);
    } else if (this.wasmSim) {
      for (const e of edges) {
        this.wasmSim.add_edge(e.sourceId, e.targetId);
      }
    }
  }

  private wasmSetAlpha(alpha: number): void {
    if (this.worker) {
      this.worker.setAlpha(alpha);
    } else if (this.wasmSim) {
      this.wasmSim.set_alpha(alpha);
    }
  }
}

/** Stable node id for a trader/token pair. */
function agentIdFor(trader: string, tokenAddress: string): string {
  return `agent:${trader}:${tokenAddress}`;
}

/** Directional edge identity, matching the backend's dedupe rule. */
function edgeKey(edge: InternalEdge): string {
  return `${edge.sourceId}->${edge.targetId}`;
}
