import { describe, expect, it } from 'vitest';
import { appearanceFromSeed, hash32, HUMAN_HEIGHT_VARIATION, PALETTES } from './appearance.ts';

describe('hash32', () => {
  it('is deterministic, 32-bit and well mixed', () => {
    expect(hash32(1)).toBe(hash32(1));
    expect(hash32(0xffffffff)).toBeLessThanOrEqual(0xffffffff);
    expect(hash32(1)).not.toBe(hash32(2));
    // Neighbouring seeds should differ in about half their bits.
    const bits = (hash32(1000) ^ hash32(1001)).toString(2).replace(/0/g, '').length;
    expect(bits).toBeGreaterThan(8);
  });

  it('maps 0 to 0, as lowbias32 does', () => {
    expect(hash32(0)).toBe(0);
  });
});

describe('appearanceFromSeed', () => {
  it('stays inside every palette and the height band', () => {
    for (let seed = 0; seed < 5000; seed++) {
      const a = appearanceFromSeed(seed * 2654435761, HUMAN_HEIGHT_VARIATION);
      expect(a.top).toBeLessThan(PALETTES.top.length);
      expect(a.bottoms).toBeLessThan(PALETTES.bottoms.length);
      expect(a.skin).toBeLessThan(PALETTES.skin.length);
      expect(a.hair).toBeLessThan(PALETTES.hair.length);
      expect(a.scale).toBeGreaterThanOrEqual(1 - HUMAN_HEIGHT_VARIATION);
      expect(a.scale).toBeLessThanOrEqual(1 + HUMAN_HEIGHT_VARIATION);
    }
  });

  it('uses every palette entry across a crowd', () => {
    const seen = { top: new Set(), bottoms: new Set(), skin: new Set(), hair: new Set() };
    for (let seed = 0; seed < 2000; seed++) {
      const a = appearanceFromSeed(seed, 0);
      seen.top.add(a.top);
      seen.bottoms.add(a.bottoms);
      seen.skin.add(a.skin);
      seen.hair.add(a.hair);
    }
    expect(seen.top.size).toBe(PALETTES.top.length);
    expect(seen.bottoms.size).toBe(PALETTES.bottoms.length);
    expect(seen.skin.size).toBe(PALETTES.skin.length);
    expect(seen.hair.size).toBe(PALETTES.hair.length);
  });

  it('does not vary height when the family has no variation', () => {
    expect(appearanceFromSeed(123, 0).scale).toBe(1);
  });
});
