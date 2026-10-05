import { EdgeFlag, EdgePermission, type EdgeType } from '@city/core-types';
import { GridIndex, type Point, projectOnSegment, segmentsCross } from './geometry.ts';
import type { PedestrianAttributes } from './pedestrian.ts';

/**
 * The pedestrian network before topology cleanup (stage 4): mapped OSM ways plus everything the
 * pipeline generates (inferred sidewalks, crossings, connectors). Generated nodes get negative
 * ids so they cannot collide with OSM node ids.
 */
export interface PedWay {
  /** Source OSM way (the road for inferred sidewalks), 0 for connectors. */
  id: number;
  refs: number[];
  attributes: PedestrianAttributes;
}

export class WaySet {
  readonly ways: PedWay[] = [];
  private nextNodeId = -1;

  readonly positions: Map<number, Point>;

  constructor(positions: Map<number, Point>) {
    this.positions = positions;
  }

  addNode(p: Point): number {
    const id = this.nextNodeId--;
    this.positions.set(id, p);
    return id;
  }

  position(id: number): Point {
    const p = this.positions.get(id);
    if (p === undefined) throw new Error(`No position for node ${id}`);
    return p;
  }

  add(way: PedWay): void {
    if (way.refs.length >= 2) this.ways.push(way);
  }

  /** Number of way ends and interior uses per node (end = 1, interior = 2, as graph degree). */
  degrees(): Map<number, number> {
    const d = new Map<number, number>();
    for (const way of this.ways) {
      way.refs.forEach((ref, i) => {
        const end = i === 0 || i === way.refs.length - 1;
        d.set(ref, (d.get(ref) ?? 0) + (end ? 1 : 2));
      });
    }
    return d;
  }
}

/** Generated edge attributes: open to everyone, flat, flagged Inferred. */
export function inferredAttributes(
  type: EdgeType,
  widthCm: number,
  extraFlags = 0,
  level = 0,
): PedestrianAttributes {
  return {
    type,
    permissions: EdgePermission.Human | EdgePermission.Robot | EdgePermission.StepFree,
    flags: EdgeFlag.Inferred | extraFlags,
    widthCm,
    level,
  };
}

interface SegmentEntry {
  way: PedWay;
  a: number;
  b: number;
  alive: boolean;
}

export interface NearestSegment {
  entry: SegmentEntry;
  point: Point;
  t: number;
  distance: number;
}

/**
 * Spatial index over way segments that supports splitting a segment in place, so connectors can
 * attach to the middle of an edge.
 */
export class SegmentIndex {
  private readonly grid = new GridIndex<SegmentEntry>(16);

  private readonly set: WaySet;

  constructor(set: WaySet) {
    this.set = set;
    for (const way of set.ways) this.addWay(way);
  }

  addWay(way: PedWay): void {
    for (let i = 0; i + 1 < way.refs.length; i++) this.insert(way, way.refs[i], way.refs[i + 1]);
  }

  private insert(way: PedWay, a: number, b: number): void {
    const pa = this.set.position(a);
    const pb = this.set.position(b);
    this.grid.insert(
      { way, a, b, alive: true },
      Math.min(pa[0], pb[0]),
      Math.min(pa[1], pb[1]),
      Math.max(pa[0], pb[0]),
      Math.max(pa[1], pb[1]),
    );
  }

  /** Nearest segments to p within maxM, closest first, filtered by `accept`. */
  nearest(
    p: Point,
    maxM: number,
    accept: (way: PedWay, a: number, b: number) => boolean = () => true,
  ): NearestSegment[] {
    const found: NearestSegment[] = [];
    for (const entry of this.grid.query(p, maxM)) {
      if (!entry.alive || !accept(entry.way, entry.a, entry.b)) continue;
      const hit = projectOnSegment(p, this.set.position(entry.a), this.set.position(entry.b));
      if (hit.distance <= maxM) found.push({ entry, ...hit });
    }
    return found.sort((x, y) => x.distance - y.distance);
  }

  /**
   * Returns a node at the hit point: an existing end within `endM`, otherwise a new node inserted
   * into the way between the segment's two nodes.
   */
  attach(hit: NearestSegment, endM = 0.3): number {
    const { entry } = hit;
    const pa = this.set.position(entry.a);
    const pb = this.set.position(entry.b);
    if (Math.hypot(hit.point[0] - pa[0], hit.point[1] - pa[1]) <= endM) return entry.a;
    if (Math.hypot(hit.point[0] - pb[0], hit.point[1] - pb[1]) <= endM) return entry.b;
    const refs = entry.way.refs;
    let i = 0;
    while (i + 1 < refs.length && !(refs[i] === entry.a && refs[i + 1] === entry.b)) i++;
    if (i + 1 >= refs.length) throw new Error('Segment no longer in its way');
    const node = this.set.addNode(hit.point);
    refs.splice(i + 1, 0, node);
    entry.alive = false;
    this.insert(entry.way, entry.a, node);
    this.insert(entry.way, node, entry.b);
    return node;
  }
}

/** Segment set for "does this connector cross X" checks (roads, building walls). */
export class Barriers {
  private readonly grid = new GridIndex<{ a: Point; b: Point; owner: number }>(16);

  add(a: Point, b: Point, owner = -1): void {
    this.grid.insert(
      { a, b, owner },
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[0], b[0]),
      Math.max(a[1], b[1]),
    );
  }

  crosses(p: Point, q: Point, ignoreOwner = -2): boolean {
    const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const radius = Math.hypot(q[0] - p[0], q[1] - p[1]) / 2 + 1;
    for (const s of this.grid.query(mid, radius)) {
      if (s.owner === ignoreOwner) continue;
      if (segmentsCross(p, q, s.a, s.b)) return true;
    }
    return false;
  }
}
