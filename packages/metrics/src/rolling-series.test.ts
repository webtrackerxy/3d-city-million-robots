import { describe, expect, it } from 'vitest';
import { RollingSeries, summarise } from './rolling-series.ts';

describe('RollingSeries', () => {
  it('reports zeros when empty', () => {
    expect(new RollingSeries(4).stats()).toMatchObject({ count: 0, mean: 0, p99: 0 });
  });

  it('computes nearest-rank percentiles', () => {
    const series = new RollingSeries(100);
    for (let i = 1; i <= 100; i++) series.push(i);

    expect(series.stats()).toEqual({
      count: 100,
      last: 100,
      mean: 50.5,
      p50: 50,
      p95: 95,
      p99: 99,
      max: 100,
    });
  });

  it('drops the oldest samples once full', () => {
    const series = new RollingSeries(3);
    for (const value of [100, 1, 2, 3]) series.push(value);

    const stats = series.stats();
    expect(stats.count).toBe(3);
    expect(stats.max).toBe(3);
    expect(stats.last).toBe(3);
    expect(stats.mean).toBe(2);
  });

  it('rejects invalid capacities', () => {
    expect(() => new RollingSeries(0)).toThrow(RangeError);
  });
});

describe('summarise', () => {
  it('summarises a batch without reordering the input', () => {
    const values = [3, 1, 2];
    expect(summarise(values)).toEqual({
      count: 3,
      last: 2,
      mean: 2,
      p50: 2,
      p95: 3,
      p99: 3,
      max: 3,
    });
    expect(values).toEqual([3, 1, 2]);
  });

  it('reports zeros for an empty batch', () => {
    expect(summarise([])).toMatchObject({ count: 0, mean: 0, max: 0 });
  });
});
