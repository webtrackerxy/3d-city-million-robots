import { hash32, heightScaleFromSeed } from '@city/core-types';
import { Color } from 'three';

export { hash32 };

/**
 * Per-agent appearance from the record's 32-bit seed (implementation plan §4, step 0.7). CPU
 * reference for the GPU functions in paths/gpu-crowd.ts, which must derive the same values.
 *
 * Tint channels follow the ID-mask convention of §4: R top, G bottoms, B skin, A hair.
 */

/** sRGB hex, converted to linear once at module load. */
const TOPS = [
  0x1f2a44, 0x3a3a3c, 0xe8e6e1, 0xa4262c, 0xd9a520, 0x1f7a7a, 0x5b6b2f, 0x6d1f3b, 0x7fb3d5,
  0x151515, 0xd98fa6, 0xd4652f,
];
const BOTTOMS = [0x2e4a6b, 0x1a1a1a, 0x6e6e6e, 0xb8a47e, 0x1c2640, 0x5a3e2b, 0x4d5530, 0xe3dcc8];
const SKIN = [0xf6d3bd, 0xe8b996, 0xd29f7a, 0xb57d59, 0x8d5a3b, 0x6b4028, 0x4a2c1c, 0xf1c6a6];
const HAIR = [0x0f0d0c, 0x2b1d14, 0x5a3a22, 0x7b3a1d, 0xc9a86a, 0x8f8b86, 0xd8d4cc, 0xa04a24];

export const PALETTES = {
  top: TOPS.map(linear),
  bottoms: BOTTOMS.map(linear),
  skin: SKIN.map(linear),
  hair: HAIR.map(linear),
} as const;

/** Humans vary ±8% around their base mesh height; robots do not vary. */
export const HUMAN_HEIGHT_VARIATION = 0.08;

export interface Appearance {
  top: number;
  bottoms: number;
  skin: number;
  hair: number;
  /** Multiplier on the base mesh, 1 ± variation. */
  scale: number;
}

export function appearanceFromSeed(seed: number, heightVariation: number): Appearance {
  const h0 = hash32(seed);
  const h1 = hash32(h0);
  const h2 = hash32(h1);
  const h3 = hash32(h2);
  return {
    top: h0 % PALETTES.top.length,
    bottoms: h1 % PALETTES.bottoms.length,
    skin: h2 % PALETTES.skin.length,
    hair: h3 % PALETTES.hair.length,
    scale: heightScaleFromSeed(seed, heightVariation),
  };
}

function linear(hex: number): [number, number, number] {
  const c = new Color().setHex(hex); // sRGB input → linear working space
  return [c.r, c.g, c.b];
}
