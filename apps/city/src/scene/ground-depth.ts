import { BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial } from 'three';

/**
 * An invisible ground for a region built with terrain: it writes depth only, so the walls of a
 * building on a slope (drawn down to the lowest ground under it) stop at the street instead of
 * showing below people's feet. Each cell is the lowest ground node in it, a little lower still,
 * so it never hides feet; cells without nodes take their neighbours' height.
 */
export const GROUND_DEPTH_CELL_M = 8;
/** How far below the lowest ground node of a cell the surface lies. */
const CLEARANCE_M = 0.3;

/** The cell heights (row-major, y north), and the grid's south-west corner. */
export function groundDepthHeights(nodes: {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  level: Int8Array;
}): { heights: Float32Array; width: number; height: number; minX: number; minY: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let n = 0; n < nodes.x.length; n++) {
    if (nodes.level[n] !== 0) continue;
    minX = Math.min(minX, nodes.x[n] ?? 0);
    minY = Math.min(minY, nodes.y[n] ?? 0);
    maxX = Math.max(maxX, nodes.x[n] ?? 0);
    maxY = Math.max(maxY, nodes.y[n] ?? 0);
  }
  if (!(maxX > minX && maxY > minY)) return null;
  const cell = GROUND_DEPTH_CELL_M;
  const width = Math.floor((maxX - minX) / cell) + 1;
  const height = Math.floor((maxY - minY) / cell) + 1;
  const heights = new Float32Array(width * height).fill(Number.POSITIVE_INFINITY);
  for (let n = 0; n < nodes.x.length; n++) {
    if (nodes.level[n] !== 0) continue;
    const i =
      Math.floor(((nodes.y[n] ?? 0) - minY) / cell) * width +
      Math.floor(((nodes.x[n] ?? 0) - minX) / cell);
    heights[i] = Math.min(heights[i] ?? Infinity, (nodes.z[n] ?? 0) - CLEARANCE_M);
  }
  // Empty cells (inside large buildings, water) take the mean of their filled neighbours, pass
  // by pass, until every cell has a height.
  for (let pass = 0, empty = 1; empty > 0 && pass < 512; pass++) {
    empty = 0;
    const next = heights.slice();
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (Number.isFinite(heights[i])) continue;
        let sum = 0;
        let count = 0;
        for (const [dx, dy] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const h = heights[ny * width + nx] ?? Infinity;
          if (!Number.isFinite(h)) continue;
          sum += h;
          count++;
        }
        if (count > 0) next[i] = sum / count;
        else empty++;
      }
    heights.set(next);
  }
  return { heights, width, height, minX, minY };
}

/** The depth-only ground mesh, in the scene frame (x east, y up, z south). */
export function groundDepthMesh(nodes: Parameters<typeof groundDepthHeights>[0]): Mesh | null {
  const grid = groundDepthHeights(nodes);
  if (grid === null) return null;
  const { heights, width, height, minX, minY } = grid;
  const cell = GROUND_DEPTH_CELL_M;
  // One vertex per cell centre, two triangles per square of four centres.
  const positions = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      positions[i * 3] = minX + (x + 0.5) * cell;
      positions[i * 3 + 1] = heights[i] ?? 0;
      positions[i * 3 + 2] = -(minY + (y + 0.5) * cell);
    }
  const index = new Uint32Array(Math.max(0, (width - 1) * (height - 1) * 6));
  let k = 0;
  for (let y = 0; y + 1 < height; y++)
    for (let x = 0; x + 1 < width; x++) {
      const a = y * width + x;
      const b = a + 1;
      const c = a + width;
      const d = c + 1;
      index.set([a, c, b, b, c, d], k);
      k += 6;
    }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.computeBoundingSphere();
  const material = new MeshBasicMaterial({ colorWrite: false });
  const mesh = new Mesh(geometry, material);
  // First, so everything drawn after it is depth-tested against it.
  mesh.renderOrder = -1;
  mesh.name = 'ground-depth';
  return mesh;
}
