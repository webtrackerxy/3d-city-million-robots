import { describe, expect, it } from 'vitest';
import {
  keepsPixel,
  LOD_FADE_MS,
  LOD_NONE,
  LOD_THRESHOLDS,
  type LodOptions,
  lodForHeight,
  LodPreset,
  nextLod,
  projectedHeightPx,
  pxPerRadian,
  stepLod,
} from './lod-policy.ts';

const brief = LOD_THRESHOLDS[LodPreset.Brief];
const auto: LodOptions = { thresholds: brief, forced: null, fadeMs: LOD_FADE_MS };

describe('projected height', () => {
  it('matches the §17 table: a 1.8 m person at 15 m on 1080p / 60° is ~112 px', () => {
    const ppr = pxPerRadian(1080, Math.PI / 3);
    expect(ppr).toBeCloseTo(935.3, 1);
    expect(projectedHeightPx(1.8, 15, ppr)).toBeCloseTo(112.2, 1);
  });

  it('never divides by zero', () => {
    expect(Number.isFinite(projectedHeightPx(1.8, 0, 900))).toBe(true);
  });
});

describe('lodForHeight', () => {
  it('maps pixel heights to bands', () => {
    expect(lodForHeight(500, brief)).toBe(0);
    expect(lodForHeight(124, brief)).toBe(0);
    expect(lodForHeight(123, brief)).toBe(1);
    expect(lodForHeight(20, brief)).toBe(2);
    expect(lodForHeight(10, brief)).toBe(3);
    expect(lodForHeight(1, brief)).toBe(4);
  });
});

describe('nextLod hysteresis', () => {
  it('picks the plain band for a fresh agent', () => {
    expect(nextLod(LOD_NONE, 120, brief)).toBe(1);
  });

  it('holds the current LOD inside the ±10% band around a threshold', () => {
    expect(nextLod(1, 130, brief)).toBe(1); // above 124, below 136.4
    expect(nextLod(0, 115, brief)).toBe(0); // below 124, above 112.7
  });

  it('switches once the agent is clearly past the threshold', () => {
    expect(nextLod(1, 140, brief)).toBe(0);
    expect(nextLod(0, 110, brief)).toBe(1);
    expect(nextLod(0, 3, brief)).toBe(4);
  });
});

describe('stepLod', () => {
  const fresh = { current: LOD_NONE, previous: LOD_NONE, fadeStartMs: 0 };

  it('initialises without a fade', () => {
    const step = stepLod(fresh, 200, 1000, auto);
    expect(step.state.current).toBe(0);
    expect(step.fade).toBe(1);
    expect(step.draws).toEqual([{ lod: 0, outgoing: false }]);
  });

  it('crossfades for LOD_FADE_MS, drawing both LODs, then settles', () => {
    const settled = stepLod(fresh, 200, 1000, auto).state;
    const switched = stepLod(settled, 60, 2000, auto);
    expect(switched.state).toEqual({ current: 1, previous: 0, fadeStartMs: 2000 });
    expect(switched.draws).toEqual([
      { lod: 1, outgoing: false },
      { lod: 0, outgoing: true },
    ]);
    expect(switched.fade).toBe(0);

    const half = stepLod(switched.state, 60, 2000 + LOD_FADE_MS / 2, auto);
    expect(half.fade).toBeCloseTo(0.5, 6);
    expect(half.draws).toHaveLength(2);

    const done = stepLod(half.state, 60, 2000 + LOD_FADE_MS, auto);
    expect(done.draws).toEqual([{ lod: 1, outgoing: false }]);
    expect(done.state.previous).toBe(1);
  });

  it('switches instantly with the fade disabled', () => {
    const settled = stepLod(fresh, 200, 1000, auto).state;
    const step = stepLod(settled, 60, 2000, { ...auto, fadeMs: 0 });
    expect(step.draws).toEqual([{ lod: 1, outgoing: false }]);
  });

  it('obeys a forced LOD regardless of size', () => {
    const step = stepLod(fresh, 1000, 0, { ...auto, forced: 3 });
    expect(step.state.current).toBe(3);
    expect(stepLod(fresh, 1, 0, { ...auto, forced: 99 }).state.current).toBe(4);
  });
});

describe('keepsPixel', () => {
  it('assigns every pixel to exactly one of the two LODs', () => {
    for (const fade of [0, 0.25, 0.5, 0.99]) {
      for (let n = 0; n < 1; n += 0.05) {
        expect(keepsPixel(n, fade, false) !== keepsPixel(n, fade, true)).toBe(true);
      }
    }
  });
});
