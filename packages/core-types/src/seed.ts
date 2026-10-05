/**
 * Per-agent values derived from the record's 32-bit seed. Shared by the simulation (which needs
 * the height scale to keep the walk cycle continuous across records) and the renderer's GPU
 * functions, which must derive the same values.
 */

/** lowbias32 (Chris Wellons): a well-mixed 32-bit integer hash that WGSL can do in u32. */
export function hash32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

/** Height multiplier 1 ± variation: the fifth chained hash of the seed. */
export function heightScaleFromSeed(seed: number, heightVariation: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < 5; i++) h = hash32(h);
  return 1 + heightVariation * (2 * (h / 0x100000000) - 1);
}
