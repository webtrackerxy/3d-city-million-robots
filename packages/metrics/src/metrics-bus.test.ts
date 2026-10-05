import { describe, expect, it } from 'vitest';
import { MetricsBus } from './metrics-bus.ts';

describe('MetricsBus', () => {
  it('snapshots gauges and series independently of later writes', () => {
    const bus = new MetricsBus();
    bus.setGauge('agents.total', 1000);
    bus.record('frame.cpuMs', 2);
    bus.record('frame.cpuMs', 4);

    const snapshot = bus.snapshot();
    bus.setGauge('agents.total', 5);

    expect(snapshot.gauges['agents.total']).toBe(1000);
    expect(snapshot.series['frame.cpuMs']).toMatchObject({ count: 2, mean: 3, last: 4 });
  });

  it('forgets everything on reset', () => {
    const bus = new MetricsBus();
    bus.setGauge('a', 1);
    bus.record('b', 1);
    bus.reset();

    expect(bus.snapshot()).toEqual({ gauges: {}, series: {} });
  });
});
