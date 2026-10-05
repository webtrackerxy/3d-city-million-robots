/**
 * Traffic worker ↔ main thread. The worker owns the simulation and publishes snapshots through
 * shared memory: two slots of count × (x, y, z, heading) and a control block. It writes the idle
 * slot, then stores the sequence word; the main thread reads the slot named by the control block
 * whenever the sequence changes.
 */
export const CONTROL = {
  sequence: 0,
  slot: 1,
  /** Simulation step time of the last tick, microseconds. */
  stepMicros: 2,
  count: 3,
} as const;
export const CONTROL_WORDS = 4;

/** Snapshot interval, ms (the cars project's 10 Hz). */
export const TICK_MS = 100;

export interface TrafficShared {
  control: SharedArrayBuffer;
  /** Two slots of capacity × 4 floats. */
  snapshots: SharedArrayBuffer;
}

export type ToTrafficWorker =
  | {
      kind: 'start';
      roads: ArrayBuffer;
      count: number;
      seed: number;
      shared: TrafficShared;
    }
  | { kind: 'timeScale'; scale: number };

export type FromTrafficWorker =
  { kind: 'ready'; colours: Uint8Array; roadKm: number } | { kind: 'error'; message: string };
