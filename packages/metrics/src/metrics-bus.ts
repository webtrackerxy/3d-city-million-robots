import { RollingSeries, type SeriesStats } from './rolling-series.ts';

export interface MetricsSnapshot {
  gauges: Readonly<Record<string, number>>;
  series: Readonly<Record<string, SeriesStats>>;
}

/**
 * The only channel between the engine and the debug UI. The engine writes numbers every frame;
 * the UI polls snapshot() a few times per second. No per-agent data ever goes through here.
 */
export class MetricsBus {
  private readonly gauges = new Map<string, number>();
  private readonly series = new Map<string, RollingSeries>();
  private readonly seriesCapacity: number;

  constructor(seriesCapacity = 240) {
    this.seriesCapacity = seriesCapacity;
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  record(name: string, value: number): void {
    let series = this.series.get(name);
    if (series === undefined) {
      series = new RollingSeries(this.seriesCapacity);
      this.series.set(name, series);
    }
    series.push(value);
  }

  snapshot(): MetricsSnapshot {
    const series: Record<string, SeriesStats> = {};
    for (const [name, samples] of this.series) series[name] = samples.stats();
    return { gauges: Object.fromEntries(this.gauges), series };
  }

  reset(): void {
    this.gauges.clear();
    this.series.clear();
  }
}
