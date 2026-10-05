import type { NavTile } from '@city/formats';

/**
 * The polyline a route walks, in tile coordinates (x east, y north, z height), following each
 * edge's shape.
 */
export function routePolyline(tile: NavTile, halfEdges: Uint32Array): [number, number, number][] {
  const { nodes, edges, polylines } = tile;
  const out: [number, number, number][] = [];
  for (const half of halfEdges) {
    const e = half >>> 1;
    const a = edges.from[e];
    const b = edges.to[e];
    const points: [number, number, number][] = [[nodes.x[a], nodes.y[a], nodes.z[a]]];
    for (let k = 0; k < edges.polyCount[e]; k++) {
      const i = edges.polyOffset[e] + k;
      points.push([polylines.x[i], polylines.y[i], polylines.z[i]]);
    }
    points.push([nodes.x[b], nodes.y[b], nodes.z[b]]);
    if ((half & 1) === 1) points.reverse();
    for (const p of out.length === 0 ? points : points.slice(1)) out.push(p);
  }
  return out;
}

/**
 * A flat ribbon along a polyline (WebGPU lines are one pixel wide), in Three coordinates
 * (X = x, Y = height + lift, Z = −y). Joins use the averaged normal.
 */
export function ribbon(
  points: readonly (readonly [number, number] | readonly [number, number, number])[],
  widthM: number,
  liftM: number,
): { positions: Float32Array; indices: Uint32Array } {
  const n = points.length;
  const positions = new Float32Array(n * 2 * 3);
  const indices = new Uint32Array(Math.max(0, n - 1) * 6);
  const half = widthM / 2;
  for (let i = 0; i < n; i++) {
    const prev = points[Math.max(0, i - 1)];
    const next = points[Math.min(n - 1, i + 1)];
    let dx = next[0] - prev[0];
    let dy = next[1] - prev[1];
    const length = Math.hypot(dx, dy) || 1;
    dx /= length;
    dy /= length;
    const [x, y] = points[i];
    const h = (points[i][2] ?? 0) + liftM;
    positions.set([x - dy * half, h, -(y + dx * half), x + dy * half, h, -(y - dx * half)], i * 6);
  }
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 2;
    indices.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
  }
  return { positions, indices };
}
