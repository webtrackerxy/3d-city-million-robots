/** Planar helpers for footprints (x east, y north, metres; rings counter-clockwise, open). */
export type Point = [number, number];

export function pointInPolygon(p: Point, ring: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

export function distanceToRing(p: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    best = Math.min(best, Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)));
  }
  return best;
}

/** Signed distance: positive inside. */
function signedDistance(p: Point, ring: readonly Point[]): number {
  const d = distanceToRing(p, ring);
  return pointInPolygon(p, ring) ? d : -d;
}

export function area(ring: readonly Point[]): number {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(a) / 2;
}

/**
 * Pole of inaccessibility (the polylabel algorithm, Agafonkin 2016): the interior point farthest
 * from the outline, to `precision` metres. Returns the point and its distance to the outline.
 */
export function poleOfInaccessibility(
  ring: readonly Point[],
  precision = 0.5,
): { point: Point; distance: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const size = Math.min(maxX - minX, maxY - minY);
  if (size <= 0) return { point: [minX, minY], distance: 0 };
  interface Cell {
    x: number;
    y: number;
    h: number;
    d: number;
    max: number;
  }
  const cell = (x: number, y: number, h: number): Cell => {
    const d = signedDistance([x, y], ring);
    return { x, y, h, d, max: d + h * Math.SQRT2 };
  };
  const queue: Cell[] = [];
  let h = size / 2;
  for (let x = minX; x < maxX; x += size)
    for (let y = minY; y < maxY; y += size) queue.push(cell(x + h, y + h, h));
  // Start from the centroid of the vertices or the box centre, whichever is better.
  let best = cell((minX + maxX) / 2, (minY + maxY) / 2, 0);
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  const centroid = cell(cx / ring.length, cy / ring.length, 0);
  if (centroid.d > best.d) best = centroid;
  // Sorted by potential; the queue stays small for building footprints.
  for (;;) {
    queue.sort((a, b) => a.max - b.max);
    const c = queue.pop();
    if (c === undefined) break;
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    h = c.h / 2;
    queue.push(
      cell(c.x - h, c.y - h, h),
      cell(c.x + h, c.y - h, h),
      cell(c.x - h, c.y + h, h),
      cell(c.x + h, c.y + h, h),
    );
  }
  return { point: [best.x, best.y], distance: best.d };
}

/** Principal axis of the outline's vertices (unit vector), for the corridor spine. */
export function majorAxis(ring: readonly Point[]): Point {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of ring) {
    cx += x;
    cy += y;
  }
  cx /= ring.length;
  cy /= ring.length;
  let xx = 0;
  let xy = 0;
  let yy = 0;
  for (const [x, y] of ring) {
    xx += (x - cx) ** 2;
    xy += (x - cx) * (y - cy);
    yy += (y - cy) ** 2;
  }
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);
  return [Math.cos(angle), Math.sin(angle)];
}

/**
 * The stretch of the line p + t·u inside the polygon that contains p (p must be inside): the
 * nearest outline crossings either side.
 */
export function chordThrough(p: Point, u: Point, ring: readonly Point[]): [number, number] {
  let lo = -Infinity;
  let hi = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j];
    const [bx, by] = ring[i];
    const ex = bx - ax;
    const ey = by - ay;
    const denom = u[0] * ey - u[1] * ex;
    if (Math.abs(denom) < 1e-12) continue;
    const t = ((ax - p[0]) * ey - (ay - p[1]) * ex) / denom;
    const s = ((ax - p[0]) * u[1] - (ay - p[1]) * u[0]) / denom;
    if (s < 0 || s > 1) continue;
    if (t >= 0) hi = Math.min(hi, t);
    else lo = Math.max(lo, t);
  }
  return [Number.isFinite(lo) ? lo : 0, Number.isFinite(hi) ? hi : 0];
}
