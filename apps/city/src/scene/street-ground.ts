/**
 * The street's height near a point: the lowest ground-level path node within REACH_M (a pavement
 * along a facade), or null with none. A building on a slope stands on its lowest ground, so its
 * walls start here instead, where people walk, and never reach below the street.
 */
export type StreetGround = (x: number, y: number) => number | null;

const REACH_M = 10;
const CELL_M = 10;

export function streetGround(nodes: {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  level: Int8Array;
}): StreetGround {
  const cells = new Map<number, number[]>();
  const key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
  for (let n = 0; n < nodes.x.length; n++) {
    if (nodes.level[n] !== 0) continue;
    const k = key(Math.floor((nodes.x[n] ?? 0) / CELL_M), Math.floor((nodes.y[n] ?? 0) / CELL_M));
    const list = cells.get(k);
    if (list === undefined) cells.set(k, [n]);
    else list.push(n);
  }
  return (x, y) => {
    const cx = Math.floor(x / CELL_M);
    const cy = Math.floor(y / CELL_M);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const n of cells.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot((nodes.x[n] ?? 0) - x, (nodes.y[n] ?? 0) - y) > REACH_M) continue;
          best = Math.min(best, nodes.z[n] ?? 0);
        }
    return best === Infinity ? null : best;
  };
}
