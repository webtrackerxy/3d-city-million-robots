import { BuildingFlag, EdgeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import { describe, expect, it } from 'vitest';
import { buildingGeometry } from './buildings-geometry.ts';
import { components, networkGeometry } from './network-geometry.ts';
import { ribbon, routePolyline } from './route-geometry.ts';

function tile(): NavTile {
  const u32 = (...v: number[]) => new Uint32Array(v);
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 512,
    nodes: {
      x: new Float32Array([0, 10, 20, 100, 110]),
      y: new Float32Array([0, 0, 0, 0, 0]),
      z: new Float32Array(5),
      level: new Int8Array([0, 0, -1, 0, 0]),
      type: new Uint8Array(5),
      flags: new Uint16Array(5),
      firstHalfEdge: u32(0, 1, 3, 4, 5, 6),
      buildingId: new Uint32Array(5).fill(0xffffffff),
    },
    edges: {
      from: u32(0, 1, 3),
      to: u32(1, 2, 4),
      length: new Float32Array([10, 10, 10]),
      polyOffset: u32(0, 1, 1),
      polyCount: new Uint16Array([1, 0, 0]),
      widthCm: new Uint16Array([200, 200, 200]),
      type: new Uint8Array([EdgeType.Pavement, EdgeType.Steps, EdgeType.Crossing]),
      permissions: new Uint8Array(3),
      levelDelta: new Int8Array(3),
      flags: new Uint8Array(3),
      osmIdLo: u32(0, 0, 0),
      osmIdHi: u32(0, 0, 0),
    },
    portals: noPortals(),
    adjacency: u32(0, 1, 2, 3, 4, 5),
    polylines: {
      x: new Float32Array([5]),
      y: new Float32Array([1]),
      z: new Float32Array(1),
      cumLength: new Float32Array([5]),
    },
    buildings: {
      ringOffset: u32(0, 4),
      ringCount: new Uint16Array([4, 4]),
      levels: new Int16Array([10, 1]),
      baseZ: new Float32Array([0, 0]),
      height: new Float32Array([30, 3]),
      type: new Uint8Array([2, 1]),
      flags: new Uint8Array([0, BuildingFlag.HasParts]),
      capacity: u32(0, 0),
      seed: u32(0, 0),
      osmIdLo: u32(0, 0),
      osmIdHi: u32(0, 0),
      ringX: new Float32Array([0, 10, 10, 0, 50, 60, 60, 50]),
      ringY: new Float32Array([0, 0, 10, 10, 0, 0, 10, 10]),
    },
  };
}

describe('buildingGeometry', () => {
  it('extrudes walls and a roof, skipping outlines that have parts', () => {
    const mesh = buildingGeometry(tile().buildings);
    expect(mesh.drawn).toBe(1);
    expect(mesh.positions.length / 3).toBe(4 * 4 + 4);
    expect(mesh.indices.length / 3).toBe(4 * 2 + 2);
    // Roof vertices sit at the building height (Three Y).
    const ys = Array.from(
      { length: mesh.positions.length / 3 },
      (_, i) => mesh.positions[i * 3 + 1],
    );
    expect(Math.max(...ys)).toBe(30);
    // The first wall runs along y = 0 (south face): its normal points south, i.e. +Z in Three.
    expect(Array.from(mesh.normals.subarray(0, 3))).toEqual([0, 0, 1]);
    expect(mesh.indices.every((i) => i < mesh.positions.length / 3)).toBe(true);
  });
});

describe('networkGeometry', () => {
  it('draws one segment per polyline piece and can hide other levels', () => {
    const all = networkGeometry(tile(), { colouring: 'type', showOtherLevels: true });
    expect(all.segments).toBe(2 + 1 + 1);
    const ground = networkGeometry(tile(), { colouring: 'type', showOtherLevels: false });
    expect(ground.segments).toBe(2 + 1); // the steps edge touches level −1
    [0, 0.3, 0, 5, 0.3, -1].forEach((value, i) => {
      expect(all.positions[i]).toBeCloseTo(value, 5);
    });
  });

  it('finds connected components', () => {
    const { edgeComponent, count } = components(tile());
    expect(count).toBe(2);
    expect(edgeComponent[0]).toBe(edgeComponent[1]);
    expect(edgeComponent[2]).not.toBe(edgeComponent[0]);
  });
});

describe('route geometry', () => {
  it('walks each half-edge in its direction, sharing joints', () => {
    // Edge 0 is 0 → 1; walking it backwards (half-edge 1) starts at node 1.
    const points = routePolyline(tile(), new Uint32Array([1]));
    // x, y and height (the fixture is flat).
    expect(points[0]).toEqual([10, 0, 0]);
    expect(points.at(-1)).toEqual([0, 0, 0]);
    const strip = ribbon(points, 2, 0.5);
    expect(strip.positions.length).toBe(points.length * 6);
    expect(strip.indices.length).toBe((points.length - 1) * 6);
    // The two edge vertices at each point are the ribbon width apart, lifted, centred on it.
    const [ax, ay, az, bx, , bz] = strip.positions;
    expect(Math.hypot(bx - ax, bz - az)).toBeCloseTo(2, 5);
    expect(ay).toBeCloseTo(0.5, 5);
    expect((ax + bx) / 2).toBeCloseTo(10, 5);
    expect((az + bz) / 2).toBeCloseTo(0, 5);
  });
});
