import { halfEdgeEnd, type NavGraph, pointOnHalfEdge } from '@city/nav';
import { AgentStateFlag, type AgentStore } from './agent-store.ts';
import { TimingWheel } from './timing-wheel.ts';

/**
 * Event-driven edge following (implementation plan §15, §19): agents cost nothing between edge
 * ends. At each edge end the agent picks its next half-edge (random walk, no U-turns except at
 * dead ends), its record changes, and it is marked dirty for upload. Agents on edges near a focus
 * point form the near tier (T0) and additionally run per-tick local avoidance.
 */
export interface SimulationOptions {
  graph: NavGraph;
  store: AgentStore;
  /** Agents [start, end) of the store owned by this simulation (one per worker). */
  start: number;
  end: number;
  seed: number;
  startMs?: number;
  /** Near tier: agents on edges whose midpoint is within `radius` of (x, z). */
  focus?: { x: number; z: number; radius: number };
  /** Run local avoidance for near-tier agents every step. */
  avoidance?: boolean;
}

export interface StepStats {
  /** Edge-end events processed. */
  events: number;
  /** Near-tier agents that ran avoidance. */
  nearAgents: number;
  /** Near-tier agents whose lane offset changed (and were marked dirty). */
  lateralChanges: number;
}

/** Avoidance: neighbours closer than this push each other sideways. */
const AVOID_RADIUS = 0.7;
const HASH_CELL = 2;
const LATERAL_STEP = 1; // 2 cm
const LATERAL_LIMIT = 30; // 60 cm either side

export class Simulation {
  readonly store: AgentStore;
  readonly graph: NavGraph;
  readonly start: number;
  readonly end: number;
  private readonly wheel: TimingWheel;
  private readonly focus: { x: number; z: number; radiusSq: number } | undefined;
  private readonly avoidance: boolean;
  private readonly dirty: Uint32Array;
  private dirtyCount = 0;
  /** Near-tier membership: swap-remove list plus each agent's position in it (−1 = not near). */
  private readonly nearList: Uint32Array;
  private readonly nearIndex: Int32Array;
  private nearCount = 0;
  private nowMs: number;
  // Avoidance scratch (sized to the owned range, reused every step).
  private readonly px: Float32Array;
  private readonly pz: Float32Array;
  private readonly dx: Float32Array;
  private readonly dz: Float32Array;
  private readonly next: Int32Array;
  private readonly heads: Int32Array;
  private readonly point: [number, number] = [0, 0];

  constructor(options: SimulationOptions) {
    this.store = options.store;
    this.graph = options.graph;
    this.start = options.start;
    this.end = options.end;
    this.nowMs = options.startMs ?? 0;
    this.wheel = new TimingWheel(this.nowMs);
    this.avoidance = options.avoidance ?? false;
    this.focus =
      options.focus === undefined
        ? undefined
        : { x: options.focus.x, z: options.focus.z, radiusSq: options.focus.radius ** 2 };
    const owned = this.end - this.start;
    this.dirty = new Uint32Array(owned);
    this.nearList = new Uint32Array(owned);
    this.nearIndex = new Int32Array(owned).fill(-1);
    this.px = new Float32Array(owned);
    this.pz = new Float32Array(owned);
    this.dx = new Float32Array(owned);
    this.dz = new Float32Array(owned);
    this.next = new Int32Array(owned);
    this.heads = new Int32Array(nextPowerOfTwo(Math.max(64, owned)));
    this.spawn(options.seed);
  }

  get now(): number {
    return this.nowMs;
  }

  get nearTierSize(): number {
    return this.nearCount;
  }

  /** Places every owned agent at a random point of a random half-edge. */
  private spawn(seed: number): void {
    const { store, graph } = this;
    let rng = seed >>> 0 || 1;
    const random = (): number => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      return (rng >>> 0) / 4294967296;
    };
    for (let i = this.start; i < this.end; i++) {
      const halfEdge = Math.floor(random() * graph.edgeCount * 2);
      const length = graph.edgeLength[halfEdge >>> 1];
      const speed = Math.round((1.0 + random() * 0.6) * 1000);
      store.halfEdge[i] = halfEdge;
      store.s0[i] = random() * length;
      store.t0[i] = this.nowMs;
      store.speed[i] = speed;
      store.phase0[i] = Math.floor(random() * 0x10000);
      store.seed[i] = Math.floor(random() * 0x100000000);
      store.rng[i] = Math.floor(random() * 0xfffffffe) + 1;
      store.lateral[i] = 0;
      store.state[i] = 0;
      store.nextEvent[i] = this.nowMs + Math.ceil(((length - store.s0[i]) * 1_000_000) / speed);
      this.wheel.schedule(i, store.nextEvent[i]);
      this.updateTier(i);
      this.markDirty(i);
    }
  }

  /** Advances simulation time to `nowMs`: due edge-end events, then near-tier avoidance. */
  step(nowMs: number): StepStats {
    this.nowMs = nowMs;
    let events = 0;
    this.wheel.advanceTo(nowMs, (agent) => {
      if (this.store.nextEvent[agent] > nowMs) {
        // Filed at the wheel's horizon or in the current slot but not due yet.
        this.wheel.schedule(agent, this.store.nextEvent[agent]);
        return;
      }
      this.arrive(agent);
      events++;
    });
    const lateralChanges = this.avoidance ? this.avoid(nowMs) : 0;
    return { events, nearAgents: this.nearCount, lateralChanges };
  }

  /**
   * Hands every dirty agent to `consume` once (e.g. to pack its 24-byte record for upload) and
   * clears the list. Returns how many were drained.
   */
  drainDirty(consume: (agent: number) => void): number {
    const { dirty, store } = this;
    const count = this.dirtyCount;
    for (let i = 0; i < count; i++) {
      const agent = dirty[i];
      store.state[agent] &= ~AgentStateFlag.Dirty;
      consume(agent);
    }
    this.dirtyCount = 0;
    return count;
  }

  /** Position of an agent at `nowMs` by dead reckoning (the same maths the GPU does). */
  positionAt(agent: number, nowMs: number, out: [number, number] = [0, 0]): [number, number] {
    const { store, graph } = this;
    const halfEdge = store.halfEdge[agent];
    const length = graph.edgeLength[halfEdge >>> 1];
    const s = Math.min(
      length,
      store.s0[agent] + (store.speed[agent] * (nowMs - store.t0[agent])) / 1_000_000,
    );
    return pointOnHalfEdge(graph, halfEdge, s, out);
  }

  private arrive(agent: number): void {
    const { store, graph } = this;
    const arrival = store.nextEvent[agent];
    const current = store.halfEdge[agent];
    const node = halfEdgeEnd(graph, current);
    const first = graph.firstHalfEdge[node];
    const degree = graph.firstHalfEdge[node + 1] - first;

    // xorshift32 per agent: deterministic routes regardless of processing order.
    let rng = store.rng[agent];
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    store.rng[agent] = rng >>> 0;
    const r = rng >>> 0;
    const pick = r % degree;
    let next = graph.adjacency[first + pick];
    if (next === (current ^ 1) && degree > 1) {
      // Not back the way we came: one of the other degree − 1 exits, uniformly.
      next = graph.adjacency[first + ((pick + 1 + ((r >>> 8) % (degree - 1))) % degree)];
    }

    const length = graph.edgeLength[next >>> 1];
    // The record is valid from the exact arrival time, so the GPU extrapolates continuously even
    // though the event is processed up to a tick late.
    store.halfEdge[agent] = next;
    store.s0[agent] = 0;
    store.t0[agent] = arrival;
    store.nextEvent[agent] = arrival + Math.ceil((length * 1_000_000) / store.speed[agent]);
    this.wheel.schedule(agent, store.nextEvent[agent]);
    this.updateTier(agent);
    this.markDirty(agent);
  }

  private markDirty(agent: number): void {
    if ((this.store.state[agent] & AgentStateFlag.Dirty) !== 0) return;
    this.store.state[agent] |= AgentStateFlag.Dirty;
    this.dirty[this.dirtyCount++] = agent;
  }

  /** Event-driven tiering: near tier membership changes only when an agent changes edge. */
  private updateTier(agent: number): void {
    const focus = this.focus;
    if (focus === undefined) return;
    const { graph, store } = this;
    const halfEdge = store.halfEdge[agent];
    const mid = pointOnHalfEdge(graph, halfEdge, graph.edgeLength[halfEdge >>> 1] / 2, this.point);
    const near = (mid[0] - focus.x) ** 2 + (mid[1] - focus.z) ** 2 <= focus.radiusSq;
    const local = agent - this.start;
    const index = this.nearIndex[local];
    if (near && index < 0) {
      this.nearIndex[local] = this.nearCount;
      this.nearList[this.nearCount++] = agent;
      store.state[agent] |= AgentStateFlag.Near;
    } else if (!near && index >= 0) {
      const last = this.nearList[--this.nearCount];
      this.nearList[index] = last;
      this.nearIndex[last - this.start] = index;
      this.nearIndex[local] = -1;
      store.state[agent] &= ~AgentStateFlag.Near;
      if (store.lateral[agent] !== 0) {
        store.lateral[agent] = 0;
        this.markDirty(agent);
      }
    }
  }

  /**
   * Per-tick local avoidance for the near tier: hash every near agent into 2 m cells, and nudge
   * each one's lane offset away from neighbours closer than AVOID_RADIUS (or back to the centre
   * when clear). Returns how many lane offsets changed.
   */
  private avoid(nowMs: number): number {
    const { store, graph, nearList, px, pz, dx, dz, next, heads } = this;
    const count = this.nearCount;
    if (count === 0) return 0;
    const mask = heads.length - 1;
    heads.fill(-1);
    const point = this.point;
    for (let k = 0; k < count; k++) {
      const agent = nearList[k];
      this.positionAt(agent, nowMs, point);
      const heading =
        graph.edgeHeading[store.halfEdge[agent] >>> 1] +
        ((store.halfEdge[agent] & 1) === 1 ? Math.PI : 0);
      dx[k] = Math.sin(heading);
      dz[k] = Math.cos(heading);
      // Lane offset: to the right of the walking direction.
      const lateral = store.lateral[agent] * 0.02;
      px[k] = point[0] + dz[k] * lateral;
      pz[k] = point[1] - dx[k] * lateral;
      const cell = cellHash(Math.floor(px[k] / HASH_CELL), Math.floor(pz[k] / HASH_CELL)) & mask;
      next[k] = heads[cell];
      heads[cell] = k;
    }

    let changes = 0;
    const radiusSq = AVOID_RADIUS * AVOID_RADIUS;
    for (let k = 0; k < count; k++) {
      const cx = Math.floor(px[k] / HASH_CELL);
      const cz = Math.floor(pz[k] / HASH_CELL);
      let push = 0;
      for (let ox = -1; ox <= 1; ox++) {
        for (let oz = -1; oz <= 1; oz++) {
          for (let j = heads[cellHash(cx + ox, cz + oz) & mask]; j >= 0; j = next[j]) {
            if (j === k) continue;
            const rx = px[j] - px[k];
            const rz = pz[j] - pz[k];
            if (rx * rx + rz * rz > radiusSq) continue;
            // Neighbour to the left (cross > 0) pushes right, and vice versa.
            push += dx[k] * rz - dz[k] * rx > 0 ? 1 : -1;
          }
        }
      }
      const agent = nearList[k];
      const current = store.lateral[agent];
      let target = current;
      if (push > 0) target = Math.min(LATERAL_LIMIT, current + LATERAL_STEP);
      else if (push < 0) target = Math.max(-LATERAL_LIMIT, current - LATERAL_STEP);
      else if (current !== 0) target = current - Math.sign(current) * LATERAL_STEP;
      if (target !== current) {
        store.lateral[agent] = target;
        this.markDirty(agent);
        changes++;
      }
    }
    return changes;
  }
}

function cellHash(x: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0;
}

function nextPowerOfTwo(n: number): number {
  return 2 ** Math.ceil(Math.log2(n));
}
