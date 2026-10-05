import { EdgeType, NO_BUILDING } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import { describe, expect, it } from 'vitest';
import { clearWalls, MIN_WIDTH_CM } from './wall-clearance.ts';

/**
 * Three 40 m paths along x, 300 cm wide: at y = 1 (1 m from a building whose wall runs along
 * y = 0), at y = 30 (far from it), and an entrance link at y = 0.5.
 */
function tile(): NavTile {
  const ys = [1, 1, 30, 30, 0.5, 0.5];
  const xs = [0, 40, 0, 40, 0, 40];
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 256,
    nodes: {
      x: Float32Array.from(xs),
      y: Float32Array.from(ys),
      z: new Float32Array(6),
      level: new Int8Array(6),
      type: new Uint8Array(6),
      flags: new Uint16Array(6),
      firstHalfEdge: new Uint32Array(7),
      buildingId: new Uint32Array(6).fill(NO_BUILDING),
    },
    edges: {
      from: Uint32Array.from([0, 2, 4]),
      to: Uint32Array.from([1, 3, 5]),
      length: Float32Array.from([40, 40, 40]),
      polyOffset: new Uint32Array(3),
      polyCount: new Uint16Array(3),
      widthCm: Uint16Array.from([300, 300, 300]),
      type: Uint8Array.from([EdgeType.Pavement, EdgeType.Pavement, EdgeType.Entrance]),
      permissions: new Uint8Array(3).fill(7),
      levelDelta: new Int8Array(3),
      flags: new Uint8Array(3),
      osmIdLo: new Uint32Array(3),
      osmIdHi: new Uint32Array(3),
    },
    portals: noPortals(),
    adjacency: new Uint32Array(6),
    polylines: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      cumLength: new Float32Array(0),
    },
    buildings: {
      ringOffset: Uint32Array.from([0]),
      ringCount: Uint16Array.from([4]),
      levels: Int16Array.from([3]),
      baseZ: new Float32Array(1),
      height: Float32Array.from([12]),
      type: new Uint8Array(1),
      flags: new Uint8Array(1),
      capacity: new Uint32Array(1),
      seed: new Uint32Array(1),
      osmIdLo: new Uint32Array(1),
      osmIdHi: new Uint32Array(1),
      ringX: Float32Array.from([-10, 50, 50, -10]),
      ringY: Float32Array.from([0, 0, -20, -20]),
    },
  };
}

describe('clearWalls', () => {
  it('narrows a pavement along a wall, and leaves open paths and entrance links', () => {
    const t = tile();
    const qa = clearWalls(t);
    // 1 m of clearance less 0.35 m for the body: 1.3 m wide at most.
    expect(t.edges.widthCm[0]).toBe(130);
    expect(t.edges.widthCm[0]).toBeGreaterThanOrEqual(MIN_WIDTH_CM);
    expect(t.edges.widthCm[1]).toBe(300);
    expect(t.edges.widthCm[2]).toBe(300);
    expect(qa.edgesNarrowed).toBe(1);
  });
});
