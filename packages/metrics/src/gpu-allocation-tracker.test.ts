import { describe, expect, it } from 'vitest';
import { GpuAllocationTracker, instrumentDevice } from './gpu-allocation-tracker.ts';

describe('GpuAllocationTracker', () => {
  it('tracks totals, counts and the peak', () => {
    const tracker = new GpuAllocationTracker();
    const a = tracker.add('buffer', 1000, 'agents');
    tracker.add('texture', 500, 'albedo');
    tracker.remove(a);
    tracker.add('buffer', 200, 'indirect');

    expect(tracker.totals()).toEqual({
      bufferBytes: 200,
      bufferCount: 1,
      textureBytes: 500,
      textureCount: 1,
      totalBytes: 700,
      peakBytes: 1500,
    });
  });

  it('ignores a second remove of the same allocation', () => {
    const tracker = new GpuAllocationTracker();
    const id = tracker.add('buffer', 64);
    tracker.remove(id);
    tracker.remove(id);

    expect(tracker.totals().totalBytes).toBe(0);
    expect(tracker.totals().bufferCount).toBe(0);
  });

  it('lists the largest live allocations first', () => {
    const tracker = new GpuAllocationTracker();
    tracker.add('buffer', 10, 'small');
    tracker.add('texture', 30, 'large');
    tracker.add('buffer', 20, 'medium');

    expect(tracker.largest(2).map((allocation) => allocation.label)).toEqual(['large', 'medium']);
  });
});

describe('instrumentDevice', () => {
  function fakeDevice(): { device: GPUDevice; destroyed: string[] } {
    const destroyed: string[] = [];
    const resource = (label: string) => ({
      destroy: () => {
        destroyed.push(label);
      },
    });
    const device = {
      createBuffer: (descriptor: GPUBufferDescriptor) => resource(descriptor.label ?? ''),
      createTexture: (descriptor: GPUTextureDescriptor) => resource(descriptor.label ?? ''),
    };
    return { device: device as unknown as GPUDevice, destroyed };
  }

  it('tracks resources created through the device and untracks them on destroy', () => {
    const { device, destroyed } = fakeDevice();
    const tracker = new GpuAllocationTracker();
    instrumentDevice(device, tracker);

    const buffer = device.createBuffer({ label: 'agents', size: 24_000_000, usage: 0 });
    device.createTexture({ label: 'depth', size: [100, 100], format: 'depth32float', usage: 0 });

    expect(tracker.totals()).toMatchObject({
      bufferBytes: 24_000_000,
      textureBytes: 40_000,
      bufferCount: 1,
      textureCount: 1,
    });

    buffer.destroy();

    expect(destroyed).toEqual(['agents']);
    expect(tracker.totals()).toMatchObject({ bufferBytes: 0, bufferCount: 0, textureCount: 1 });
    expect(tracker.totals().peakBytes).toBe(24_040_000);
  });
});
