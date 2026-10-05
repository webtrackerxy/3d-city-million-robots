import { EdgeFlag, EdgeType } from '@city/core-types';
import {
  distance,
  GridIndex,
  leftNormal,
  lineIntersection,
  offsetPolyline,
  type Point,
  projectOnSegment,
  unit,
} from './geometry.ts';
import type { Tags } from './opl.ts';
import { isSignalised } from './pedestrian.ts';
import { inferredAttributes, type PedWay, type WaySet } from './way-set.ts';

/**
 * Stages 5–6 (implementation plan §10): sidewalks inferred from road centrelines, and the
 * crossings that join them.
 *
 * Roads are split at shared nodes; each piece is offset sideways by half the carriageway plus
 * half a sidewalk. At every road node, arms are sorted by bearing and neighbouring offset lines
 * are intersected to give one corner node per wedge, which both sidewalks end on. Mapped crossing
 * nodes become crossing edges between the two kerbs; junction arms without one get an implicit
 * crossing (flagged, so routing can charge extra). Inferred sidewalks that run alongside a mapped
 * footway are suppressed.
 */
export interface RoadWay {
  id: number;
  refs: number[];
  tags: Tags;
}

interface RoadClass {
  widthM: number;
  /** Sidewalks on both sides when the road has no sidewalk tags. */
  sidewalksByDefault: boolean;
  /** Pedestrians may cross it at junctions without a mapped crossing. */
  implicitCrossing: boolean;
}

export const ROAD_CLASSES: Partial<Record<string, RoadClass>> = {
  trunk: { widthM: 7.5, sidewalksByDefault: false, implicitCrossing: false },
  trunk_link: { widthM: 4, sidewalksByDefault: false, implicitCrossing: false },
  primary: { widthM: 8, sidewalksByDefault: true, implicitCrossing: true },
  primary_link: { widthM: 4.5, sidewalksByDefault: true, implicitCrossing: true },
  secondary: { widthM: 7.5, sidewalksByDefault: true, implicitCrossing: true },
  secondary_link: { widthM: 4.5, sidewalksByDefault: true, implicitCrossing: true },
  tertiary: { widthM: 7, sidewalksByDefault: true, implicitCrossing: true },
  tertiary_link: { widthM: 4.5, sidewalksByDefault: true, implicitCrossing: true },
  residential: { widthM: 6, sidewalksByDefault: true, implicitCrossing: true },
  unclassified: { widthM: 6, sidewalksByDefault: true, implicitCrossing: true },
  service: { widthM: 4, sidewalksByDefault: false, implicitCrossing: true },
};

export const SIDEWALK_WIDTH_M = 2;
const LANE_M = 3.25;
/** Densify inferred sidewalks so suppression and connectors can cut them finely. */
const MAX_SPACING_M = 5;
/** A mapped footway within this distance, running parallel, suppresses an inferred sidewalk. */
const SUPPRESS_M = 4;
const SUPPRESS_COS = Math.cos((25 * Math.PI) / 180);
/** A mapped crossing this close to a junction on an arm replaces the implicit one. */
const CROSSING_NEAR_JUNCTION_M = 20;

export type SideState = 'yes' | 'no' | 'separate' | 'default';

export function isRoad(tags: Tags): boolean {
  return (
    tags.highway !== undefined && ROAD_CLASSES[tags.highway] !== undefined && tags.area !== 'yes'
  );
}

/** Sidewalk presence per side of the way direction, from the `sidewalk*` tags. */
export function sidewalkSides(tags: Tags): { left: SideState; right: SideState } {
  const parse = (value: string | undefined): SideState | undefined => {
    if (value === undefined) return undefined;
    if (value === 'yes') return 'yes';
    if (value === 'separate') return 'separate';
    if (value === 'no' || value === 'none') return 'no';
    return undefined;
  };
  let left: SideState = 'default';
  let right: SideState = 'default';
  switch (tags.sidewalk) {
    case 'both':
    case 'yes':
      left = right = 'yes';
      break;
    case 'left':
      left = 'yes';
      right = 'no';
      break;
    case 'right':
      left = 'no';
      right = 'yes';
      break;
    case 'no':
    case 'none':
      left = right = 'no';
      break;
    case 'separate':
      left = right = 'separate';
      break;
  }
  const both = parse(tags['sidewalk:both']);
  if (both !== undefined) left = right = both;
  left = parse(tags['sidewalk:left']) ?? left;
  right = parse(tags['sidewalk:right']) ?? right;
  return { left, right };
}

/** Carriageway width: `width` tag → lanes × 3.25 m → class default (halved for one-way links). */
export function roadWidthM(tags: Tags): number {
  const spec = ROAD_CLASSES[tags.highway ?? ''];
  const tagged = Number(tags.width?.replace(/\s*m$/, ''));
  if (Number.isFinite(tagged) && tagged > 1) return tagged;
  const lanes = Number(tags.lanes);
  if (Number.isFinite(lanes) && lanes > 0) return lanes * LANE_M;
  const width = spec?.widthM ?? 6;
  return tags.oneway === 'yes' ? Math.max(LANE_M, width / 2) : width;
}

export interface SidewalkQa {
  roads: number;
  roadSegments: number;
  inferredLengthM: number;
  suppressedLengthM: number;
  explicitSidewalkLengthM: number;
  mappedCrossings: number;
  implicitCrossings: number;
  cappedEnds: number;
  corners: number;
}

interface Segment {
  road: RoadWay;
  cls: RoadClass;
  refs: number[];
  points: Point[];
  /** Offset distance from the centreline. */
  offsetM: number;
  left: boolean;
  right: boolean;
}

interface Arm {
  segment: Segment;
  atStart: boolean;
  /** Unit direction leaving the junction. */
  u: Point;
  bearing: number;
  /** Sidewalk on the left / right as seen walking out along the arm. */
  leftSide: boolean;
  rightSide: boolean;
}

interface Corner {
  node: number;
  attached: number;
}

export function inferSidewalks(
  set: WaySet,
  roads: readonly RoadWay[],
  nodeTags: ReadonlyMap<number, Tags>,
): SidewalkQa {
  const qa: SidewalkQa = {
    roads: 0,
    roadSegments: 0,
    inferredLengthM: 0,
    suppressedLengthM: 0,
    explicitSidewalkLengthM: 0,
    mappedCrossings: 0,
    implicitCrossings: 0,
    cappedEnds: 0,
    corners: 0,
  };
  const mapped = mappedIndex(set);
  const mappedNodes = new Set(set.ways.flatMap((way) => way.refs));
  for (const way of set.ways)
    if ((way.attributes.flags & EdgeFlag.Sidewalk) !== 0)
      qa.explicitSidewalkLengthM += lengthOf(set, way.refs);

  // Split roads at nodes shared with other roads.
  const usable = roads.filter(
    (r) => isRoad(r.tags) && r.refs.length >= 2 && r.refs.every((ref) => set.positions.has(ref)),
  );
  qa.roads = usable.length;
  const uses = new Map<number, number>();
  for (const road of usable)
    road.refs.forEach((ref, i) => {
      const end = i === 0 || i === road.refs.length - 1;
      uses.set(ref, (uses.get(ref) ?? 0) + (end ? 2 : 1));
    });
  const segments: Segment[] = [];
  for (const road of usable) {
    const cls = ROAD_CLASSES[road.tags.highway ?? ''];
    if (cls === undefined) continue;
    const sides = sidewalkSides(road.tags);
    const underground = road.tags.tunnel !== undefined && road.tags.tunnel !== 'no';
    const dual = road.tags.dual_carriageway === 'yes';
    const byDefault = cls.sidewalksByDefault && !underground && !dual;
    const has = (s: SideState) => s === 'yes' || (s === 'default' && byDefault);
    const offsetM = roadWidthM(road.tags) / 2 + SIDEWALK_WIDTH_M / 2;
    let start = 0;
    for (let i = 1; i < road.refs.length; i++) {
      if (i === road.refs.length - 1 || (uses.get(road.refs[i]) ?? 0) >= 2) {
        const refs = road.refs.slice(start, i + 1);
        const points = refs.map((ref) => set.position(ref));
        if (refs.length >= 2 && distance(points[0], points[1]) > 0.01)
          segments.push({
            road,
            cls,
            refs,
            points,
            offsetM,
            left: has(sides.left),
            right: has(sides.right),
          });
        start = i;
      }
    }
  }
  qa.roadSegments = segments.length;

  // Arms at every segment end, sorted counter-clockwise.
  const arms = new Map<number, Arm[]>();
  for (const segment of segments) {
    const n = segment.points.length;
    for (const atStart of [true, false]) {
      const at = atStart ? segment.points[0] : segment.points[n - 1];
      const next = atStart ? segment.points[1] : segment.points[n - 2];
      const u = unit(next[0] - at[0], next[1] - at[1]);
      const node = atStart ? segment.refs[0] : segment.refs[n - 1];
      const list = arms.get(node) ?? [];
      list.push({
        segment,
        atStart,
        u,
        bearing: Math.atan2(u[1], u[0]),
        leftSide: atStart ? segment.left : segment.right,
        rightSide: atStart ? segment.right : segment.left,
      });
      arms.set(node, list);
    }
  }
  for (const list of arms.values()) list.sort((a, b) => a.bearing - b.bearing);

  // One corner per wedge (arm i, arm i+1), where either bounding side has a sidewalk. The wedge
  // is bounded by arm i's left offset line and arm i+1's right offset line.
  const corners = new Map<Arm, { left?: Corner; right?: Corner }>();
  const cornerOf = (arm: Arm) => {
    let entry = corners.get(arm);
    if (entry === undefined) corners.set(arm, (entry = {}));
    return entry;
  };
  for (const [node, list] of arms) {
    const j = set.position(node);
    if (list.length === 1) {
      // Dead end: each side ends on its own offset point; a cap joins them if both exist.
      const arm = list[0];
      const d = arm.segment.offsetM;
      const nl = leftNormal(arm.u);
      const entry = cornerOf(arm);
      if (arm.leftSide)
        entry.left = { node: set.addNode([j[0] + nl[0] * d, j[1] + nl[1] * d]), attached: 0 };
      if (arm.rightSide)
        entry.right = { node: set.addNode([j[0] - nl[0] * d, j[1] - nl[1] * d]), attached: 0 };
      if (entry.left !== undefined && entry.right !== undefined) {
        set.add({
          id: arm.segment.road.id,
          refs: [entry.left.node, entry.right.node],
          attributes: inferredAttributes(EdgeType.Pavement, SIDEWALK_WIDTH_M * 100),
        });
        qa.cappedEnds++;
        qa.inferredLengthM += 2 * d;
      }
      continue;
    }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      const b = list[(i + 1) % list.length];
      if (!a.leftSide && !b.rightSide) continue;
      const na = leftNormal(a.u);
      const nb = leftNormal(b.u);
      const pa: Point = [j[0] + na[0] * a.segment.offsetM, j[1] + na[1] * a.segment.offsetM];
      const pb: Point = [j[0] - nb[0] * b.segment.offsetM, j[1] - nb[1] * b.segment.offsetM];
      const limit = 3 * Math.max(a.segment.offsetM, b.segment.offsetM);
      const hit = lineIntersection(pa, a.u, pb, b.u);
      const point: Point =
        hit !== null && distance(hit.point, j) <= limit
          ? hit.point
          : [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      const corner = { node: set.addNode(point), attached: 0 };
      cornerOf(a).left = corner;
      cornerOf(b).right = corner;
      qa.corners++;
    }
  }

  // Sidewalk polylines per segment side, ending on the corners; densified; road vertex → node.
  const sidewalks: PedWay[] = [];
  // Kerb node per (segment, side, road vertex index), for mapped crossings.
  const kerbNodes = new Map<Segment, { left: Map<number, number>; right: Map<number, number> }>();
  const kerbNode = (segment: Segment, side: 'left' | 'right', index: number) =>
    kerbNodes.get(segment)?.[side].get(index);
  const armAt = (segment: Segment, atStart: boolean): Arm | undefined => {
    const node = atStart ? segment.refs[0] : segment.refs[segment.refs.length - 1];
    return arms.get(node)?.find((arm) => arm.segment === segment && arm.atStart === atStart);
  };
  for (const segment of segments) {
    const n = segment.points.length;
    const startArm = armAt(segment, true);
    const endArm = armAt(segment, false);
    if (startArm === undefined || endArm === undefined) continue;
    for (const side of ['left', 'right'] as const) {
      if (!segment[side]) continue;
      // Way-left leaves the start junction on the arm's left and reaches the end on its right.
      const startCorner =
        side === 'left' ? corners.get(startArm)?.left : corners.get(startArm)?.right;
      const endCorner = side === 'left' ? corners.get(endArm)?.right : corners.get(endArm)?.left;
      if (startCorner === undefined || endCorner === undefined) continue;
      const offset = offsetPolyline(
        segment.points,
        side === 'left' ? segment.offsetM : -segment.offsetM,
      );
      const startPoint = set.position(startCorner.node);
      const endPoint = set.position(endCorner.node);
      // Trim interior vertices that fall behind a corner along the arm.
      const along = (p: Point, from: Point, u: Point) =>
        (p[0] - from[0]) * u[0] + (p[1] - from[1]) * u[1];
      const j0 = segment.points[0];
      const j1 = segment.points[n - 1];
      const startLimit = along(startPoint, j0, startArm.u) + 0.5;
      const endLimit = along(endPoint, j1, endArm.u) + 0.5;
      const refs = [startCorner.node];
      let kerbs = kerbNodes.get(segment);
      if (kerbs === undefined)
        kerbNodes.set(segment, (kerbs = { left: new Map(), right: new Map() }));
      for (let k = 1; k < n - 1; k++) {
        if (along(offset[k], j0, startArm.u) <= startLimit) continue;
        if (along(offset[k], j1, endArm.u) <= endLimit) continue;
        const node = set.addNode(offset[k]);
        kerbs[side].set(k, node);
        refs.push(node);
      }
      refs.push(endCorner.node);
      if (refs[0] === refs[refs.length - 1] && refs.length <= 2) continue;
      startCorner.attached++;
      endCorner.attached++;
      const way: PedWay = {
        id: segment.road.id,
        refs: densify(set, refs),
        attributes: inferredAttributes(EdgeType.Pavement, SIDEWALK_WIDTH_M * 100),
      };
      sidewalks.push(way);
    }
  }

  // Mapped crossing nodes on roads → crossing edges kerb → road node → kerb.
  const crossings: PedWay[] = [];
  const crossingNearJunction = new Set<Arm>();
  for (const segment of segments) {
    const n = segment.refs.length;
    const length = lengthOfPoints(segment.points);
    let cumulative = 0;
    for (let k = 1; k < n - 1; k++) {
      cumulative += distance(segment.points[k - 1], segment.points[k]);
      const tags = nodeTags.get(segment.refs[k]);
      if (tags?.highway !== 'crossing' || tags.crossing === 'no') continue;
      qa.mappedCrossings++;
      if (cumulative <= CROSSING_NEAR_JUNCTION_M) {
        const arm = armAt(segment, true);
        if (arm !== undefined) crossingNearJunction.add(arm);
      }
      if (length - cumulative <= CROSSING_NEAR_JUNCTION_M) {
        const arm = armAt(segment, false);
        if (arm !== undefined) crossingNearJunction.add(arm);
      }
      const kerbs = [kerbNode(segment, 'left', k), kerbNode(segment, 'right', k)].filter(
        (kerb) => kerb !== undefined,
      );
      // Half a crossing only makes sense if a mapped footway continues from the road node.
      if (kerbs.length < 2 && !mappedNodes.has(segment.refs[k])) continue;
      const signals = isSignalised(tags) ? EdgeFlag.Signalised : 0;
      for (const kerb of kerbs) {
        crossings.push({
          id: segment.road.id,
          refs: [kerb, segment.refs[k]],
          attributes: inferredAttributes(EdgeType.Crossing, 300, signals),
        });
      }
    }
  }

  // Implicit crossings across junction arms with no mapped crossing near the junction.
  for (const list of arms.values()) {
    if (list.length < 3) continue;
    for (const arm of list) {
      if (!arm.segment.cls.implicitCrossing || crossingNearJunction.has(arm)) continue;
      const entry = corners.get(arm);
      const right = entry?.right;
      const left = entry?.left;
      if (right === undefined || left === undefined || right === left) continue;
      if (right.attached === 0 || left.attached === 0) continue;
      crossings.push({
        id: arm.segment.road.id,
        refs: [right.node, left.node],
        attributes: inferredAttributes(EdgeType.Crossing, 300, EdgeFlag.Implicit),
      });
      qa.implicitCrossings++;
    }
  }

  // Suppress inferred sidewalk stretches that duplicate a mapped footway.
  const alive = new Set<number>();
  for (const way of sidewalks) {
    let run: number[] = [];
    const flush = () => {
      if (run.length >= 2) {
        const length = lengthOf(set, run);
        if (length >= 3) {
          set.add({ ...way, refs: run });
          for (const ref of run) alive.add(ref);
          qa.inferredLengthM += length;
        } else qa.suppressedLengthM += length;
      }
      run = [];
    };
    for (let i = 0; i + 1 < way.refs.length; i++) {
      const a = set.position(way.refs[i]);
      const b = set.position(way.refs[i + 1]);
      if (mapped.covers(a, b)) {
        qa.suppressedLengthM += distance(a, b);
        flush();
      } else {
        if (run.length === 0) run.push(way.refs[i]);
        run.push(way.refs[i + 1]);
      }
    }
    flush();
  }
  for (const way of crossings) {
    if (!way.refs.every((ref) => ref >= 0 || alive.has(ref))) {
      if ((way.attributes.flags & EdgeFlag.Implicit) !== 0) qa.implicitCrossings--;
      continue;
    }
    set.add(way);
  }
  return qa;
}

/** Index of mapped (non-crossing) pedestrian segments for suppression. */
function mappedIndex(set: WaySet): { covers(a: Point, b: Point): boolean } {
  const grid = new GridIndex<[Point, Point]>(16);
  for (const way of set.ways) {
    if (way.attributes.type === EdgeType.Crossing || way.attributes.level !== 0) continue;
    for (let i = 0; i + 1 < way.refs.length; i++) {
      const p = set.position(way.refs[i]);
      const q = set.position(way.refs[i + 1]);
      grid.insert(
        [p, q],
        Math.min(p[0], q[0]),
        Math.min(p[1], q[1]),
        Math.max(p[0], q[0]),
        Math.max(p[1], q[1]),
      );
    }
  }
  return {
    covers(a, b) {
      const mid: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const u = unit(b[0] - a[0], b[1] - a[1]);
      for (const [p, q] of grid.query(mid, SUPPRESS_M)) {
        if (projectOnSegment(mid, p, q).distance > SUPPRESS_M) continue;
        const v = unit(q[0] - p[0], q[1] - p[1]);
        if (Math.abs(u[0] * v[0] + u[1] * v[1]) >= SUPPRESS_COS) return true;
      }
      return false;
    },
  };
}

function densify(set: WaySet, refs: number[]): number[] {
  const out = [refs[0]];
  for (let i = 1; i < refs.length; i++) {
    const a = set.position(refs[i - 1]);
    const b = set.position(refs[i]);
    const pieces = Math.ceil(distance(a, b) / MAX_SPACING_M);
    for (let k = 1; k < pieces; k++)
      out.push(
        set.addNode([a[0] + ((b[0] - a[0]) * k) / pieces, a[1] + ((b[1] - a[1]) * k) / pieces]),
      );
    out.push(refs[i]);
  }
  return out;
}

function lengthOf(set: WaySet, refs: readonly number[]): number {
  return lengthOfPoints(refs.map((ref) => set.position(ref)));
}

function lengthOfPoints(points: readonly Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distance(points[i - 1], points[i]);
  return length;
}
