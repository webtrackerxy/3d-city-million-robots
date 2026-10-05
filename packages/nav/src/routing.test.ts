import { describe, expect, it } from 'vitest';
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

describe('Router', () => {
  it('matches Dijkstra on random graphs (cost, reachability)', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const { graph, costs } = randomGraph(seed, 120);
      const router = new Router(graph, costs);
      const random = rng(seed * 97);
      for (let q = 0; q < 10; q++) {
        const from = Math.floor(random() * 120);
        const reference = dijkstra(graph, costs, from);
        for (let k = 0; k < 8; k++) {
          const to = Math.floor(random() * 120);
          const route = router.find(from, to);
          if (reference[to] === Infinity) expect(route).toBeNull();
          else {
            expect(route).not.toBeNull();
            expect(route?.cost).toBeCloseTo(reference[to], 3);
          }
        }
      }
    }
  });

  it('returns a walkable chain of half-edges whose costs sum to the route cost', () => {
    const { graph, costs } = randomGraph(7, 150);
    const router = new Router(graph, costs);
    const route = router.find(3, 140) ?? router.find(3, 10);
    expect(route).not.toBeNull();
    if (route === null) return;
    let sum = 0;
    let length = 0;
    route.halfEdges.forEach((half, i) => {
      const e = half >>> 1;
      const start = (half & 1) === 0 ? graph.edgeFrom[e] : graph.edgeTo[e];
      expect(start).toBe(route.nodes[i]);
      expect(costs[e]).not.toBe(Infinity);
      sum += costs[e];
      length += graph.edgeLength[e];
    });
    expect(sum).toBeCloseTo(route.cost, 3);
    expect(route.lengthM).toBeCloseTo(length, 3);
  });

  it('with a cost bound, finds routes within it and gives up on dearer or missing ones', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { graph, costs } = randomGraph(seed, 120);
      const router = new Router(graph, costs);
      const reference = dijkstra(graph, costs, 0);
      for (let to = 1; to < 120; to++) {
        const route = router.find(0, to, 300);
        if (reference[to] <= 300) expect(route?.cost).toBeCloseTo(reference[to], 3);
        else expect(route).toBeNull();
      }
    }
  });

  it('routes a node to itself with an empty path', () => {
    const { graph, costs } = randomGraph(3, 40);
    const route = new Router(graph, costs).find(5, 5);
    expect(route?.halfEdges.length).toBe(0);
    expect(route?.nodes).toEqual(new Uint32Array([5]));
  });
});
