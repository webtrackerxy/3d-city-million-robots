import { describe, expect, it } from 'vitest';
import { buildAdapterReport, TRACKED_FEATURES, TRACKED_LIMITS } from './adapter-report.ts';

describe('buildAdapterReport', () => {
  it('distinguishes what the adapter supports from what the device enabled', () => {
    const limits = (value: number) =>
      Object.fromEntries(
        TRACKED_LIMITS.map((name) => [name, value]),
      ) as unknown as GPUSupportedLimits;

    const report = buildAdapterReport(
      {
        info: {
          vendor: 'apple',
          architecture: 'metal-3',
          device: '',
          description: 'Apple M-series',
        } as GPUAdapterInfo,
        features: new Set(['timestamp-query', 'shader-f16']),
        limits: limits(1024),
      },
      {
        features: new Set(['timestamp-query']),
        limits: limits(256),
      },
    );

    expect(report.vendor).toBe('apple');
    expect(report.features).toHaveLength(TRACKED_FEATURES.length);
    expect(report.features.find((f) => f.name === 'timestamp-query')).toEqual({
      name: 'timestamp-query',
      adapter: true,
      device: true,
    });
    expect(report.features.find((f) => f.name === 'shader-f16')).toMatchObject({
      adapter: true,
      device: false,
    });
    expect(report.limits.find((l) => l.name === 'maxBufferSize')).toEqual({
      name: 'maxBufferSize',
      adapter: 1024,
      device: 256,
    });
  });
});
