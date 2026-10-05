import { SphereGeometry } from 'three';
import { describe, expect, it } from 'vitest';
import { simplifyGeometry } from './simplify-geometry.ts';
import { createTestRig } from './test-rig.ts';

describe('simplifyGeometry', () => {
  it('reduces triangles towards the target by re-indexing existing vertices', async () => {
    const source = new SphereGeometry(1, 64, 32);
    const before = (source.index?.count ?? 0) / 3;
    const { geometry, triangles } = await simplifyGeometry(source, 500);

    expect(before).toBeGreaterThan(3000);
    expect(triangles).toBeLessThanOrEqual(750);
    expect(triangles).toBeGreaterThan(100);
    const index = geometry.index?.array ?? [];
    const vertexCount = source.getAttribute('position').count;
    for (const i of index) expect(i).toBeLessThan(vertexCount);
  });

  it('shares vertex attributes, so skin weights stay valid', async () => {
    const { mesh } = createTestRig();
    const { geometry } = await simplifyGeometry(mesh.geometry, 60);
    for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight']) {
      expect(geometry.getAttribute(name)).toBe(mesh.geometry.getAttribute(name));
    }
  });

  it('returns the source indices when already under the target', async () => {
    const source = new SphereGeometry(1, 8, 4);
    const { triangles, error } = await simplifyGeometry(source, 10_000);
    expect(triangles).toBe((source.index?.count ?? 0) / 3);
    expect(error).toBe(0);
  });
});
