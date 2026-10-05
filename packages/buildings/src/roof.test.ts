import { BuildingFlag, EdgeType, NO_BUILDING, NodeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import { describe, expect, it } from 'vitest';
import { appendRoofs } from './append.ts';
import { distanceToRing, type Point, pointInPolygon } from './polygon.ts';
import { ROOF_INSET_M, roofWalk } from './roof.ts';

const rect = (x0: number, y0: number, w: number, h: number): Point[] => [
  [x0, y0],
  [x0 + w, y0],
  [x0 + w, y0 + h],
  [x0, y0 + h],
];

/** Every node and edge midpoint of the walk inside the roof, the inset from its edge. */
function expectInside(ring: Point[], walk: NonNullable<ReturnType<typeof roofWalk>>) {
  const points: Point[] = walk.x.map((x, i) => [x, walk.y[i]]);
  walk.from.forEach((a, e) => {
    const b = walk.to[e];
    points.push([(walk.x[a] + walk.x[b]) / 2, (walk.y[a] + walk.y[b]) / 2]);
  });
  for (const p of points) {
    expect(pointInPolygon(p, ring)).toBe(true);
    expect(distanceToRing(p, ring)).toBeGreaterThan(ROOF_INSET_M * 0.89);
  }
}

/** Every node reachable from node 0, and every node a corner (degree ≥ 2: no dead ends). */
function expectConnectedLoop(walk: NonNullable<ReturnType<typeof roofWalk>>) {
  const n = walk.x.length;
  const degree = new Array<number>(n).fill(0);
  const links: number[][] = Array.from({ length: n }, () => []);
  walk.from.forEach((a, e) => {
    const b = walk.to[e];
    degree[a]++;
    degree[b]++;
    links[a].push(b);
    links[b].push(a);
  });
  expect(Math.min(...degree)).toBeGreaterThanOrEqual(2);
  const seen = new Set([0]);
  const stack = [0];
  while (stack.length > 0)
    for (const m of links[stack.pop() ?? 0]) {
      if (seen.has(m)) continue;
      seen.add(m);
      stack.push(m);
    }
  expect(seen.size).toBe(n);
}

describe('roofWalk', () => {
  it('walks round a rectangle 1.5 m in, with a path across a large roof', () => {
    const ring = rect(0, 0, 40, 20);
    const walk = roofWalk(ring);
    expect(walk).not.toBeNull();
    if (walk === null) return;
    // Four corners, two split points for the path across, and the path itself.
    expect(walk.x).toHaveLength(6);
    expect(walk.from).toHaveLength(7);
    const perimeter = walk.length.slice(0, 6).reduce((a, b) => a + b, 0);
    expect(perimeter).toBeCloseTo(2 * (37 + 17), 3);
    // Across along the long axis: 37 m.
    expect(walk.length[6]).toBeCloseTo(37, 3);
    expectInside(ring, walk);
    expectConnectedLoop(walk);
  });

  it('keeps a small roof to its loop, and handles a clockwise outline', () => {
    const ring = rect(0, 0, 15, 12).reverse();
    const walk = roofWalk(ring);
    expect(walk).not.toBeNull();
    if (walk === null) return;
    expect(walk.from).toHaveLength(4);
    expectInside(ring, walk);
    expectConnectedLoop(walk);
  });

  it('follows an L-shaped roof', () => {
    const ring: Point[] = [
      [0, 0],
      [30, 0],
      [30, 10],
      [10, 10],
      [10, 30],
      [0, 30],
    ];
    const walk = roofWalk(ring);
    expect(walk).not.toBeNull();
    if (walk === null) return;
    expectInside(ring, walk);
    expectConnectedLoop(walk);
  });

  it('gives no walk to a small or thin roof, or one with a thin wing', () => {
    expect(roofWalk(rect(0, 0, 10, 10))).toBeNull();
    // 60 m long but 3.5 m wide: the walk would enclose almost nothing.
    expect(roofWalk(rect(0, 0, 60, 3.5))).toBeNull();
    // A 2 m wide wing: the walk would fold over itself in it.
    const wing: Point[] = [
      [0, 0],
      [30, 0],
      [30, 30],
      [16, 30],
      [16, 45],
      [14, 45],
      [14, 30],
      [0, 30],
    ];
    expect(roofWalk(wing)).toBeNull();
  });

  it('walks round a slot cut into the roof', () => {
    const slot: Point[] = [
      [0, 0],
      [14, 0],
      [14, 20],
      [16, 20],
      [16, 0],
      [30, 0],
      [30, 30],
      [0, 30],
    ];
    const walk = roofWalk(slot);
    expect(walk).not.toBeNull();
    if (walk === null) return;
    expectInside(slot, walk);
    expectConnectedLoop(walk);
  });

  it('ignores repeated and straight-through outline points', () => {
    const ring: Point[] = [
      [0, 0],
      [10, 0],
      [10, 0.1],
      [20, 0],
      [20, 15],
      [0, 15],
      [0, 0.2],
    ];
    const walk = roofWalk(ring);
    expect(walk).not.toBeNull();
    expect(walk?.from).toHaveLength(4);
  });
});

/** A tile with no streets and these buildings (outline, height). */
function buildingsTile(buildings: { ring: Point[]; height: number; flags?: number }[]): NavTile {
  const count = buildings.length;
  const rings = buildings.map((b) => b.ring);
  let offset = 0;
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 256,
    nodes: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      level: new Int8Array(0),
      type: new Uint8Array(0),
      flags: new Uint16Array(0),
      firstHalfEdge: new Uint32Array(1),
      buildingId: new Uint32Array(0),
    },
    edges: {
      from: new Uint32Array(0),
      to: new Uint32Array(0),
      length: new Float32Array(0),
      polyOffset: new Uint32Array(0),
      polyCount: new Uint16Array(0),
      widthCm: new Uint16Array(0),
      type: new Uint8Array(0),
      permissions: new Uint8Array(0),
      levelDelta: new Int8Array(0),
      flags: new Uint8Array(0),
      osmIdLo: new Uint32Array(0),
      osmIdHi: new Uint32Array(0),
    },
    adjacency: new Uint32Array(0),
    portals: noPortals(),
    polylines: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      cumLength: new Float32Array(0),
    },
    buildings: {
      ringOffset: Uint32Array.from(rings, (r) => (offset += r.length) - r.length),
      ringCount: Uint16Array.from(rings, (r) => r.length),
      levels: Int16Array.from(buildings, (b) => Math.round(b.height / 3.5)),
      baseZ: new Float32Array(count),
      height: Float32Array.from(buildings, (b) => b.height),
      type: new Uint8Array(count).fill(2),
      flags: Uint8Array.from(buildings, (b) => b.flags ?? 0),
      capacity: new Uint32Array(count),
      seed: new Uint32Array(count),
      osmIdLo: new Uint32Array(count),
      osmIdHi: new Uint32Array(count),
      ringX: Float32Array.from(rings.flat(), (p) => p[0]),
      ringY: Float32Array.from(rings.flat(), (p) => p[1]),
    },
  };
}

describe('appendRoofs', () => {
  it('appends a walk at roof height for each tall, drawn, uncovered roof', () => {
    const tile = buildingsTile([
      { ring: rect(0, 0, 20, 20), height: 21 },
      // Too low.
      { ring: rect(50, 0, 20, 20), height: 4 },
      // An outline drawn as its parts.
      { ring: rect(100, 0, 20, 20), height: 30, flags: BuildingFlag.HasParts },
      // A podium round a tower: the podium's walk would pass through the tower.
      { ring: rect(0, 50, 40, 40), height: 12 },
      { ring: rect(10, 60, 20, 20), height: 80 },
      // In the zone? Only with no zone.
      { ring: rect(300, 300, 20, 20), height: 21 },
    ]);
    const all = appendRoofs(tile);
    expect(all.roofs).toBe(3);
    const zoned = appendRoofs(tile, { minX: -10, minY: -10, maxX: 200, maxY: 200 });
    expect(zoned.roofs).toBe(2);
    const { nodes, edges } = zoned.tile;
    expect(zoned.firstRoofEdge).toBe(0);
    for (let e = 0; e < edges.from.length; e++) {
      expect(edges.type[e]).toBe(EdgeType.Roof);
      const b = nodes.buildingId[edges.from[e]];
      expect(nodes.buildingId[edges.to[e]]).toBe(b);
      expect([0, 4]).toContain(b);
    }
    for (let n = 0; n < nodes.x.length; n++) {
      expect(nodes.type[n]).toBe(NodeType.Roof);
      expect(nodes.buildingId[n]).not.toBe(NO_BUILDING);
      expect(nodes.z[n]).toBeCloseTo(tile.buildings.height[nodes.buildingId[n]], 1);
    }
    // CSR adjacency: every half-edge listed once, from its own node.
    expect(zoned.tile.adjacency).toHaveLength(edges.from.length * 2);
    for (let n = 0; n < nodes.x.length; n++)
      for (let i = nodes.firstHalfEdge[n]; i < nodes.firstHalfEdge[n + 1]; i++) {
        const h = zoned.tile.adjacency[i];
        expect((h & 1) === 0 ? edges.from[h >>> 1] : edges.to[h >>> 1]).toBe(n);
      }
  });
});
