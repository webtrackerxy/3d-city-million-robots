/**
 * The Stage 0 benchmark matrix (implementation plan §I.5, step 0.11). Every entry is a URL of the
 * benchmark app plus the plan questions (§I.2) it answers. `capped` entries run at display rate
 * (60 Hz) because their per-frame numbers only mean something at a real frame rate; all others
 * run with the frame-rate limit off.
 */
export interface MatrixEntry {
  id: string;
  title: string;
  questions: string[];
  params: Record<string, string>;
  capped?: boolean;
}

const XBOT = '/models/Xbot.glb';
const BASES = '/models/Xbot.glb,/models/Soldier.glb';
const ROBOT = '/models/RobotExpressive.glb';

export const MATRIX: readonly MatrixEntry[] = [
  {
    id: 'idle',
    title: 'Harness floor (clear pass only)',
    questions: [],
    params: { path: 'idle', sweep: '0' },
  },
  {
    id: 'a-testrig',
    title: 'Path A, 3-bone test rig',
    questions: ['Q1', 'Q5'],
    params: { path: 'a', model: 'test-rig', sweep: '100,500,1000,2000' },
  },
  {
    id: 'a-xbot',
    title: 'Path A, X Bot at ~1k triangles',
    questions: ['Q1', 'Q5'],
    params: { path: 'a', model: XBOT, tris: '1000', sweep: '100,500,1000' },
  },
  {
    id: 'b-xbot-1k',
    title: 'Path B, X Bot at ~1k triangles, one LOD',
    questions: ['Q1', 'Q5'],
    params: {
      path: 'b',
      model: XBOT,
      tris: '1000',
      lod: '0',
      impostors: '0',
      sweep: '1000,10000,50000',
    },
  },
  {
    id: 'b-brief',
    title: 'Path B, 2 bases, tints, brief LOD preset',
    questions: ['Q3', 'Q4', 'Q5', 'Q6', 'Q7'],
    params: { path: 'b', model: BASES, lodPreset: 'brief', sweep: '10000,100000,1000000' },
  },
  {
    id: 'b-density',
    title: 'Path B, 2 bases, tints, density LOD preset',
    questions: ['Q5', 'Q6', 'Q7'],
    params: { path: 'b', model: BASES, lodPreset: 'density', sweep: '10000,100000,1000000' },
  },
  {
    id: 'b-lod0',
    title: 'Path B, all agents forced to LOD0 (skinning cost)',
    questions: ['Q9'],
    params: { path: 'b', model: BASES, lod: '0', sweep: '2000,10000' },
    // GPU-saturated below 60 fps: an uncapped frame loop decouples from the GPU and mis-measures.
    capped: true,
  },
  {
    id: 'b-robots-authored',
    title: 'Path B, robots only, authored skin, forced LOD0',
    questions: ['Q2', 'Q9'],
    params: { path: 'b', robot: ROBOT, robots: '1', lod: '0', sweep: '20000' },
  },
  {
    id: 'b-robots-rigid',
    title: 'Path B, robots only, rigid 1-influence skin, forced LOD0',
    questions: ['Q2', 'Q9'],
    params: { path: 'b', robot: ROBOT, robots: '1', robotSkin: 'rigid', lod: '0', sweep: '20000' },
  },
  {
    id: 'b-mixed',
    title: 'Path B, 2 human bases + 25% robots, density preset',
    questions: ['Q2', 'Q5'],
    params: {
      path: 'b',
      model: BASES,
      robot: ROBOT,
      robots: '0.25',
      lodPreset: 'density',
      sweep: '100000,1000000',
    },
  },
  {
    id: 'c-brief',
    title: 'Path C (raw WebGPU), brief preset',
    questions: ['§30'],
    params: { path: 'c', model: BASES, lodPreset: 'brief', sweep: '10000,100000' },
  },
  {
    id: 'c-density',
    title: 'Path C (raw WebGPU), density preset',
    questions: ['§30'],
    params: { path: 'c', model: BASES, lodPreset: 'density', sweep: '100000,1000000' },
  },
  {
    id: 'c-lod0',
    title: 'Path C (raw WebGPU), forced LOD0',
    questions: ['§30', 'Q9'],
    params: { path: 'c', model: BASES, lod: '0', sweep: '2000,10000' },
    // GPU-saturated below 60 fps: an uncapped frame loop decouples from the GPU and mis-measures.
    capped: true,
  },
  ...(['full', 'ranges', 'events'] as const).map((strategy) => ({
    id: `transfer-${strategy}`,
    title: `Simulation → GPU transfer: ${strategy} (60 Hz)`,
    questions: ['Q10'],
    params: { path: 'transfer', strategy, sweep: '10000,100000,1000000', warmup: '4' },
    capped: true,
  })),
];

/** Scenario URL for an entry; every run measures 5 s after a 2 s warm-up unless overridden. */
export function entryUrl(origin: string, entry: MatrixEntry): string {
  const params = new URLSearchParams({
    warmup: '2',
    measure: '5',
    seed: '1',
    ...entry.params,
    autorun: '1',
  });
  return `${origin}/bench?${params.toString()}`;
}
