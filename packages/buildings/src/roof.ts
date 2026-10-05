import {
  area,
  chordThrough,
  distanceToRing,
  majorAxis,
  type Point,
  pointInPolygon,
  poleOfInaccessibility,
} from './polygon.ts';

/**
 * Roof walks: a path around a flat roof, set in from its edge, and on larger roofs a second path
 * across it along the roof's long axis. A deterministic function of the footprint — nothing is
 * stored on disk. Every roof is drawn flat at the building's height, so every roof is walkable.
 */
export interface RoofWalk {
  /** Node positions, region frame. */
  x: number[];
  y: number[];
  from: number[];
  to: number[];
  length: number[];
}

/** How far the walk keeps from the roof's edge. */
export const ROOF_INSET_M = 1.5;
/** Smaller footprints get no walk. */
const MIN_ROOF_M2 = 150;
/** The walk itself must enclose at least this much. */
const MIN_WALK_M2 = 40;
/** Roofs whose walk encloses this much also get a path across. */
const CROSS_WALK_M2 = 400;
/** Footprint points closer than this are merged before insetting. */
const MERGE_M = 0.5;
/** A corner moving further than this multiple of the inset (a spike) rejects the roof. */
const MAX_MITER = 4;

/** The roof walk of a footprint (counter-clockwise or not, open), or null if it has none. */
export function roofWalk(ring: readonly Point[], insetM = ROOF_INSET_M): RoofWalk | null {
  const outline = cleanRing(ring);
  if (outline.length < 3 || area(outline) < MIN_ROOF_M2) return null;
  const walk = insetRing(outline, insetM);
  if (walk === null || area(walk) < MIN_WALK_M2 || selfIntersects(walk)) return null;
  // Every corner and edge midpoint inside the roof, the inset away from its edge.
  for (let i = 0; i < walk.length; i++) {
    const a = walk[i];
    const b = walk[(i + 1) % walk.length];
    for (const p of [a, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2] as Point])
      if (!pointInPolygon(p, outline) || distanceToRing(p, outline) < insetM * 0.9) return null;
  }

  // The path across, from one side of the walk to the other through its widest point.
  const splits: { edge: number; t: number; node: number }[] = [];
  const x = walk.map((p) => p[0]);
  const y = walk.map((p) => p[1]);
  let cross: [number, number] | null = null;
  if (area(walk) >= CROSS_WALK_M2) {
    const pole = poleOfInaccessibility(walk);
    const u = majorAxis(walk);
    const [lo, hi] = chordThrough(pole.point, u, walk);
    if (pole.distance >= 3 && hi - lo >= 6) {
      const ends = [lo, hi].map((t) => {
        const p: Point = [pole.point[0] + u[0] * t, pole.point[1] + u[1] * t];
        // A corner within MERGE_M is used as it is; otherwise the edge is split there.
        const corner = walk.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < MERGE_M);
        if (corner >= 0) return corner;
        const { edge, t: along } = nearestEdge(p, walk);
        const node = x.length;
        x.push(p[0]);
        y.push(p[1]);
        splits.push({ edge, t: along, node });
        return node;
      });
      if (ends[0] !== ends[1]) cross = [ends[0], ends[1]];
    }
  }

  const from: number[] = [];
  const to: number[] = [];
  const length: number[] = [];
  const add = (a: number, b: number) => {
    from.push(a);
    to.push(b);
    length.push(Math.hypot(x[b] - x[a], y[b] - y[a]));
  };
  for (let i = 0; i < walk.length; i++) {
    let previous = i;
    const on = splits.filter((s) => s.edge === i).sort((a, b) => a.t - b.t);
    for (const s of on) {
      add(previous, s.node);
      previous = s.node;
    }
    add(previous, (i + 1) % walk.length);
  }
  if (cross !== null) add(cross[0], cross[1]);
  return { x, y, from, to, length };
}

/** Counter-clockwise, without repeated, too-close or straight-through points. */
function cleanRing(ring: readonly Point[]): Point[] {
  let points: Point[] = [];
  for (const p of ring) {
    const last = points.at(-1);
    if (last === undefined || Math.hypot(p[0] - last[0], p[1] - last[1]) >= MERGE_M) points.push(p);
  }
  while (points.length > 1) {
    const first = points[0];
    const last = points[points.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) >= MERGE_M) break;
    points.pop();
  }
  // Straight-through points (the turn is under ~3°) would make near-parallel offset lines.
  for (let changed = true; changed && points.length > 3;) {
    changed = false;
    for (let i = 0; i < points.length; i++) {
      const a = points[(i + points.length - 1) % points.length];
      const b = points[i];
      const c = points[(i + 1) % points.length];
      const ux = b[0] - a[0];
      const uy = b[1] - a[1];
      const vx = c[0] - b[0];
      const vy = c[1] - b[1];
      const sin = (ux * vy - uy * vx) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
      if (Math.abs(sin) < 0.05 && ux * vx + uy * vy > 0) {
        points.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  if (signedArea(points) < 0) points = points.reverse();
  return points;
}

/** Each edge moved inwards by `d`, corners where the moved edges meet; null for a spike. */
function insetRing(ring: readonly Point[], d: number): Point[] | null {
  const n = ring.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const p = ring[(i + n - 1) % n];
    const q = ring[i];
    const r = ring[(i + 1) % n];
    // Counter-clockwise: inwards is to the left, (−dy, dx).
    const n1 = leftNormal(p, q);
    const n2 = leftNormal(q, r);
    const a: Point = [p[0] + n1[0] * d, p[1] + n1[1] * d];
    const b: Point = [q[0] + n2[0] * d, q[1] + n2[1] * d];
    const u: Point = [q[0] - p[0], q[1] - p[1]];
    const v: Point = [r[0] - q[0], r[1] - q[1]];
    const denom = u[0] * v[1] - u[1] * v[0];
    let corner: Point;
    if (Math.abs(denom) < 1e-9) corner = [q[0] + n2[0] * d, q[1] + n2[1] * d];
    else {
      const t = ((b[0] - a[0]) * v[1] - (b[1] - a[1]) * v[0]) / denom;
      corner = [a[0] + u[0] * t, a[1] + u[1] * t];
    }
    if (Math.hypot(corner[0] - q[0], corner[1] - q[1]) > d * MAX_MITER) return null;
    out.push(corner);
  }
  // A notch narrower than twice the inset turns an edge round: the walk would fold over.
  if (signedArea(out) <= 0) return null;
  for (let i = 0; i < n; i++) {
    const ex = ring[(i + 1) % n][0] - ring[i][0];
    const ey = ring[(i + 1) % n][1] - ring[i][1];
    const fx = out[(i + 1) % n][0] - out[i][0];
    const fy = out[(i + 1) % n][1] - out[i][1];
    if (ex * fx + ey * fy <= 0) return null;
  }
  return out;
}

function leftNormal(a: Point, b: Point): Point {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [-dy / l, dx / l];
}

function signedArea(ring: readonly Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return a / 2;
}

/** Whether any two non-adjacent edges of the closed ring cross. */
function selfIntersects(ring: readonly Point[]): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++)
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsCross(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n])) return true;
    }
  return false;
}

function segmentsCross(a: Point, b: Point, c: Point, d: Point): boolean {
  const side = (p: Point, q: Point, r: Point) =>
    (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = side(c, d, a);
  const d2 = side(c, d, b);
  const d3 = side(a, b, c);
  const d4 = side(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/** The ring edge nearest `p`, and how far along it (0–1) p projects. */
function nearestEdge(p: Point, ring: readonly Point[]): { edge: number; t: number } {
  let best = { edge: 0, t: 0, d: Infinity };
  for (let i = 0; i < ring.length; i++) {
    const [ax, ay] = ring[i];
    const [bx, by] = ring[(i + 1) % ring.length];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const d = Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy));
    if (d < best.d) best = { edge: i, t, d };
  }
  return { edge: best.edge, t: best.t };
}
