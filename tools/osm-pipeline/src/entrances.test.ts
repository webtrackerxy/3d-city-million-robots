import { BuildingType, EdgeType, NodeFlag } from '@city/core-types';
import { describe, expect, it } from 'vitest';
import type { Building } from './buildings.ts';
import { closeGaps } from './connect.ts';
import { connectEntrances } from './entrances.ts';
import type { Point } from './geometry.ts';
import type { OsmData } from './opl.ts';
import { Barriers, SegmentIndex, WaySet } from './way-set.ts';

const footway = { type: EdgeType.Pavement, permissions: 7, flags: 0, widthCm: 200, level: 0 };

function square(x0: number, y0: number, size: number): Building {
  return {
    osmId: 1,
    isRelation: false,
    ring: [
      [x0, y0],
      [x0 + size, y0],
      [x0 + size, y0 + size],
      [x0, y0 + size],
    ],
    areaM2: size * size,
    levels: 3,
    baseZ: 0,
    height: 10,
    type: BuildingType.Office,
    flags: 0,
    capacity: 30,
    seed: 1,
  };
}

/** OSM data whose node "lon/lat" are local metres (identity projection). */
function osm(nodes: { id: number; at: Point; tags?: Record<string, string> }[]): OsmData {
  return {
    nodes: new Map(
      nodes.map((n) => [n.id, { id: n.id, lon: n.at[0], lat: n.at[1], tags: n.tags ?? {} }]),
    ),
    ways: new Map(),
    relations: new Map(),
  };
}

function network(ways: Point[][]) {
  const set = new WaySet(new Map());
  for (const points of ways)
    set.add({ id: 1, refs: points.map((p) => set.addNode(p)), attributes: footway });
  return set;
}

describe('connectEntrances', () => {
  it('adds a synthetic entrance on the wall facing the network', () => {
    const set = network([
      [
        [-20, 0],
        [30, 0],
      ],
    ]);
    const index = new SegmentIndex(set);
    const { entrances, qa } = connectEntrances(
      set,
      index,
      new Barriers(),
      osm([]),
      [square(0, 10, 10)],
      (x, y) => [x, y],
    );
    expect(qa.synthetic).toBe(1);
    const [[node, entrance]] = [...entrances];
    expect(entrance).toEqual({ building: 0, synthetic: true });
    expect(set.position(node)).toEqual([5, 10]);
    const connector = set.ways.find((w) => w.attributes.type === EdgeType.Entrance);
    expect(connector?.refs[0]).toBe(node);
    expect(set.position(connector?.refs[1] ?? 0)).toEqual([5, 0]);
    expect(NodeFlag.SyntheticEntrance).toBe(1);
  });

  it('connects a mapped entrance, but never through its own building', () => {
    const set = network([
      [
        [-20, 0],
        [30, 0],
      ],
      [
        [-10, -20],
        [-10, 12],
      ],
    ]);
    const index = new SegmentIndex(set);
    const road = new Barriers();
    const data = osm([
      { id: 10, at: [0, 15], tags: { entrance: 'main' } }, // west wall: clear path west
      { id: 11, at: [5, 20], tags: { entrance: 'yes' } }, // north wall: every straight path cuts the building
    ]);
    const { entrances, qa } = connectEntrances(
      set,
      index,
      road,
      data,
      [square(0, 10, 10)],
      (x, y) => [x, y],
    );
    expect(qa.mapped).toBe(2);
    expect(qa.mappedConnected).toBe(1);
    expect(qa.mappedUnreachable).toBe(1);
    expect(entrances.get(10)).toEqual({ building: 0, synthetic: false });
    expect(entrances.has(11)).toBe(false);
    expect(qa.synthetic).toBe(0); // the building already has a mapped entrance
  });
});

describe('closeGaps', () => {
  it('joins a footway that stops short of another, but not across a road', () => {
    const set = network([
      [
        [0, 0],
        [100, 0],
      ],
      [
        [50, 3],
        [50, 40],
      ], // stops 3 m short of the first
      [
        [80, -12],
        [80, -40],
      ], // 12 m away, beyond the reach
      [
        [20, -4],
        [20, -30],
      ], // 4 m away but a road runs between
    ]);
    const barriers = new Barriers();
    barriers.add([0, -2], [100, -2]);
    const qa = closeGaps(set, new SegmentIndex(set), barriers, {
      minX: -100,
      minY: -100,
      maxX: 200,
      maxY: 200,
    });
    expect(qa.connected).toBe(1);
    const connector = set.ways.at(-1);
    expect(connector?.refs.map((r) => set.position(r))).toEqual([
      [50, 3],
      [50, 0],
    ]);
  });
});
