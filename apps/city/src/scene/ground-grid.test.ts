import { describe, expect, it } from 'vitest';
import { groundGrid } from './ground-grid.ts';

describe('groundGrid', () => {
  it('follows the ground nodes, ignores other levels, and has nothing far away', () => {
    // Ground rising 1 m per 64 m along x, plus a bridge node (level 1) far above it.
    const xs: number[] = [];
    const ys: number[] = [];
    const zs: number[] = [];
    const levels: number[] = [];
    for (let x = 0; x < 640; x += 16)
      for (let y = 0; y < 256; y += 16) {
        xs.push(x);
        ys.push(y);
        zs.push(x / 64);
        levels.push(0);
      }
    xs.push(320);
    ys.push(128);
    zs.push(50);
    levels.push(1);
    const grid = groundGrid({
      x: Float32Array.from(xs),
      y: Float32Array.from(ys),
      z: Float32Array.from(zs),
      level: Int8Array.from(levels),
    });
    expect(grid.sample(320, 128)).toBeCloseTo(5, 0);
    expect(grid.sample(96, 100)).toBeCloseTo(1.5, 0);
    expect(grid.sample(5000, 5000)).toBeNull();
  });
});
