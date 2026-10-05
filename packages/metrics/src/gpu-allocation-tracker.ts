import { estimateTextureBytes } from './texture-bytes.ts';

export type GpuResourceKind = 'buffer' | 'texture';

export interface GpuAllocation {
  kind: GpuResourceKind;
  bytes: number;
  label: string;
}

export interface GpuAllocationTotals {
  bufferBytes: number;
  bufferCount: number;
  textureBytes: number;
  textureCount: number;
  totalBytes: number;
  peakBytes: number;
}

/**
 * Book-keeping of live GPU allocations. WebGPU has no memory query, so this is the project's
 * only source of truth for VRAM budgets (implementation plan §21, §23).
 */
export class GpuAllocationTracker {
  private readonly live = new Map<number, GpuAllocation>();
  private nextId = 1;
  private bufferBytes = 0;
  private bufferCount = 0;
  private textureBytes = 0;
  private textureCount = 0;
  private peakBytes = 0;

  add(kind: GpuResourceKind, bytes: number, label = ''): number {
    const id = this.nextId++;
    this.live.set(id, { kind, bytes, label });
    if (kind === 'buffer') {
      this.bufferBytes += bytes;
      this.bufferCount++;
    } else {
      this.textureBytes += bytes;
      this.textureCount++;
    }
    this.peakBytes = Math.max(this.peakBytes, this.bufferBytes + this.textureBytes);
    return id;
  }

  /** Idempotent: destroy() followed by garbage collection must not double-count. */
  remove(id: number): void {
    const allocation = this.live.get(id);
    if (allocation === undefined) return;
    this.live.delete(id);
    if (allocation.kind === 'buffer') {
      this.bufferBytes -= allocation.bytes;
      this.bufferCount--;
    } else {
      this.textureBytes -= allocation.bytes;
      this.textureCount--;
    }
  }

  totals(): GpuAllocationTotals {
    return {
      bufferBytes: this.bufferBytes,
      bufferCount: this.bufferCount,
      textureBytes: this.textureBytes,
      textureCount: this.textureCount,
      totalBytes: this.bufferBytes + this.textureBytes,
      peakBytes: this.peakBytes,
    };
  }

  /** The n largest live allocations, for answering "what is using the VRAM?". */
  largest(n: number): GpuAllocation[] {
    return [...this.live.values()].sort((a, b) => b.bytes - a.bytes).slice(0, n);
  }
}

/**
 * Patches createBuffer/createTexture on this device instance so every allocation is tracked,
 * including those made internally by Three.js. Resources are untracked on destroy(), or when
 * they are garbage collected without an explicit destroy().
 */
export function instrumentDevice(device: GPUDevice, tracker: GpuAllocationTracker): void {
  const collected = new FinalizationRegistry<number>((id) => {
    tracker.remove(id);
  });

  const track = <T extends GPUBuffer | GPUTexture>(resource: T, id: number): T => {
    const destroy = resource.destroy.bind(resource);
    resource.destroy = () => {
      tracker.remove(id);
      destroy();
    };
    collected.register(resource, id);
    return resource;
  };

  const createBuffer = device.createBuffer.bind(device);
  device.createBuffer = (descriptor) =>
    track(createBuffer(descriptor), tracker.add('buffer', descriptor.size, descriptor.label));

  const createTexture = device.createTexture.bind(device);
  device.createTexture = (descriptor) =>
    track(
      createTexture(descriptor),
      tracker.add('texture', estimateTextureBytes(descriptor), descriptor.label),
    );
}
