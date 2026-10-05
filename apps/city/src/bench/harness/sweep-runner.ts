import { type SeriesStats, summarise } from '@city/metrics';

export interface FrameSample {
  intervalMs: number;
  cpuMs: number;
  animMs: number;
  drawCalls: number;
  triangles: number;
  extras?: Record<string, number>;
}

export interface StepResult {
  agents: number;
  frames: number;
  /** Mean frames per second over the measurement window (display-capped unless unthrottled). */
  fps: number;
  intervalMs: SeriesStats;
  cpuMs: SeriesStats;
  animMs: SeriesStats;
  /** Null when the device has no timestamp-query support. */
  gpuMs: SeriesStats | null;
  drawCalls: number;
  triangles: number;
  gpuBytes: number;
  jsHeapBytes: number | null;
  /** Agents drawn at each LOD (last GPU readback of the step); null for paths without GPU LOD. */
  lodVisible: number[] | null;
  /** Path-specific per-frame measurements over the window (see PathFrameStats.extras). */
  extras: Record<string, SeriesStats>;
}

export type SweepPhase = 'warmup' | 'measure' | 'done';

export interface SweepProgress {
  phase: SweepPhase;
  step: number;
  steps: number;
  agents: number;
}

export interface SweepTiming {
  warmupMs: number;
  measureMs: number;
}

export interface MemoryProbe {
  gpuBytes(): number;
  jsHeapBytes(): number | null;
  lodVisible(): number[] | null;
}

/**
 * Walks a list of agent counts: for each, waits `warmupMs` (pipeline compilation, GC settling),
 * then records every frame for `measureMs`. Pure bookkeeping — the engine applies the agent count
 * this returns and feeds it frames, so it runs unchanged in unit tests.
 */
export class SweepRunner {
  private readonly counts: readonly number[];
  private readonly timing: SweepTiming;
  private readonly memory: MemoryProbe;
  private readonly results: StepResult[] = [];
  private step = 0;
  private phase: SweepPhase = 'warmup';
  private phaseStart = 0;
  private frames: FrameSample[] = [];
  private gpuSamples: number[] = [];

  constructor(counts: readonly number[], timing: SweepTiming, memory: MemoryProbe) {
    if (counts.length === 0) throw new RangeError('A sweep needs at least one agent count');
    this.counts = counts;
    this.timing = timing;
    this.memory = memory;
  }

  /** Returns the agent count to apply for the first step. */
  start(now: number): number {
    this.phaseStart = now;
    return this.currentCount();
  }

  /**
   * Feeds one completed frame. Returns the agent count to apply before the next frame when the
   * sweep moves to a new step, otherwise undefined.
   */
  frame(now: number, sample: FrameSample): number | undefined {
    if (this.phase === 'done') return undefined;

    if (this.phase === 'warmup') {
      if (now - this.phaseStart >= this.timing.warmupMs) {
        this.phase = 'measure';
        this.phaseStart = now;
        this.frames = [];
        this.gpuSamples = [];
      }
      return undefined;
    }

    this.frames.push(sample);
    if (now - this.phaseStart < this.timing.measureMs) return undefined;

    this.results.push(this.finishStep());
    this.step++;
    if (this.step >= this.counts.length) {
      this.phase = 'done';
      return undefined;
    }
    this.phase = 'warmup';
    this.phaseStart = now;
    return this.currentCount();
  }

  /** GPU timings arrive asynchronously; only those landing inside a measure window count. */
  gpuSample(ms: number): void {
    if (this.phase === 'measure') this.gpuSamples.push(ms);
  }

  progress(): SweepProgress {
    return {
      phase: this.phase,
      step: Math.min(this.step, this.counts.length - 1),
      steps: this.counts.length,
      agents: this.currentCount(),
    };
  }

  completed(): readonly StepResult[] {
    return this.results;
  }

  private currentCount(): number {
    return this.counts[Math.min(this.step, this.counts.length - 1)] ?? 0;
  }

  private finishStep(): StepResult {
    const frames = this.frames;
    const intervalMs = summarise(frames.map((f) => f.intervalMs));
    const last = frames[frames.length - 1];
    return {
      agents: this.currentCount(),
      frames: frames.length,
      fps: intervalMs.mean > 0 ? 1000 / intervalMs.mean : 0,
      intervalMs,
      cpuMs: summarise(frames.map((f) => f.cpuMs)),
      animMs: summarise(frames.map((f) => f.animMs)),
      gpuMs: this.gpuSamples.length > 0 ? summarise(this.gpuSamples) : null,
      drawCalls: last?.drawCalls ?? 0,
      triangles: last?.triangles ?? 0,
      gpuBytes: this.memory.gpuBytes(),
      jsHeapBytes: this.memory.jsHeapBytes(),
      lodVisible: this.memory.lodVisible(),
      extras: summariseExtras(frames),
    };
  }
}

function summariseExtras(frames: readonly FrameSample[]): Record<string, SeriesStats> {
  const values = new Map<string, number[]>();
  for (const frame of frames) {
    for (const [name, value] of Object.entries(frame.extras ?? {})) {
      const list = values.get(name) ?? [];
      list.push(value);
      values.set(name, list);
    }
  }
  return Object.fromEntries([...values].map(([name, list]) => [name, summarise(list)]));
}
