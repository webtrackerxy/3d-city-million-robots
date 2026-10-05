import { MESH_LOD_COUNT } from '@city/core-types';

/**
 * Geometry LOD selection (implementation plan §17). CPU reference for the GPU `cullLod` kernel in
 * paths/gpu-crowd.ts; the two must implement the same rules.
 *
 * LOD is chosen by projected height in pixels, not by distance, so field of view, resolution and
 * agent height are all accounted for:  h = heightM · pxPerRadian / distanceM.
 */

/** Pixel heights below which LOD k+1 takes over from LOD k (k = 0..3). Descending. */
export type LodThresholds = readonly [number, number, number, number];

export const LodPreset = {
  /** The brief's distance bands (0–15–40–100–250 m) at 1080p / 60°. */
  Brief: 'brief',
  /** About one pixel per triangle: switch where each LOD's triangles become sub-pixel. */
  Density: 'density',
} as const;

export type LodPreset = (typeof LodPreset)[keyof typeof LodPreset];

export const LOD_THRESHOLDS: Record<LodPreset, LodThresholds> = {
  [LodPreset.Brief]: [124, 46, 18, 7],
  [LodPreset.Density]: [168, 120, 73, 37],
};

/**
 * Below this projected height agents are drawn as impostors (§17). Brief: just under its LOD4
 * band. Density: ~20 px ≈ 84 m for a 1.8 m person at 1080p / 60°, where the plan expects
 * impostors to take over (80–120 m).
 */
export const IMPOSTOR_THRESHOLD: Record<LodPreset, number> = {
  [LodPreset.Brief]: 5,
  [LodPreset.Density]: 20,
};

/** Human triangle targets per LOD, from the §17 table (LOD0 15–30k … LOD4 200–500). */
export const HUMAN_LOD_TRIANGLES = [24_000, 10_000, 4_000, 1_000, 350] as const;

/** Robot triangle targets per LOD (§17: LOD0 100–150k … LOD4 500–1k). */
export const ROBOT_LOD_TRIANGLES = [120_000, 50_000, 15_000, 3_500, 750] as const;

/** ±10% band around every threshold so agents near one do not flicker between LODs. */
export const LOD_HYSTERESIS = 0.1;

/** Duration of the dithered crossfade between two LODs. */
export const LOD_FADE_MS = 300;

/** Sentinel for "no LOD chosen yet" (a fresh agent). */
export const LOD_NONE = -1;

export function pxPerRadian(viewportHeightPx: number, fovYRadians: number): number {
  return viewportHeightPx / (2 * Math.tan(fovYRadians / 2));
}

export function projectedHeightPx(heightM: number, distanceM: number, pxPerRad: number): number {
  return (heightM * pxPerRad) / Math.max(distanceM, 0.1);
}

/** LOD whose band contains `heightPx`, ignoring hysteresis. */
export function lodForHeight(heightPx: number, thresholds: LodThresholds): number {
  let lod = 0;
  for (const threshold of thresholds) if (heightPx < threshold) lod++;
  return lod;
}

/**
 * Hysteresis: moving to a finer LOD needs the agent 10% larger than the threshold, moving to a
 * coarser one needs it 10% smaller. In between, the current LOD is kept.
 */
export function nextLod(current: number, heightPx: number, thresholds: LodThresholds): number {
  if (current === LOD_NONE) return lodForHeight(heightPx, thresholds);
  const finer = lodForHeight(heightPx / (1 + LOD_HYSTERESIS), thresholds);
  if (finer < current) return finer;
  const coarser = lodForHeight(heightPx * (1 + LOD_HYSTERESIS), thresholds);
  if (coarser > current) return coarser;
  return current;
}

export interface LodState {
  current: number;
  previous: number;
  fadeStartMs: number;
}

export interface LodOptions {
  thresholds: LodThresholds;
  /** Force every agent to one LOD (debug toggle); null = automatic. */
  forced: number | null;
  /** 0 disables the crossfade: LOD switches are instant. */
  fadeMs: number;
}

export interface LodStep {
  state: LodState;
  /** Crossfade progress, 0 → 1. 1 when not fading. */
  fade: number;
  /** Buckets this agent is drawn in this frame; `outgoing` draws the complementary dither. */
  draws: { lod: number; outgoing: boolean }[];
}

export function stepLod(
  state: LodState,
  heightPx: number,
  nowMs: number,
  options: LodOptions,
): LodStep {
  const target =
    options.forced !== null
      ? Math.min(Math.max(options.forced, 0), MESH_LOD_COUNT - 1)
      : nextLod(state.current, heightPx, options.thresholds);

  let { current, previous, fadeStartMs } = state;
  if (current === LOD_NONE) {
    current = target;
    previous = target;
  } else if (target !== current) {
    previous = current;
    current = target;
    fadeStartMs = nowMs;
  }

  const elapsed = (nowMs - fadeStartMs) >>> 0;
  const fading = options.fadeMs > 0 && previous !== current && elapsed < options.fadeMs;
  if (!fading) previous = current;
  const fade = fading ? elapsed / options.fadeMs : 1;

  const draws = [{ lod: current, outgoing: false }];
  if (fading) draws.push({ lod: previous, outgoing: true });
  return { state: { current, previous, fadeStartMs }, fade, draws };
}

/**
 * Screen-door crossfade: at progress `fade`, the incoming LOD keeps the pixels whose noise value
 * is below `fade` and the outgoing LOD keeps the rest, so every pixel is drawn exactly once.
 */
export function keepsPixel(noise: number, fade: number, outgoing: boolean): boolean {
  return outgoing ? noise >= fade : noise < fade;
}

/** Debug controls for GPU LOD selection. */
export interface LodControls {
  /** Draw every agent at this LOD (5 = impostor); null = automatic by projected height. */
  forced: number | null;
  /** Use impostors below the preset's impostor threshold. */
  impostors: boolean;
  preset: LodPreset;
  /** Tint each LOD with RENDER_LOD_DEBUG_COLOURS. */
  debugColours: boolean;
  /** Dithered crossfade between LODs; off = instant switches. */
  fade: boolean;
  fadeMs: number;
}
