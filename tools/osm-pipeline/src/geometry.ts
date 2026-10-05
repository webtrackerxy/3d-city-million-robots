/** Planar helpers for the pipeline stages (local metres, x east, y north). */
export type Point = [number, number];

export function distance(a: Point, b: Point): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

/** Closest point on segment ab to p: parameter t ∈ [0, 1], the point and the distance. */
export function projectOnSegment(
  p: Point,
  a: Point,
  b: Point,
): { t: number; point: Point; distance: number } {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSq = dx * dx + dy * dy;
  const t =
    lengthSq === 0
      ? 0
      : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSq));
  const point: Point = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, distance: distance(p, point) };
}

/** Proper intersection of segments p1p2 and q1q2 (touching at an end point does not count). */
export function segmentsCross(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const d1 = orient(q1, q2, p1);
  const d2 = orient(q1, q2, p2);
  const d3 = orient(p1, p2, q1);
  const d4 = orient(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function orient(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/**
 * Intersection of the lines p + s·u and q + t·v, or null when they are within `minSine` of
 * parallel. Returns the point and s.
 */
export function lineIntersection(
  p: Point,
  u: Point,
  q: Point,
  v: Point,
  minSine = 0.17,
): { point: Point; s: number } | null {
  const cross = u[0] * v[1] - u[1] * v[0];
  const lengths = Math.hypot(u[0], u[1]) * Math.hypot(v[0], v[1]);
  if (lengths === 0 || Math.abs(cross) / lengths < minSine) return null;
  const s = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / cross;
  return { point: [p[0] + s * u[0], p[1] + s * u[1]], s };
}

export function unit(dx: number, dy: number): Point {
  const length = Math.hypot(dx, dy);
  return length === 0 ? [0, 0] : [dx / length, dy / length];
}

/** Left normal (counter-clockwise) of a direction. */
export function leftNormal(u: Point): Point {
  return [-u[1], u[0]];
}

/**
 * Offsets a polyline sideways: positive `d` to the left of the direction of travel. Interior
 * vertices use a miter limited to 2·|d| so sharp bends do not shoot out.
 */
export function offsetPolyline(points: readonly Point[], d: number): Point[] {
  const n = points.length;
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const before =
      i > 0 ? unit(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]) : null;
    const after =
      i < n - 1 ? unit(points[i + 1][0] - points[i][0], points[i + 1][1] - points[i][1]) : null;
    const nb = before === null ? null : leftNormal(before);
    const na = after === null ? null : leftNormal(after);
    let normal: Point;
    let scale = 1;
    if (nb !== null && na !== null) {
      normal = unit(nb[0] + na[0], nb[1] + na[1]);
      const cos = normal[0] * na[0] + normal[1] * na[1];
      scale = cos > 0.5 ? 1 / cos : 2;
      if (normal[0] === 0 && normal[1] === 0) normal = na;
    } else {
      normal = nb ?? na ?? [0, 0];
    }
    out.push([points[i][0] + normal[0] * d * scale, points[i][1] + normal[1] * d * scale]);
  }
  return out;
}

/** Uniform grid over axis-aligned boxes; queries return candidates (callers test exactly). */
export class GridIndex<T> {
  private readonly cells = new Map<number, T[]>();
  private readonly cellM: number;

  constructor(cellM: number) {
    this.cellM = cellM;
  }

  private key(cx: number, cy: number): number {
    return (cx + 32768) * 65536 + (cy + 32768);
  }

  insert(item: T, minX: number, minY: number, maxX: number, maxY: number): void {
    const c = this.cellM;
    for (let cx = Math.floor(minX / c); cx <= Math.floor(maxX / c); cx++) {
      for (let cy = Math.floor(minY / c); cy <= Math.floor(maxY / c); cy++) {
        const key = this.key(cx, cy);
        const list = this.cells.get(key);
        if (list === undefined) this.cells.set(key, [item]);
        else list.push(item);
      }
    }
  }

  /** Candidates whose boxes may touch the square of half-size `radius` around p (deduplicated). */
  query(p: Point, radius: number): Set<T> {
    const c = this.cellM;
    const out = new Set<T>();
    for (let cx = Math.floor((p[0] - radius) / c); cx <= Math.floor((p[0] + radius) / c); cx++) {
      for (let cy = Math.floor((p[1] - radius) / c); cy <= Math.floor((p[1] + radius) / c); cy++) {
        const list = this.cells.get(this.key(cx, cy));
        if (list !== undefined) for (const item of list) out.add(item);
      }
    }
    return out;
  }
}
