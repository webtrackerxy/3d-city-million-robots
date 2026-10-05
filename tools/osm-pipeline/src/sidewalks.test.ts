import { EdgeFlag, EdgePermission, EdgeType } from '@city/core-types';
import { describe, expect, it } from 'vitest';
import { distance, type Point, projectOnSegment } from './geometry.ts';
import type { Tags } from './opl.ts';
import { inferSidewalks, type RoadWay, sidewalkSides } from './sidewalks.ts';
import { WaySet } from './way-set.ts';

/** Builds a fixture: named points → node ids 1…n, roads as lists of point names. */
function fixture(
  points: Record<string, Point>,
  roads: { refs: string[]; tags: Tags }[],
  nodeTags: Record<string, Tags> = {},
) {
  const ids = new Map(Object.keys(points).map((name, i) => [name, i + 1]));
  const positions = new Map<number, Point>();
  for (const [name, p] of Object.entries(points)) positions.set(ids.get(name) ?? 0, p);
  const set = new WaySet(positions);
  const roadWays: RoadWay[] = roads.map((road, i) => ({
    id: 100 + i,
    refs: road.refs.map((name) => ids.get(name) ?? 0),
    tags: road.tags,
  }));
  const tags = new Map(Object.entries(nodeTags).map(([name, t]) => [ids.get(name) ?? 0, t]));
  return { set, roadWays, tags, ids };
}

const residential: Tags = { highway: 'residential' };
const inferred = (set: WaySet, type: EdgeType = EdgeType.Pavement) =>
  set.ways.filter(
    (w) => w.attributes.type === type && (w.attributes.flags & EdgeFlag.Inferred) !== 0,
  );
const implicit = (set: WaySet) =>
  set.ways.filter((w) => (w.attributes.flags & EdgeFlag.Implicit) !== 0);

/** Number of connected components over all ways in the set. */
function components(set: WaySet): number {
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r) ?? r;
    parent.set(a, r);
    return r;
  };
  for (const way of set.ways)
    for (const ref of way.refs) {
      if (!parent.has(ref)) parent.set(ref, ref);
      parent.set(find(ref), find(way.refs[0]));
    }
  return new Set([...parent.keys()].map(find)).size;
}

describe('sidewalkSides', () => {
  it('reads the sidewalk tag schemes', () => {
    expect(sidewalkSides({})).toEqual({ left: 'default', right: 'default' });
    expect(sidewalkSides({ sidewalk: 'both' })).toEqual({ left: 'yes', right: 'yes' });
    expect(sidewalkSides({ sidewalk: 'right' })).toEqual({ left: 'no', right: 'yes' });
    expect(sidewalkSides({ sidewalk: 'separate' })).toEqual({
      left: 'separate',
      right: 'separate',
    });
    expect(sidewalkSides({ 'sidewalk:both': 'no' })).toEqual({ left: 'no', right: 'no' });
    expect(sidewalkSides({ 'sidewalk:left': 'separate', 'sidewalk:right': 'yes' })).toEqual({
      left: 'separate',
      right: 'yes',
    });
  });
});

describe('inferSidewalks', () => {
  it('offsets an isolated street to both kerbs and caps the dead ends', () => {
    const { set, roadWays, tags } = fixture({ a: [0, 0], b: [100, 0] }, [
      { refs: ['a', 'b'], tags: residential },
    ]);
    const qa = inferSidewalks(set, roadWays, tags);
    // residential: 6 m carriageway → sidewalk centre 3 + 1 = 4 m off the centreline.
    const ys = new Set(
      inferred(set).flatMap((w) => w.refs.map((r) => Math.round(set.position(r)[1]))),
    );
    expect(ys).toEqual(new Set([4, -4]));
    expect(qa.cappedEnds).toBe(2);
    expect(qa.inferredLengthM).toBeCloseTo(2 * 100 + 2 * 8, 3);
    expect(components(set)).toBe(1);
    expect(set.ways.every((w) => (w.attributes.permissions & EdgePermission.Robot) !== 0)).toBe(
      true,
    );
  });

  it('forms corners and implicit crossings at a crossroads', () => {
    const { set, roadWays, tags, ids } = fixture(
      { w: [-50, 0], e: [50, 0], s: [0, -50], n: [0, 50], j: [0, 0] },
      [
        { refs: ['w', 'j', 'e'], tags: residential },
        { refs: ['s', 'j', 'n'], tags: residential },
      ],
    );
    const qa = inferSidewalks(set, roadWays, tags);
    expect(qa.corners).toBe(4);
    const crossings = implicit(set);
    expect(crossings).toHaveLength(4);
    for (const c of crossings) {
      expect(c.attributes.type).toBe(EdgeType.Crossing);
      const [a, b] = c.refs.map((r) => set.position(r));
      expect(distance(a, b)).toBeCloseTo(8, 5);
      for (const p of [a, b])
        expect(Math.abs(Math.abs(p[0]) - 4) + Math.abs(Math.abs(p[1]) - 4)).toBeLessThan(1e-6);
    }
    expect(components(set)).toBe(1);
    // No sidewalk touches the road centreline junction.
    expect(set.ways.some((w) => w.refs.includes(ids.get('j') ?? 0))).toBe(false);
  });

  it('joins a T-junction and replaces an implicit crossing with a mapped one nearby', () => {
    const { set, roadWays, tags, ids } = fixture(
      { w: [-50, 0], x: [10, 0], e: [50, 0], s: [0, -50], j: [0, 0] },
      [
        { refs: ['w', 'j', 'x', 'e'], tags: residential },
        { refs: ['j', 's'], tags: residential },
      ],
      { x: { highway: 'crossing', crossing: 'traffic_signals' } },
    );
    const qa = inferSidewalks(set, roadWays, tags);
    expect(qa.mappedCrossings).toBe(1);
    expect(qa.implicitCrossings).toBe(2); // the east arm has the mapped one within 20 m
    const mapped = inferred(set, EdgeType.Crossing).filter(
      (w) => (w.attributes.flags & EdgeFlag.Implicit) === 0,
    );
    expect(mapped).toHaveLength(2);
    for (const half of mapped) expect(half.refs).toContain(ids.get('x'));
    expect(components(set)).toBe(1);
  });

  it('keeps a curved kerb at a constant offset', () => {
    const points: Record<string, Point> = {};
    const names: string[] = [];
    for (let k = 0; k <= 12; k++) {
      const angle = (k / 12) * (Math.PI / 2);
      names.push(`p${k}`);
      points[`p${k}`] = [60 * Math.cos(angle), 60 * Math.sin(angle)];
    }
    const { set, roadWays, tags } = fixture(points, [{ refs: names, tags: residential }]);
    inferSidewalks(set, roadWays, tags);
    const centre = names.map((n) => points[n]);
    for (const way of inferred(set)) {
      if (way.refs.length < 3) continue; // the caps
      for (const ref of way.refs.slice(1, -1)) {
        const p = set.position(ref);
        let d = Infinity;
        for (let i = 0; i + 1 < centre.length; i++)
          d = Math.min(d, projectOnSegment(p, centre[i], centre[i + 1]).distance);
        expect(d).toBeGreaterThan(3.7);
        expect(d).toBeLessThan(4.3);
      }
    }
  });

  it('infers nothing for dual carriageways, trunk roads or separately mapped sidewalks', () => {
    const { set, roadWays, tags } = fixture(
      { a: [0, 0], b: [100, 0], c: [0, 20], d: [100, 20], e: [0, 40], f: [100, 40] },
      [
        { refs: ['a', 'b'], tags: { highway: 'primary', oneway: 'yes', dual_carriageway: 'yes' } },
        { refs: ['c', 'd'], tags: { highway: 'trunk' } },
        { refs: ['e', 'f'], tags: { highway: 'residential', sidewalk: 'separate' } },
      ],
    );
    const qa = inferSidewalks(set, roadWays, tags);
    expect(qa.inferredLengthM).toBe(0);
    expect(set.ways).toHaveLength(0);
  });

  it('suppresses the side that duplicates a mapped footway', () => {
    const { set, roadWays, tags, ids } = fixture(
      { a: [0, 0], b: [100, 0], m1: [-5, 4.5], m2: [105, 4.5] },
      [{ refs: ['a', 'b'], tags: residential }],
    );
    set.add({
      id: 1,
      refs: [ids.get('m1') ?? 0, ids.get('m2') ?? 0],
      attributes: {
        type: EdgeType.Pavement,
        permissions: 7,
        flags: EdgeFlag.Sidewalk,
        widthCm: 200,
        level: 0,
      },
    });
    const qa = inferSidewalks(set, roadWays, tags);
    expect(qa.explicitSidewalkLengthM).toBeCloseTo(110, 3);
    expect(qa.suppressedLengthM).toBeGreaterThan(95);
    const northSide = inferred(set).some((w) =>
      w.refs.some(
        (r) => set.position(r)[1] > 0 && set.position(r)[0] > 10 && set.position(r)[0] < 90,
      ),
    );
    expect(northSide).toBe(false);
    const southSide = inferred(set).some((w) => w.refs.some((r) => set.position(r)[1] < -3));
    expect(southSide).toBe(true);
  });
});
