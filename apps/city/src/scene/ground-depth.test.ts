import { describe, expect, it } from 'vitest';
import { GROUND_DEPTH_CELL_M, groundDepthHeights } from './ground-depth.ts';

describe('groundDepthHeights', () => {
  it('takes each cell lowest ground node, below it, and fills empty cells from neighbours', () => {
    const c = GROUND_DEPTH_CELL_M;
    // Cells (0,0) and (2,0) have nodes; (1,0) has none. A level-1 node is ignored.
    const grid = groundDepthHeights({
      x: Float32Array.from([1, 2, 2 * c + 1, 2 * c + 2, c + 1]),
      y: Float32Array.from([1, 2, 1, 2, 1]),
      z: Float32Array.from([5, 3, 9, 7, -40]),
      level: Int8Array.from([0, 0, 0, 0, 1]),
    });
    expect(grid?.width).toBe(3);
    const [a, b, d] = Array.from(grid?.heights ?? []);
    expect(a).toBeCloseTo(3 - 0.3);
    expect(d).toBeCloseTo(7 - 0.3);
    expect(b).toBeCloseTo((2.7 + 6.7) / 2);
  });
});
