import { describe, expect, it } from 'vitest';
import { type FrameSample, SweepRunner } from './sweep-runner.ts';

const memory = { gpuBytes: () => 1234, jsHeapBytes: () => null, lodVisible: () => [1, 2, 3, 4, 5] };
const sample = (intervalMs: number): FrameSample => ({
  intervalMs,
  cpuMs: intervalMs / 4,
  animMs: 1,
  drawCalls: 7,
  triangles: 99,
  extras: { uploadBytes: intervalMs * 100 },
});

/** Drives the runner at a fixed frame interval until it asks for a new count or finishes. */
function run(runner: SweepRunner, start: number, frameMs: number, frames: number) {
  const switches: number[] = [];
  let now = start;
  for (let i = 0; i < frames; i++) {
    now += frameMs;
    const next = runner.frame(now, sample(frameMs));
    if (next !== undefined) switches.push(next);
  }
  return { switches, now };
}

describe('SweepRunner', () => {
  it('warms up, measures and then advances through every count', () => {
    const runner = new SweepRunner([100, 500], { warmupMs: 100, measureMs: 200 }, memory);
    expect(runner.start(0)).toBe(100);
    expect(runner.progress()).toMatchObject({ phase: 'warmup', step: 0, steps: 2 });

    const { switches } = run(runner, 0, 10, 100);
    expect(switches).toEqual([500]);
    expect(runner.progress().phase).toBe('done');

    const [first, second] = runner.completed();
    expect(first?.agents).toBe(100);
    expect(second?.agents).toBe(500);
    // 200 ms at 10 ms/frame, with the frame that closes the window included.
    expect(first?.frames).toBe(20);
    expect(first?.fps).toBeCloseTo(100, 6);
    expect(first?.cpuMs.p50).toBeCloseTo(2.5, 6);
    expect(first).toMatchObject({
      drawCalls: 7,
      triangles: 99,
      gpuBytes: 1234,
      jsHeapBytes: null,
      lodVisible: [1, 2, 3, 4, 5],
    });
    expect(first?.extras.uploadBytes?.mean).toBeCloseTo(1000, 6);
  });

  it('ignores warmup frames and GPU samples outside the measure window', () => {
    const runner = new SweepRunner([1], { warmupMs: 50, measureMs: 50 }, memory);
    runner.start(0);
    runner.gpuSample(999); // warmup
    runner.frame(10, sample(1000));
    runner.frame(60, sample(1000)); // ends warmup
    runner.gpuSample(2);
    runner.gpuSample(4);
    runner.frame(80, sample(20));
    runner.frame(110, sample(30));
    runner.gpuSample(999); // after done

    const [result] = runner.completed();
    expect(result?.frames).toBe(2);
    expect(result?.intervalMs.max).toBe(30);
    expect(result?.gpuMs?.mean).toBe(3);
  });

  it('reports null GPU timing when none arrived', () => {
    const runner = new SweepRunner([1], { warmupMs: 0, measureMs: 10 }, memory);
    runner.start(0);
    run(runner, 0, 5, 5);
    expect(runner.completed()[0]?.gpuMs).toBeNull();
  });

  it('rejects an empty sweep', () => {
    expect(() => new SweepRunner([], { warmupMs: 0, measureMs: 0 }, memory)).toThrow(RangeError);
  });
});
