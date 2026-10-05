const TIMESTAMP_BYTES = 16; // two u64 timestamps

/**
 * Measures the GPU duration of one pass with the `timestamp-query` feature. Results arrive a
 * few frames late through mapAsync; frames that finish while a readback is pending are skipped
 * rather than queued, so the timer never stalls or allocates per frame.
 */
export class GpuPassTimer {
  private readonly querySet: GPUQuerySet;
  private readonly resolveBuffer: GPUBuffer;
  private readonly readBuffer: GPUBuffer;
  private copiedThisFrame = false;
  private readbackPending = false;

  static isSupported(device: GPUDevice): boolean {
    return device.features.has('timestamp-query');
  }

  constructor(device: GPUDevice, label: string) {
    this.querySet = device.createQuerySet({
      label: `${label} timestamps`,
      type: 'timestamp',
      count: 2,
    });
    this.resolveBuffer = device.createBuffer({
      label: `${label} timestamp resolve`,
      size: TIMESTAMP_BYTES,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.readBuffer = device.createBuffer({
      label: `${label} timestamp readback`,
      size: TIMESTAMP_BYTES,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });
  }

  /** Pass as `timestampWrites` in the pass descriptor. */
  get timestampWrites(): GPURenderPassTimestampWrites & GPUComputePassTimestampWrites {
    return { querySet: this.querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 };
  }

  /** Call after the pass has ended, before encoder.finish(). */
  resolve(encoder: GPUCommandEncoder): void {
    encoder.resolveQuerySet(this.querySet, 0, 2, this.resolveBuffer, 0);
    if (this.readbackPending) return;
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, this.readBuffer, 0, TIMESTAMP_BYTES);
    this.copiedThisFrame = true;
  }

  /** Call after queue.submit(). */
  readback(onMilliseconds: (ms: number) => void): void {
    if (!this.copiedThisFrame) return;
    this.copiedThisFrame = false;
    this.readbackPending = true;

    this.readBuffer
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        const times = new BigInt64Array(this.readBuffer.getMappedRange());
        const nanoseconds = Number((times[1] ?? 0n) - (times[0] ?? 0n));
        this.readBuffer.unmap();
        // Some drivers occasionally report end < begin; drop those samples.
        if (nanoseconds >= 0) onMilliseconds(nanoseconds / 1e6);
      })
      .catch(() => {
        // Device lost or destroyed while mapping; nothing to report.
      })
      .finally(() => {
        this.readbackPending = false;
      });
  }

  destroy(): void {
    this.querySet.destroy();
    this.resolveBuffer.destroy();
    this.readBuffer.destroy();
  }
}
