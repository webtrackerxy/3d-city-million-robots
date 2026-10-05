import type { NavGraph } from '@city/nav';

/** Main → worker. */
export interface WorkerSetup {
  index: number;
  workers: number;
  graph: NavGraph;
  agents: SharedArrayBuffer;
  capacity: number;
  start: number;
  end: number;
  /** Int32: [0] barrier generation, [1] arrivals, [2] workers ready. */
  control: SharedArrayBuffer;
  /** Float64 per worker × ticks: step ms (events + avoidance + record packing). */
  timings: SharedArrayBuffer;
  /** Float64 per worker: [events, dirty, nearAgents, lateralChanges] totals over measured ticks. */
  counters: SharedArrayBuffer;
  focus: { x: number; z: number; radius: number } | undefined;
  avoidance: boolean;
  tickMs: number;
  warmupTicks: number;
  ticks: number;
  seed: number;
}

export const COUNTER_FIELDS = 4;
