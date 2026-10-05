/**
 * The region's ground height on a coarse grid, from the graph's ground-level nodes (their z is the
 * terrain, relative to the region's zero). The flat base map has no terrain, so over it the city is
 * lowered by the ground at the view's focus; the photorealistic tiles have terrain and keep it.
 */
export interface GroundGrid {
  /** Ground height at (x, y) in the region frame, or null with no ground nodes nearby. */
  sample(x: number, y: number): number | null;
}

const CELL_M = 64;

export function groundGrid(nodes: {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  level: Int8Array;
}): GroundGrid {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let n = 0; n < nodes.x.length; n++) {
    minX = Math.min(minX, nodes.x[n] ?? 0);
    minY = Math.min(minY, nodes.y[n] ?? 0);
    maxX = Math.max(maxX, nodes.x[n] ?? 0);
    maxY = Math.max(maxY, nodes.y[n] ?? 0);
  }
  if (!(maxX >= minX)) return { sample: () => null };
  const width = Math.floor((maxX - minX) / CELL_M) + 1;
  const height = Math.floor((maxY - minY) / CELL_M) + 1;
  // Each cell's median ground node: bridges and odd nodes do not pull it.
  const cells: number[][] = Array.from({ length: width * height }, () => []);
  for (let n = 0; n < nodes.x.length; n++) {
    if (nodes.level[n] !== 0) continue;
    const cx = Math.floor(((nodes.x[n] ?? 0) - minX) / CELL_M);
    const cy = Math.floor(((nodes.y[n] ?? 0) - minY) / CELL_M);
    cells[cy * width + cx]?.push(nodes.z[n] ?? 0);
  }
  const ground = new Float32Array(width * height).fill(Number.NaN);
  cells.forEach((zs, i) => {
    if (zs.length === 0) return;
    zs.sort((a, b) => a - b);
    ground[i] = zs[zs.length >> 1] ?? Number.NaN;
  });
  return {
    sample(x, y) {
      // Bilinear between cell centres, over the cells that have ground.
      const gx = (x - minX) / CELL_M - 0.5;
      const gy = (y - minY) / CELL_M - 0.5;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      let sum = 0;
      let weights = 0;
      for (let dy = 0; dy <= 1; dy++)
        for (let dx = 0; dx <= 1; dx++) {
          const cx = x0 + dx;
          const cy = y0 + dy;
          if (cx < 0 || cy < 0 || cx >= width || cy >= height) continue;
          const z = ground[cy * width + cx] ?? Number.NaN;
          if (Number.isNaN(z)) continue;
          const w = (dx === 1 ? gx - x0 : 1 - (gx - x0)) * (dy === 1 ? gy - y0 : 1 - (gy - y0));
          sum += z * w;
          weights += w;
        }
      return weights > 1e-6 ? sum / weights : null;
    },
  };
}
