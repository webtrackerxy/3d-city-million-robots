import { EdgeFlag, EdgePermission, EdgeType } from '@city/core-types';
import { describe, expect, it } from 'vitest';
import { classifyWay, parseLevel, parseWidthCm, type PedestrianAttributes } from './pedestrian.ts';
import { buildTopology, simplify } from './topology.ts';

const footway: PedestrianAttributes = {
  type: EdgeType.Pavement,
  permissions: EdgePermission.Human | EdgePermission.Robot | EdgePermission.StepFree,
  flags: 0,
  widthCm: 200,
  level: 0,
};
const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };

describe('classifyWay', () => {
  it('keeps walkable ways with their type, flags and permissions', () => {
    expect(classifyWay({ highway: 'footway', footway: 'sidewalk' })).toMatchObject({
      type: EdgeType.Pavement,
      flags: EdgeFlag.Sidewalk,
    });
    expect(classifyWay({ highway: 'footway', footway: 'crossing' })?.type).toBe(EdgeType.Crossing);
    const steps = classifyWay({ highway: 'steps', level: '-1;0' });
    expect(steps).toMatchObject({
      type: EdgeType.Steps,
      permissions: EdgePermission.Human,
      level: -1,
    });
    expect(classifyWay({ highway: 'footway', bridge: 'yes', width: '3.5' })).toMatchObject({
      flags: EdgeFlag.Bridge,
      widthCm: 350,
    });
    expect(classifyWay({ highway: 'cycleway', foot: 'designated' })?.type).toBe(
      EdgeType.SharedPath,
    );
  });

  it('drops roads, foot=no, private ways and cycleways without foot access', () => {
    expect(classifyWay({ highway: 'primary' })).toBeNull();
    expect(classifyWay({ highway: 'footway', foot: 'no' })).toBeNull();
    expect(classifyWay({ highway: 'footway', access: 'private' })).toBeNull();
    expect(
      classifyWay({ highway: 'footway', access: 'private', foot: 'permissive' }),
    ).not.toBeNull();
    expect(classifyWay({ highway: 'cycleway' })).toBeNull();
  });

  it('parses widths and levels', () => {
    expect(parseWidthCm('2')).toBe(200);
    expect(parseWidthCm('180 cm')).toBe(180);
    expect(parseWidthCm('wide')).toBeUndefined();
    expect(parseLevel('0;1')).toBe(0);
    expect(parseLevel('-2')).toBe(-2);
    expect(parseLevel(undefined)).toBe(0);
  });
});

describe('simplify', () => {
  it('drops points within tolerance and keeps real corners', () => {
    expect(
      simplify(
        [
          [0, 0],
          [5, 0.05],
          [10, 0],
        ],
        0.15,
      ),
    ).toEqual([
      [0, 0],
      [10, 0],
    ]);
    expect(
      simplify(
        [
          [0, 0],
          [5, 3],
          [10, 0],
        ],
        0.15,
      ),
    ).toHaveLength(3);
  });
});

describe('buildTopology', () => {
  const positions = new Map<number, [number, number]>([
    [1, [0, 0]],
    [2, [50, 0]],
    [3, [100, 0]],
    [4, [50, 50]],
    [5, [50.3, -50]], // near-miss: 0.3 m from node 6
    [6, [50, -50]],
    [7, [80, -50]],
    [8, [500, 500]],
    [9, [505, 500]],
    [10, [2000, 0]], // outside the region
  ]);

  it('splits at shared nodes, snaps near-miss ends and drops short components', () => {
    const topology = buildTopology({
      positions,
      bounds,
      ways: [
        { id: 100, refs: [1, 2, 3], attributes: footway }, // crossed by 101 at node 2
        { id: 101, refs: [4, 2, 5], attributes: footway }, // ends 0.3 m from 102's start
        { id: 102, refs: [6, 7], attributes: footway },
        { id: 103, refs: [8, 9], attributes: footway }, // 5 m island: dropped
        { id: 104, refs: [3, 10], attributes: footway }, // leaves the region: clipped away
      ],
    });
    // Edges: 1-2, 2-3, 4-2, 2-(5→6), 6-7 → node 6 has degree 2 but 2-6 and 6-7 join (same attributes).
    expect(topology.qa.snappedEnds).toBe(1);
    expect(topology.qa.droppedComponents).toBe(1);
    expect(topology.edges).toHaveLength(4);
    expect(topology.qa.components).toBe(1);
    expect(topology.qa.largestComponentShare).toBe(1);
    const lengths = topology.edges.map((e) => Math.round(e.length)).sort((a, b) => a - b);
    expect(lengths).toEqual([50, 50, 50, 80]);
  });

  it('contracts a chain of identical ways into one polyline but keeps attribute changes', () => {
    const chain = new Map<number, [number, number]>([
      [1, [0, 0]],
      [2, [20, 0]],
      [3, [40, 5]],
      [4, [60, 0]],
    ]);
    const steps = { ...footway, type: EdgeType.Steps };
    const topology = buildTopology({
      positions: chain,
      bounds,
      ways: [
        { id: 1, refs: [1, 2], attributes: footway },
        { id: 2, refs: [2, 3], attributes: footway },
        { id: 3, refs: [3, 4], attributes: steps },
      ],
    });
    expect(topology.qa.contractedNodes).toBe(1);
    expect(topology.edges).toHaveLength(2);
    const pavement = topology.edges.find((e) => e.attributes.type === EdgeType.Pavement);
    expect(pavement?.points).toHaveLength(3);
    expect(topology.qa.danglingEnds).toBe(2);
  });

  it('records a conflict when a node is shared by ways on different levels', () => {
    const topology = buildTopology({
      positions,
      bounds,
      ways: [
        { id: 1, refs: [1, 2], attributes: footway },
        { id: 2, refs: [2, 3], attributes: { ...footway, level: -1, type: EdgeType.Steps } },
      ],
    });
    expect(topology.qa.levelConflicts).toBe(1);
  });
});
