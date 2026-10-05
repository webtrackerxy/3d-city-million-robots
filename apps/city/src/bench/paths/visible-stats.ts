import type { MetricsBus } from '@city/metrics';
import { BUCKETS_PER_FAMILY, type LoadedFamily } from '@city/render';

export { BUCKETS_PER_FAMILY };
/** Visible-count readback cadence; a few bytes, never awaited by the frame loop. */
export const READBACK_INTERVAL_MS = 250;
/** An impostor is one quad. */
const IMPOSTOR_TRIANGLES = 2;

/**
 * Publishes the GPU's per-bucket visible counts (one u32 per (family, LOD) bucket, then the
 * visible total) to the HUD. Returns the triangles drawn, since Three's own counters only know the
 * CPU-side instance count of indirect draws.
 */
export function publishVisibleCounts(
  values: Uint32Array,
  families: readonly LoadedFamily[],
  bus: MetricsBus,
): number {
  let triangles = 0;
  const byLod = new Array<number>(BUCKETS_PER_FAMILY).fill(0);
  families.forEach((family, f) => {
    let familyVisible = 0;
    for (let lod = 0; lod < BUCKETS_PER_FAMILY; lod++) {
      const visible = values[f * BUCKETS_PER_FAMILY + lod] ?? 0;
      byLod[lod] = (byLod[lod] ?? 0) + visible;
      familyVisible += visible;
      triangles += visible * (family.lodChain?.triangles[lod] ?? IMPOSTOR_TRIANGLES);
    }
    bus.setGauge(`family.${family.key}.drawn`, familyVisible);
  });
  byLod.forEach((visible, lod) => {
    bus.setGauge(`lod.visible${lod}`, visible);
  });
  bus.setGauge('agents.visible', values[families.length * BUCKETS_PER_FAMILY] ?? 0);
  return triangles;
}
