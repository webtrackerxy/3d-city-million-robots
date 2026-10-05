import { describe, expect, it } from 'vitest';
import { buildingGeometry } from './buildings-geometry.ts';
import { streetGround } from './street-ground.ts';

describe('streetGround', () => {
  const ground = streetGround({
    x: Float32Array.from([0, 4, 50]),
    y: Float32Array.from([0, 0, 0]),
    z: Float32Array.from([3, 2.5, 9]),
    level: Int8Array.from([0, 0, 1]),
  });

  it('is the lowest ground node within reach, ignoring other levels', () => {
    expect(ground(2, 1)).toBeCloseTo(2.5);
    expect(ground(50, 0)).toBeNull();
  });

  it('starts walls at the street beside them, never below the base', () => {
    // A 4 × 4 m building with base 0 and roof at 12, its south-west corner at the nodes.
    const arrays = buildingGeometry(
      {
        ringOffset: Uint32Array.from([0]),
        ringCount: Uint16Array.from([4]),
        levels: Int16Array.from([3]),
        baseZ: Float32Array.from([0]),
        height: Float32Array.from([12]),
        type: new Uint8Array(1),
        flags: new Uint8Array(1),
        capacity: new Uint32Array(1),
        seed: new Uint32Array(1),
        osmIdLo: new Uint32Array(1),
        osmIdHi: new Uint32Array(1),
        ringX: Float32Array.from([0, 4, 4, 0]),
        ringY: Float32Array.from([0, 0, 4, 4]),
      },
      ground,
    );
    // Wall feet (scene y is height): the street's 2.5 m, not the base's 0.
    const feet = [0, 1].map((v) => arrays.positions[v * 3 + 1]);
    expect(feet[0]).toBeCloseTo(2.5);
    expect(feet[1]).toBeCloseTo(2.5);
  });
});
