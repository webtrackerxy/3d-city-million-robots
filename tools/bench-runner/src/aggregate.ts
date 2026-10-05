/**
 * Aggregation of repeated matrix runs. The shapes below are the subset of the app's
 * `city-benchmark/2` result the report needs (tools may not import app code).
 */
export interface Stats {
  count: number;
  /** Mean frame interval: the throughput measure (1000 / fps). */
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface StepLite {
  agents: number;
  fps: number;
  intervalMs: Stats;
  cpuMs: Stats;
  gpuMs: Stats | null;
  drawCalls: number;
  triangles: number;
  gpuBytes: number;
  lodVisible: number[] | null;
  extras?: Record<string, Stats>;
}

export interface ResultLite {
  schema: string;
  userAgent: string;
  canvas: { width: number; height: number };
  adapter: { vendor: string; architecture: string };
  steps: StepLite[];
}

export interface RunRecord {
  entryId: string;
  repetition: number;
  url: string;
  /** 1-minute load average before and after the run. */
  loadBefore: number;
  loadAfter: number;
  wallMs: number;
  result: ResultLite | null;
  error?: string;
}

/** Median and range of one metric across repetitions. */
export interface Spread {
  median: number;
  min: number;
  max: number;
  n: number;
}

export interface AggregatedStep {
  agents: number;
  fps: Spread;
  frameMs: Spread;
  cpuMs: Spread;
  gpuMs: Spread | null;
  triangles: Spread;
  drawCalls: number;
  gpuBytes: Spread;
  lodVisible: number[] | null;
  /** Median across repetitions of each extra's per-run mean. */
  extras: Record<string, Spread>;
}

export function spread(values: readonly number[]): Spread | null {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { median, min: sorted[0] ?? 0, max: sorted[sorted.length - 1] ?? 0, n: sorted.length };
}

/** Groups successful runs by entry and aggregates each agent count across repetitions. */
export function aggregate(runs: readonly RunRecord[]): Map<string, AggregatedStep[]> {
  const byEntry = new Map<string, StepLite[][]>();
  for (const run of runs) {
    if (run.result === null) continue;
    const list = byEntry.get(run.entryId) ?? [];
    list.push(run.result.steps);
    byEntry.set(run.entryId, list);
  }
  const out = new Map<string, AggregatedStep[]>();
  for (const [entryId, repetitions] of byEntry) {
    const counts = [...new Set(repetitions.flat().map((step) => step.agents))].sort(
      (a, b) => a - b,
    );
    out.set(
      entryId,
      counts.map((agents) => {
        const steps = repetitions
          .map((steps) => steps.find((step) => step.agents === agents))
          .filter((step): step is StepLite => step !== undefined);
        const of = (pick: (step: StepLite) => number) => spread(steps.map(pick)) ?? empty();
        const gpu = spread(steps.map((step) => step.gpuMs?.p50 ?? Number.NaN));
        const extraNames = [...new Set(steps.flatMap((step) => Object.keys(step.extras ?? {})))];
        return {
          agents,
          fps: of((step) => step.fps),
          // Mean, not median: frame intervals of GPU-saturated uncapped runs can be bimodal, and
          // only the mean reflects throughput.
          frameMs: of((step) => step.intervalMs.mean),
          cpuMs: of((step) => step.cpuMs.p50),
          gpuMs: gpu,
          triangles: of((step) => step.triangles),
          drawCalls: steps[0]?.drawCalls ?? 0,
          gpuBytes: of((step) => step.gpuBytes),
          lodVisible: medianVector(steps.map((step) => step.lodVisible)),
          extras: Object.fromEntries(
            extraNames.map((name) => [
              name,
              spread(steps.map((step) => step.extras?.[name]?.mean ?? Number.NaN)) ?? empty(),
            ]),
          ),
        };
      }),
    );
  }
  return out;
}

/**
 * GPU memory per additional agent: the slope of tracked GPU bytes between the smallest and
 * largest agent counts of a sweep (fixed costs such as atlases and bone matrices cancel).
 */
export function bytesPerAgent(steps: readonly AggregatedStep[]): number | null {
  if (steps.length < 2) return null;
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first === undefined || last === undefined || last.agents === first.agents) return null;
  return (last.gpuBytes.median - first.gpuBytes.median) / (last.agents - first.agents);
}

/** Largest agent count whose median frame rate reaches `fps`. */
export function maxAgentsAt(steps: readonly AggregatedStep[], fps: number): number | null {
  let best: number | null = null;
  for (const step of steps) if (step.fps.median >= fps) best = Math.max(best ?? 0, step.agents);
  return best;
}

function medianVector(vectors: readonly (number[] | null)[]): number[] | null {
  const present = vectors.filter((v): v is number[] => v !== null);
  if (present.length === 0) return null;
  const length = Math.max(...present.map((v) => v.length));
  return Array.from({ length }, (_, i) => spread(present.map((v) => v[i] ?? 0))?.median ?? 0);
}

function empty(): Spread {
  return { median: Number.NaN, min: Number.NaN, max: Number.NaN, n: 0 };
}
