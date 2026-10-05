import { describe, expect, it } from 'vitest';
import {
  aggregate,
  bytesPerAgent,
  maxAgentsAt,
  type RunRecord,
  spread,
  type StepLite,
} from './aggregate.ts';

const stats = (p50: number) => ({ count: 10, mean: p50, p50, p95: p50 * 1.2, max: p50 * 1.5 });

it('uses the mean frame interval as frame time', () => {
  const bimodal = {
    ...step(10, 24, 0),
    intervalMs: { count: 10, mean: 24, p50: 10, p95: 47, max: 50 },
  };
  expect(aggregate([run(1, [bimodal])]).get('b')?.[0]?.frameMs.median).toBe(24);
});
const step = (agents: number, frameMs: number, gpuBytes: number): StepLite => ({
  agents,
  fps: 1000 / frameMs,
  intervalMs: stats(frameMs),
  cpuMs: stats(frameMs / 2),
  gpuMs: stats(frameMs * 0.9),
  drawCalls: 12,
  triangles: agents * 100,
  gpuBytes,
  lodVisible: [agents, 0, 0, 0, 0, 0],
  extras: { uploadBytes: stats(agents) },
});
const run = (repetition: number, steps: StepLite[], entryId = 'b'): RunRecord => ({
  entryId,
  repetition,
  url: '',
  loadBefore: 1,
  loadAfter: 1,
  wallMs: 1,
  result: {
    schema: 'city-benchmark/2',
    userAgent: '',
    canvas: { width: 1, height: 1 },
    adapter: { vendor: 'x', architecture: 'y' },
    steps,
  },
});

describe('spread', () => {
  it('takes the median and range, ignoring non-finite values', () => {
    expect(spread([3, 1, 2])).toEqual({ median: 2, min: 1, max: 3, n: 3 });
    expect(spread([4, 1, Number.NaN, 2, 3])).toEqual({ median: 2.5, min: 1, max: 4, n: 4 });
    expect(spread([])).toBeNull();
  });
});

describe('aggregate', () => {
  it('aggregates each agent count across repetitions and skips failed runs', () => {
    const runs = [
      run(1, [step(100, 10, 1000), step(1000, 20, 5000)]),
      run(2, [step(100, 12, 1000), step(1000, 18, 5000)]),
      run(3, [step(100, 11, 1000), step(1000, 30, 5000)]),
      { ...run(4, []), result: null, error: 'timeout' },
    ];
    const steps = aggregate(runs).get('b') ?? [];
    expect(steps.map((s) => s.agents)).toEqual([100, 1000]);
    expect(steps[1]?.frameMs).toEqual({ median: 20, min: 18, max: 30, n: 3 });
    expect(steps[0]?.extras.uploadBytes?.median).toBe(100);
    expect(steps[0]?.lodVisible).toEqual([100, 0, 0, 0, 0, 0]);
  });

  it('derives bytes per agent and the largest count at a frame rate', () => {
    const steps =
      aggregate([run(1, [step(100, 5, 1_000), step(1100, 20, 101_000)])]).get('b') ?? [];
    expect(bytesPerAgent(steps)).toBe(100);
    // 5 ms → 200 fps at 100 agents; 20 ms → 50 fps at 1,100.
    expect(maxAgentsAt(steps, 30)).toBe(1100);
    expect(maxAgentsAt(steps, 60)).toBe(100);
    expect(maxAgentsAt(steps, 500)).toBeNull();
  });
});
