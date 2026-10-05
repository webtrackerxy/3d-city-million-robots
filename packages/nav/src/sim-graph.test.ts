import { type NavTile, noPortals } from '@city/formats';
import { describe, expect, it } from 'vitest';
import { halfEdgeEnd, halfEdgeStart } from './nav-graph.ts';
import { firstSimHalfEdge, nextSimHalfEdge, simGraphFromTile } from './sim-graph.ts';

/** Two nav edges: 0 → 1 straight (10 m east), 1 → 2 via one bend (north then east). */
function tile(): NavTile {
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 256,
    nodes: {
      x: new Float32Array([0, 10, 20]),
      y: new Float32Array([0, 0, 10]),
      z: new Float32Array(3),
      level: new Int8Array(3),
      type: new Uint8Array(3),
      flags: new Uint16Array(3),
      firstHalfEdge: new Uint32Array([0, 1, 3, 4]),
      buildingId: new Uint32Array(3),
    },
    edges: {
      from: new Uint32Array([0, 1]),
      to: new Uint32Array([1, 2]),
      length: new Float32Array([10, 20]),
      polyOffset: new Uint32Array([0, 0]),
      polyCount: new Uint16Array([0, 1]),
      widthCm: new Uint16Array([200, 200]),
      type: new Uint8Array(2),
      permissions: new Uint8Array(2),
      levelDelta: new Int8Array(2),
      flags: new Uint8Array(2),
      osmIdLo: new Uint32Array(2),
      osmIdHi: new Uint32Array(2),
    },
    portals: noPortals(),
    adjacency: new Uint32Array([0, 1, 2, 3]),
    polylines: {
      x: new Float32Array([10]),
      y: new Float32Array([10]),
      z: new Float32Array(1),
      cumLength: new Float32Array([10]),
    },
    buildings: {
      ringOffset: new Uint32Array(0),
      ringCount: new Uint16Array(0),
      levels: new Int16Array(0),
      baseZ: new Float32Array(0),
      height: new Float32Array(0),
      type: new Uint8Array(0),
      flags: new Uint8Array(0),
      capacity: new Uint32Array(0),
      seed: new Uint32Array(0),
      osmIdLo: new Uint32Array(0),
      osmIdHi: new Uint32Array(0),
      ringX: new Float32Array(0),
      ringY: new Float32Array(0),
    },
  };
}

describe('simGraphFromTile', () => {
  const graph = simGraphFromTile(tile());

  it('keeps nav node ids and appends polyline points as nodes, in Three coordinates', () => {
    expect(graph.navNodeCount).toBe(3);
    expect(graph.nodeCount).toBe(4);
    expect(graph.edgeCount).toBe(3);
    // Interior point (10, 10) → X 10, Z −10.
    expect([graph.nodeX[3], graph.nodeZ[3]]).toEqual([10, -10]);
    expect(Array.from(graph.firstSegment)).toEqual([0, 1, 3]);
  });

  it('gives each segment a heading with 0 = +Z (north is −Z)', () => {
    expect(graph.edgeHeading[0]).toBeCloseTo(Math.PI / 2); // east = +X
    expect(graph.edgeHeading[1]).toBeCloseTo(Math.PI); // north = −Z
    expect(graph.edgeLength[1]).toBeCloseTo(10);
  });

  it('walks a nav half-edge segment by segment in both directions', () => {
    const forward: number[] = [];
    for (let h = firstSimHalfEdge(graph, 1 * 2); h >= 0; h = nextSimHalfEdge(graph, h))
      forward.push(h);
    expect(forward.map((h) => halfEdgeStart(graph, h))).toEqual([1, 3]);
    expect(halfEdgeEnd(graph, forward.at(-1) ?? 0)).toBe(2);

    const backward: number[] = [];
    for (let h = firstSimHalfEdge(graph, 1 * 2 + 1); h >= 0; h = nextSimHalfEdge(graph, h))
      backward.push(h);
    expect(backward.map((h) => halfEdgeStart(graph, h))).toEqual([2, 3]);
    expect(halfEdgeEnd(graph, backward.at(-1) ?? 0)).toBe(1);
  });
});
