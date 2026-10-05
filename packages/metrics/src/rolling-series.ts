export interface SeriesStats {
  count: number;
  last: number;
  mean: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

const EMPTY_STATS: SeriesStats = { count: 0, last: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0 };

/** Fixed-capacity ring buffer of samples. push() never allocates; stats() is for polling UIs. */
export class RollingSeries {
  private readonly samples: Float64Array;
  private next = 0;
  private filled = 0;

  constructor(capacity = 240) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`RollingSeries capacity must be a positive integer, got ${capacity}`);
    }
    this.samples = new Float64Array(capacity);
  }

  push(value: number): void {
    this.samples[this.next] = value;
    this.next = (this.next + 1) % this.samples.length;
    if (this.filled < this.samples.length) this.filled++;
  }

  clear(): void {
    this.next = 0;
    this.filled = 0;
  }

  stats(): SeriesStats {
    if (this.filled === 0) return EMPTY_STATS;
    const lastIndex = (this.next + this.samples.length - 1) % this.samples.length;
    return {
      ...summarise(this.samples.subarray(0, this.filled)),
      last: this.samples[lastIndex] ?? 0,
    };
  }
}

/**
 * Summary statistics of a batch of samples (nearest-rank percentiles). `last` is the final
 * element in input order. Does not modify `values`.
 */
export function summarise(values: ArrayLike<number>): SeriesStats {
  const count = values.length;
  if (count === 0) return EMPTY_STATS;

  const sorted = Float64Array.from(values).sort();
  let sum = 0;
  for (const value of sorted) sum += value;

  return {
    count,
    last: values[count - 1] ?? 0,
    mean: sum / count,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted[count - 1] ?? 0,
  };
}

/** Nearest-rank percentile of an ascending-sorted array. */
function percentile(sorted: Float64Array, fraction: number): number {
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.max(0, rank - 1)] ?? 0;
}
