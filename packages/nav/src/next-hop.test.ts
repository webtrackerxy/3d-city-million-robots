import { describe, expect, it } from 'vitest';
import { NextHopTables } from './next-hop.ts';
import { Router, type RoutingGraph } from './routing.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random geometric graph: points in a square, edges to near neighbours, lengths ≥ straight line. */
function randomGraph(seed: number, n: number): { graph: RoutingGraph; costs: Float32Array } {
  const random = rng(seed);
  const x = Float32Array.from({ length: n }, () => random() * 500);
  const y = Float32Array.from({ length: n }, () => random() * 500);
  const from: number[] = [];
  const to: number[] = [];
  const length: number[] = [];
  const costs: number[] = [];
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++) {
      const d = Math.hypot(x[a] - x[b], y[a] - y[b]);
      if (d > 90 || random() < 0.4) continue;
      from.push(a);
      to.push(b);
      const l = d * (1 + random() * 0.3);
      length.push(l);
      costs.push(random() < 0.05 ? Infinity : l * (1 + random()));
    }
  const degree = new Uint32Array(n + 1);
  from.forEach((a, e) => {
    degree[a + 1]++;
    degree[to[e] + 1]++;
  });
  const first = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) first[i + 1] = first[i] + degree[i + 1];
  const cursor = first.slice(0, n);
  const adjacency = new Uint32Array(from.length * 2);
  from.forEach((a, e) => {
    adjacency[cursor[a]++] = e * 2;
    adjacency[cursor[to[e]]++] = e * 2 + 1;
  });
  return {
    graph: {
      nodeX: x,
      nodeY: y,
      edgeFrom: Uint32Array.from(from),
      edgeTo: Uint32Array.from(to),
      edgeLength: Float32Array.from(length),
      firstHalfEdge: first,
      adjacency,
    },
    costs: Float32Array.from(costs),
  };
}

/** O(n²) Dijkstra reference. */
function dijkstra(graph: RoutingGraph, costs: Float32Array, from: number): Float64Array {
  const n = graph.firstHalfEdge.length - 1;
  const dist = new Float64Array(n).fill(Infinity);
  const done = new Uint8Array(n);
  dist[from] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < n; i++)
      if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return dist;
    done[u] = 1;
    for (let k = graph.firstHalfEdge[u]; k < graph.firstHalfEdge[u + 1]; k++) {
      const half = graph.adjacency[k];
      const e = half >>> 1;
      const v = (half & 1) === 0 ? graph.edgeTo[e] : graph.edgeFrom[e];
      if (dist[u] + costs[e] < dist[v]) dist[v] = dist[u] + costs[e];
    }
  }
}

describe('NextHopTables', () => {
  it('following next hops reaches the destination at the optimal cost (vs Dijkstra)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const { graph, costs } = randomGraph(seed, 120);
      const tables = new NextHopTables(graph, costs);
      const random = rng(seed * 31);
      for (let q = 0; q < 6; q++) {
        const dest = Math.floor(random() * 120);
        const reference = dijkstra(graph, costs, dest);
        for (let from = 0; from < 120; from++) {
          if (reference[from] === Infinity) {
            expect(tables.reachable(from, dest)).toBe(false);
            continue;
          }
          let node = from;
          let cost = 0;
          for (let steps = 0; node !== dest; steps++) {
            expect(steps).toBeLessThan(120);
            const half = tables.next(node, dest);
            expect(half).toBeGreaterThanOrEqual(0);
            const e = half >>> 1;
            const start = (half & 1) === 0 ? graph.edgeFrom[e] : graph.edgeTo[e];
            expect(start).toBe(node);
            cost += costs[e];
            node = (half & 1) === 0 ? graph.edgeTo[e] : graph.edgeFrom[e];
          }
          expect(cost).toBeCloseTo(reference[from], 3);
        }
      }
    }
  });

  it('agrees with A* on route cost, and builds each table once', () => {
    const { graph, costs } = randomGraph(5, 150);
    const tables = new NextHopTables(graph, costs, 2);
    const router = new Router(graph, costs);
    const route = router.find(10, 140);
    if (route === null) return;
    let node = 10;
    let cost = 0;
    while (node !== 140) {
      const half = tables.next(node, 140);
      const e = half >>> 1;
      cost += costs[e];
      node = (half & 1) === 0 ? graph.edgeTo[e] : graph.edgeFrom[e];
    }
    expect(cost).toBeCloseTo(route.cost, 3);
    expect(tables.builds).toBe(1);
    tables.next(0, 1);
    tables.next(0, 2);
    tables.next(0, 140); // evicted by the LRU (2 tables), rebuilt
    expect(tables.builds).toBe(4);
    expect(tables.size).toBe(2);
  });

  it('leads to the nearest of a destination set (clusters)', () => {
    const { graph, costs } = randomGraph(9, 120);
    const tables = new NextHopTables(graph, costs);
    const sources = [3, 40, 77];
    const refs = sources.map((d) => dijkstra(graph, costs, d));
    for (let from = 0; from < 120; from++) {
      const best = Math.min(...refs.map((r) => r[from]));
      if (best === Infinity) {
        expect(tables.reachableTo(from, 1_000_000, sources)).toBe(false);
        continue;
      }
      let node = from;
      let cost = 0;
      for (let steps = 0; !sources.includes(node); steps++) {
        expect(steps).toBeLessThan(120);
        const half = tables.nextTo(node, 1_000_000, sources);
        const e = half >>> 1;
        cost += costs[e];
        node = (half & 1) === 0 ? graph.edgeTo[e] : graph.edgeFrom[e];
      }
      expect(cost).toBeCloseTo(best, 3);
    }
    expect(tables.builds).toBe(1);
  });

  it('bounded tables match unbounded ones within the radius and hold nothing beyond', () => {
    const { graph, costs } = randomGraph(9, 300);
    const full = new NextHopTables(graph, costs);
    const bounded = new NextHopTables(graph, costs, 4096, 400, 4096);
    const router = new Router(graph, costs);
    for (const dest of [3, 77, 150, 299]) {
      let inside = 0;
      for (let node = 0; node < 300; node++) {
        if (node === dest) continue;
        const route = router.find(node, dest);
        const hop = bounded.next(node, dest);
        if (route === null || route.cost > 400) {
          expect(hop).toBe(-1);
          continue;
        }
        inside++;
        expect(hop).toBe(full.next(node, dest));
      }
      expect(inside).toBeGreaterThan(10);
    }
    // 4 kB budget: older tables are evicted, the newest kept.
    expect(bounded.bytes).toBeLessThanOrEqual(4096);
    expect(bounded.size).toBeGreaterThanOrEqual(1);
  });
});
