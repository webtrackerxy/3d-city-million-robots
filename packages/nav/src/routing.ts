import { EdgeFlag, EdgePermission, EdgeType } from '@city/core-types';
import type { NavTile } from '@city/formats';

/**
 * Stage 1 routing (implementation plan §11): A* over the CSR half-edge graph with per-profile
 * edge costs. Costs are metres-equivalent and never below edge length, so straight-line distance
 * is an admissible heuristic. Scratch arrays are reused across queries (epoch-stamped), so a
 * query allocates only its result.
 */
export interface RoutingGraph {
  nodeX: Float32Array;
  nodeY: Float32Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeLength: Float32Array;
  firstHalfEdge: Uint32Array;
  adjacency: Uint32Array;
}

export function routingGraphFromTile(tile: NavTile): RoutingGraph {
  return {
    nodeX: tile.nodes.x,
    nodeY: tile.nodes.y,
    edgeFrom: tile.edges.from,
    edgeTo: tile.edges.to,
    edgeLength: tile.edges.length,
    firstHalfEdge: tile.nodes.firstHalfEdge,
    adjacency: tile.adjacency,
  };
}

export interface RouteProfile {
  /** EdgePermission bits every edge on the route must carry. */
  requires: number;
  /** Cost multiplier per edge type (≥ 1; missing = 1). */
  typeFactor: Partial<Record<EdgeType, number>>;
  /** Fixed extra cost, in metres, for crossing a road (waiting, looking). */
  crossingPenaltyM: number;
  /** Extra cost for an implicit crossing (no mapped crossing at that junction arm). */
  implicitCrossingPenaltyM: number;
}

export const PEDESTRIAN: RouteProfile = {
  requires: EdgePermission.Human,
  typeFactor: { [EdgeType.Steps]: 1.4 },
  crossingPenaltyM: 8,
  implicitCrossingPenaltyM: 25,
};

/** Robots: no steps (the Robot bit is absent on them), a strong preference for mapped crossings. */
export const ROBOT: RouteProfile = {
  requires: EdgePermission.Robot | EdgePermission.StepFree,
  typeFactor: {},
  crossingPenaltyM: 10,
  implicitCrossingPenaltyM: 80,
};

/** Per-edge cost for a profile; Infinity marks an edge the profile may not use. */
export function edgeCosts(tile: NavTile, profile: RouteProfile): Float32Array {
  const { edges } = tile;
  const costs = new Float32Array(edges.from.length);
  for (let e = 0; e < costs.length; e++) {
    // Roof walks are islands for the agents up there, never a way between two places.
    if (
      (edges.permissions[e] & profile.requires) !== profile.requires ||
      edges.type[e] === EdgeType.Roof
    ) {
      costs[e] = Infinity;
      continue;
    }
    const type = edges.type[e] as EdgeType;
    let cost = edges.length[e] * Math.max(1, profile.typeFactor[type] ?? 1);
    if (type === EdgeType.Crossing) {
      cost += profile.crossingPenaltyM;
      if ((edges.flags[e] & EdgeFlag.Implicit) !== 0) cost += profile.implicitCrossingPenaltyM;
    }
    costs[e] = cost;
  }
  return costs;
}

export interface Route {
  /** Half-edges walked in order (edge · 2 + direction). */
  halfEdges: Uint32Array;
  /** Nodes visited, from origin to destination (halfEdges.length + 1 entries). */
  nodes: Uint32Array;
  lengthM: number;
  cost: number;
  /** Nodes settled by the search: the work it did. */
  expanded: number;
}

export class Router {
  private readonly graph: RoutingGraph;
  private readonly costs: Float32Array;
  private readonly g: Float64Array;
  private readonly via: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private epoch = 0;
  private heapNode = new Uint32Array(1024);
  private heapKey = new Float64Array(1024);
  private heapSize = 0;

  constructor(graph: RoutingGraph, costs: Float32Array) {
    this.graph = graph;
    this.costs = costs;
    const n = graph.firstHalfEdge.length - 1;
    this.g = new Float64Array(n);
    this.via = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
  }

  /**
   * Cheapest route from `from` to `to`, or null when they are not connected for this profile —
   * or, with `maxCost`, when the route would cost more (the search then stops early instead of
   * exploring everything reachable, which on a city graph is a million nodes).
   */
  find(from: number, to: number, maxCost = Infinity): Route | null {
    const { nodeX, nodeY, edgeFrom, edgeTo, firstHalfEdge, adjacency } = this.graph;
    const epoch = ++this.epoch;
    const tx = nodeX[to];
    const ty = nodeY[to];
    const h = (n: number) => Math.hypot(nodeX[n] - tx, nodeY[n] - ty);
    this.heapSize = 0;
    this.seen[from] = epoch;
    this.g[from] = 0;
    this.via[from] = -1;
    this.push(from, h(from));
    let expanded = 0;
    while (this.heapSize > 0) {
      const node = this.pop();
      if (this.closed[node] === epoch) continue;
      // Lowest f = g + h is a lower bound on any route still to be found.
      if (this.g[node] + h(node) > maxCost) return null;
      this.closed[node] = epoch;
      expanded++;
      if (node === to) return this.build(from, to, expanded);
      const base = this.g[node];
      for (let i = firstHalfEdge[node]; i < firstHalfEdge[node + 1]; i++) {
        const half = adjacency[i];
        const edge = half >>> 1;
        const cost = this.costs[edge];
        if (cost === Infinity) continue;
        const next = (half & 1) === 0 ? edgeTo[edge] : edgeFrom[edge];
        if (this.closed[next] === epoch) continue;
        const candidate = base + cost;
        if (this.seen[next] !== epoch || candidate < this.g[next]) {
          this.seen[next] = epoch;
          this.g[next] = candidate;
          this.via[next] = half;
          this.push(next, candidate + h(next));
        }
      }
    }
    return null;
  }

  private build(from: number, to: number, expanded: number): Route {
    const { edgeFrom, edgeTo, edgeLength } = this.graph;
    const halves: number[] = [];
    for (let node = to; node !== from;) {
      const half = this.via[node];
      halves.push(half);
      const edge = half >>> 1;
      node = (half & 1) === 0 ? edgeFrom[edge] : edgeTo[edge];
    }
    halves.reverse();
    const nodes = new Uint32Array(halves.length + 1);
    nodes[0] = from;
    let lengthM = 0;
    halves.forEach((half, i) => {
      const edge = half >>> 1;
      nodes[i + 1] = (half & 1) === 0 ? edgeTo[edge] : edgeFrom[edge];
      lengthM += edgeLength[edge];
    });
    return { halfEdges: Uint32Array.from(halves), nodes, lengthM, cost: this.g[to], expanded };
  }

  // Binary min-heap on (key, node) with lazy deletion.
  private push(node: number, key: number): void {
    if (this.heapSize === this.heapNode.length) {
      const nodes = new Uint32Array(this.heapSize * 2);
      const keys = new Float64Array(this.heapSize * 2);
      nodes.set(this.heapNode);
      keys.set(this.heapKey);
      this.heapNode = nodes;
      this.heapKey = keys;
    }
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heapKey[parent] <= key) break;
      this.heapNode[i] = this.heapNode[parent];
      this.heapKey[i] = this.heapKey[parent];
      i = parent;
    }
    this.heapNode[i] = node;
    this.heapKey[i] = key;
  }

  private pop(): number {
    const top = this.heapNode[0];
    const size = --this.heapSize;
    const node = this.heapNode[size];
    const key = this.heapKey[size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && this.heapKey[child + 1] < this.heapKey[child]) child++;
      if (this.heapKey[child] >= key) break;
      this.heapNode[i] = this.heapNode[child];
      this.heapKey[i] = this.heapKey[child];
      i = child;
    }
    this.heapNode[i] = node;
    this.heapKey[i] = key;
    return top;
  }
}
