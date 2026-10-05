import { describe, expect, it } from 'vitest';
import { createGridGraph, gridForAgents } from './grid-graph.ts';
import {
  halfEdgeEnd,
  halfEdgeStart,
  packGpuEdges,
  pointOnHalfEdge,
  reverseHalfEdge,
} from './nav-graph.ts';

describe('createGridGraph', () => {
  const graph = createGridGraph(4, 3, 30);

  it('has the expected node and edge counts, centred on the origin', () => {
    expect(graph.nodeCount).toBe(12);
    expect(graph.edgeCount).toBe(3 * 3 + 4 * 2);
    expect(graph.nodeX[0]).toBe(-45);
    expect(graph.nodeZ[11]).toBe(30);
  });

  it('lists every half-edge leaving each node exactly once', () => {
    const seen = new Set<number>();
    for (let n = 0; n < graph.nodeCount; n++) {
      for (let i = graph.firstHalfEdge[n]; i < graph.firstHalfEdge[n + 1]; i++) {
        const h = graph.adjacency[i];
        expect(halfEdgeStart(graph, h)).toBe(n);
        seen.add(h);
      }
    }
    expect(seen.size).toBe(graph.edgeCount * 2);
    // Corner nodes have 2 exits, interior nodes 4.
    expect(graph.firstHalfEdge[1] - graph.firstHalfEdge[0]).toBe(2);
    expect(graph.firstHalfEdge[6] - graph.firstHalfEdge[5]).toBe(4);
  });

  it('walks half-edges in both directions consistently', () => {
    for (let h = 0; h < graph.edgeCount * 2; h++) {
      const start = pointOnHalfEdge(graph, h, 0);
      const end = pointOnHalfEdge(graph, h, graph.edgeLength[h >>> 1]);
      expect(start[0]).toBeCloseTo(graph.nodeX[halfEdgeStart(graph, h)], 4);
      expect(start[1]).toBeCloseTo(graph.nodeZ[halfEdgeStart(graph, h)], 4);
      expect(end[0]).toBeCloseTo(graph.nodeX[halfEdgeEnd(graph, h)], 4);
      expect(end[1]).toBeCloseTo(graph.nodeZ[halfEdgeEnd(graph, h)], 4);
      expect(halfEdgeEnd(graph, reverseHalfEdge(h))).toBe(halfEdgeStart(graph, h));
    }
  });

  it('packs GPU edges as (x0, z0, heading, length)', () => {
    const packed = packGpuEdges(graph);
    expect(packed.length).toBe(graph.edgeCount * 4);
    expect([...packed.subarray(0, 4)]).toEqual([-45, -30, Math.fround(Math.PI / 2), 30]);
  });

  it('sizes grids for an agent count', () => {
    const { columns, rows } = gridForAgents(1_000_000, 4.5);
    const edges = (columns - 1) * rows + columns * (rows - 1);
    expect(edges).toBeGreaterThan(1_000_000 / 4.5);
    expect(edges).toBeLessThan((1_000_000 / 4.5) * 1.1);
  });
});
