/**
 * A benchmark scenario, fully described by the page URL so runs are reproducible and scriptable
 * (the Playwright matrix in step 0.11 only has to build URLs).
 *
 *   ?path=b&model=/models/Xbot.glb,/models/Soldier.glb&clip=walk&tris=1000&agents=500&sweep=100,500,1000,2000&warmup=2&measure=5&autorun=1
 */
export const RenderPathKind = {
  /** Step 0.1 clear pass: measures harness overhead with nothing drawn. */
  Idle: 'idle',
  /** Naive Three.js baseline: one SkinnedMesh and one AnimationMixer per character. */
  A: 'a',
  /** Baked animation, GPU dead reckoning and vertex skinning, one instanced draw per sub-mesh. */
  B: 'b',
  /** Path B's crowd in hand-written WebGPU: same buffers and kernels, one render bundle. */
  C: 'c',
  /** Q10: simulation → GPU transfer strategies, nothing drawn (step 0.10). */
  Transfer: 'transfer',
} as const;

export type RenderPathKind = (typeof RenderPathKind)[keyof typeof RenderPathKind];

import { LOD_FADE_MS, LodPreset, TEST_RIG_MODEL } from '@city/render';

export { TEST_RIG_MODEL };

/** Q10 transfer strategies (see paths/transfer-path.ts). */
export type TransferStrategy = 'full' | 'ranges' | 'events';

export interface Scenario {
  path: RenderPathKind;
  /**
   * Human base meshes: `test-rig`, or URLs of rigged GLBs (e.g. /models/Xbot.glb). Each agent
   * picks one by its record's variant bits (§4 bases).
   */
  models: string[];
  /** Clip name; undefined picks a walk-like loop. */
  clip: string | undefined;
  /** Simplify the character to about this many triangles (meshoptimizer); undefined = as authored. */
  tris: number | undefined;
  /** URL of a robot GLB (second skeleton family); undefined = humans only. */
  robot: string | undefined;
  /** Share of agents that are robots, 0–1. 1 loads robots only. */
  robotShare: number;
  robotClip: string | undefined;
  /** `authored` keeps the robot's skin weights; `rigid` collapses them to one bone per vertex. */
  robotSkin: 'authored' | 'rigid';
  /** Robot rest height in metres. */
  robotHeight: number;
  /** Agent count for interactive use. */
  agents: number;
  /** Agent counts measured by a sweep, in order. */
  sweep: number[];
  warmupMs: number;
  measureMs: number;
  /** Start the sweep as soon as the scene is ready. */
  autorun: boolean;
  /** Seed for per-character phase and placement jitter. */
  seed: number;
  /** Force one LOD for every agent (Path B), 5 = impostor; null = automatic. */
  lod: number | null;
  /** Draw far agents as impostors (step 0.8). */
  impostors: boolean;
  lodPreset: LodPreset;
  /** Tint agents by LOD. */
  lodColours: boolean;
  /** Dithered crossfade between LODs. */
  fade: boolean;
  /** Crossfade duration. */
  fadeMs: number;
  /** Seeded per-agent clothing, skin and hair tints and height (step 0.7). */
  tint: boolean;
  /** `crowd`: agents walk across the area; `lineup`: they stand in rows facing the camera. */
  layout: 'crowd' | 'lineup';
  /** Transfer path only. */
  strategy: TransferStrategy;
  /** Parameters that were present but invalid and fell back to defaults. */
  warnings: string[];
}

export const DEFAULT_SWEEP: readonly number[] = [100, 500, 1000, 2000];
export const MAX_AGENTS = 1_000_000;

export function parseScenario(search: string): Scenario {
  const params = new URLSearchParams(search);
  const warnings: string[] = [];

  const count = (name: string, fallback: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback;
    const value = Number(raw);
    if (Number.isInteger(value) && value >= 0 && value <= MAX_AGENTS) return value;
    warnings.push(`${name}=${raw} is not an agent count between 0 and ${MAX_AGENTS}`);
    return fallback;
  };

  const seconds = (name: string, fallback: number): number => {
    const raw = params.get(name);
    if (raw === null) return fallback * 1000;
    const value = Number(raw);
    if (Number.isFinite(value) && value > 0 && value <= 600) return value * 1000;
    warnings.push(`${name}=${raw} is not a duration between 0 and 600 seconds`);
    return fallback * 1000;
  };

  const rawPath = params.get('path')?.toLowerCase() ?? RenderPathKind.B;
  const kinds: readonly string[] = Object.values(RenderPathKind);
  let path: RenderPathKind = RenderPathKind.B;
  if (kinds.includes(rawPath)) path = rawPath as RenderPathKind;
  else warnings.push(`path=${rawPath} is not one of ${kinds.join(', ')}`);

  let sweep = [...DEFAULT_SWEEP];
  const rawSweep = params.get('sweep');
  if (rawSweep !== null) {
    const values = rawSweep.split(',').map((part) => Number(part.trim()));
    if (
      values.length > 0 &&
      values.every((v) => Number.isInteger(v) && v >= 0 && v <= MAX_AGENTS)
    ) {
      sweep = values;
    } else {
      warnings.push(`sweep=${rawSweep} is not a comma-separated list of agent counts`);
    }
  }

  let lod: number | null = null;
  const rawLod = params.get('lod');
  if (rawLod !== null && rawLod !== 'auto') {
    const value = rawLod === 'impostor' ? 5 : Number(rawLod);
    if (Number.isInteger(value) && value >= 0 && value <= 5) lod = value;
    else warnings.push(`lod=${rawLod} is not auto, 0–4 or impostor`);
  }

  let lodPreset: LodPreset = LodPreset.Brief;
  const rawPreset = params.get('lodPreset');
  const presets: readonly string[] = Object.values(LodPreset);
  if (rawPreset !== null) {
    if (presets.includes(rawPreset)) lodPreset = rawPreset as LodPreset;
    else warnings.push(`lodPreset=${rawPreset} is not one of ${presets.join(', ')}`);
  }

  const robot = params.get('robot') ?? undefined;
  let robotShare = robot === undefined ? 0 : 0.25;
  const rawShare = params.get('robots');
  if (rawShare !== null) {
    const value = Number(rawShare);
    if (Number.isFinite(value) && value >= 0 && value <= 1) robotShare = value;
    else warnings.push(`robots=${rawShare} is not a share between 0 and 1`);
  }
  let robotSkin: 'authored' | 'rigid' = 'authored';
  const rawSkin = params.get('robotSkin');
  if (rawSkin === 'rigid' || rawSkin === 'authored') robotSkin = rawSkin;
  else if (rawSkin !== null) warnings.push(`robotSkin=${rawSkin} is not authored or rigid`);
  let robotHeight = 1.75;
  const rawHeight = params.get('robotHeight');
  if (rawHeight !== null) {
    const value = Number(rawHeight);
    if (Number.isFinite(value) && value > 0.1 && value < 10) robotHeight = value;
    else warnings.push(`robotHeight=${rawHeight} is not a height in metres`);
  }

  const flag = (name: string, fallback: boolean): boolean => {
    const raw = params.get(name);
    return raw === null ? fallback : raw === '1' || raw === 'true';
  };

  return {
    path,
    models: (params.get('model') ?? TEST_RIG_MODEL)
      .split(',')
      .map((model) => model.trim())
      .filter((model) => model.length > 0),
    clip: params.get('clip') ?? undefined,
    tris: params.has('tris') ? count('tris', 0) || undefined : undefined,
    robot,
    robotShare,
    robotClip: params.get('robotClip') ?? undefined,
    robotSkin,
    robotHeight,
    agents: count('agents', 500),
    sweep,
    warmupMs: seconds('warmup', 2),
    measureMs: seconds('measure', 5),
    autorun: flag('autorun', false),
    seed: count('seed', 1),
    lod,
    impostors: flag('impostors', true),
    lodPreset,
    lodColours: flag('lodColours', false),
    fade: flag('fade', true),
    fadeMs: params.has('fadeMs') ? count('fadeMs', LOD_FADE_MS) : LOD_FADE_MS,
    tint: flag('tint', true),
    layout: params.get('layout') === 'lineup' ? 'lineup' : 'crowd',
    strategy: strategy(params.get('strategy'), warnings),
    warnings,
  };
}

function strategy(raw: string | null, warnings: string[]): TransferStrategy {
  if (raw === null || raw === 'events') return 'events';
  if (raw === 'full' || raw === 'ranges') return raw;
  warnings.push(`strategy=${raw} is not full, ranges or events`);
  return 'events';
}
