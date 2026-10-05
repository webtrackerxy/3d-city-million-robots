import { AGENT_RECORD_BYTES } from '@city/core-types';

/**
 * Shared memory between the render thread and the simulation worker (implementation plan §3):
 *
 *   records  AGENT_RECORD_BYTES per agent, written by the worker, read by the renderer
 *   ring     dirty agent ids: header [write count] + ids; single producer, single consumer
 *   clock    [target sim ms, running] (i32) + [focus x, focus z, has focus] (f32) + [followed
 *            agent] (i32), written by the renderer, read by the worker
 *
 * The worker writes a record, then its id, then publishes the ring's write count with
 * Atomics.store; the reader loads the count first, so every id it sees has its record written.
 * A record rewritten while the reader copies it can tear for one frame: its id is already in the
 * ring again, and the next drain repairs it.
 */
export interface SharedBuffers {
  records: SharedArrayBuffer;
  /** One dirty ring per worker. */
  rings: SharedArrayBuffer[];
  clock: SharedArrayBuffer;
  /** Per-tick exchange between partitions (see partition.ts). */
  exchange: SharedArrayBuffer;
  /**
   * Sim time (i32 ms) each worker has reached and published, by worker index: the renderer never
   * draws past the slowest, so agents never run ahead of their next event.
   */
  reached: SharedArrayBuffer;
}

export const Clock = { TargetMs: 0, Running: 1 } as const;
/** f32 slots after the two i32 clock words. */
export const Focus = { X: 2, Z: 3, Set: 4 } as const;
/** i32 slot: the followed agent (−1 none). */
export const View = { Follow: 5 } as const;

export function allocateShared(agents: number, workers: number, exchange: number): SharedBuffers {
  return {
    records: new SharedArrayBuffer(Math.max(1, agents) * AGENT_RECORD_BYTES),
    rings: Array.from(
      { length: workers },
      () => new SharedArrayBuffer(4 + ringCapacity(Math.ceil(agents / workers)) * 4),
    ),
    clock: new SharedArrayBuffer(24),
    exchange: new SharedArrayBuffer(exchange),
    reached: new SharedArrayBuffer(workers * 4),
  };
}

export function ringCapacity(agents: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1024, agents * 2)));
}

export class RingWriter {
  private readonly header: Int32Array;
  private readonly ids: Uint32Array;
  private readonly mask: number;
  private written = 0;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 1);
    this.ids = new Uint32Array(buffer, 4);
    this.mask = this.ids.length - 1;
  }

  push(id: number): void {
    this.ids[this.written & this.mask] = id;
    this.written = (this.written + 1) | 0;
  }

  /** Makes everything pushed so far visible to the reader. */
  publish(): void {
    Atomics.store(this.header, 0, this.written);
  }
}

export class RingReader {
  private readonly header: Int32Array;
  private readonly ids: Uint32Array;
  private readonly mask: number;
  private read = 0;
  private readonly batch: Uint32Array;

  constructor(buffer: SharedArrayBuffer) {
    this.header = new Int32Array(buffer, 0, 1);
    this.ids = new Uint32Array(buffer, 4);
    this.mask = this.ids.length - 1;
    this.batch = new Uint32Array(this.ids.length);
  }

  /**
   * Ids published since the last drain, or null when the writer lapped the reader (the caller
   * must then refresh every record).
   */
  drain(): { ids: Uint32Array; count: number } | null {
    const written = Atomics.load(this.header, 0);
    const pending = (written - this.read) | 0;
    this.read = written;
    if (pending > this.ids.length) return null;
    for (let i = 0; i < pending; i++) this.batch[i] = this.ids[(written - pending + i) & this.mask];
    return { ids: this.batch, count: pending };
  }
}
