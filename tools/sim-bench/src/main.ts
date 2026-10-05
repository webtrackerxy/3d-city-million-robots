/**
 * Step 0.10, plan question Q8: when does CPU simulation become the bottleneck?
 *
 *   yarn workspace @city/sim-bench bench [--quick] [--out file.json]
 *
 * Runs the event-driven simulation (packages/sim) on a synthetic street grid, partitioned by agent
 * id across 1–8 worker threads that share one SharedArrayBuffer agent store, for 10k–1M agents,
 * with and without near-tier avoidance. Each 50 ms tick is closed by a barrier, so a tick costs
 * the slowest worker's time, as a frame-synchronous simulation would.
 */
import { AGENT_RECORD_BYTES } from '@city/core-types';
import { createGridGraph, gridForAgents } from '@city/nav';
import { AgentStore } from '@city/sim';
import { writeFileSync } from 'node:fs';
import { availableParallelism, cpus, totalmem } from 'node:os';
import { Worker } from 'node:worker_threads';
import { COUNTER_FIELDS, type WorkerSetup } from './protocol.ts';

const quick = process.argv.includes('--quick');
const outIndex = process.argv.indexOf('--out');
const outFile = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;

const AGENT_COUNTS = quick ? [10_000, 100_000] : [10_000, 100_000, 1_000_000];
const WORKER_COUNTS = quick ? [1, 4] : [1, 2, 4, 8];
const TICK_MS = 50;
const WARMUP_TICKS = 100; // 5 s
const TICKS = quick ? 200 : 600; // 10 / 30 s measured
const AGENTS_PER_EDGE = 4.5;
const BLOCK_M = 30;
/** Near tier (T0) size target: agents around the camera running per-tick avoidance. */
const NEAR_AGENTS = 5_000;

interface RunResult {
  agents: number;
  workers: number;
  avoidance: boolean;
  gridNodes: number;
  gridEdges: number;
  spawnMs: number;
  tickMs: { p50: number; p95: number; max: number; mean: number };
  eventsPerTick: number;
  dirtyPerTick: number;
  nearAgents: number;
  lateralChangesPerTick: number;
  uploadBytesPerTick: number;
  /** Simulated seconds per wall second at 20 Hz ticks (> 1 = faster than real time). */
  realtimeFactor: number;
}

async function run(agents: number, workers: number, avoidance: boolean): Promise<RunResult> {
  const { columns, rows } = gridForAgents(agents, AGENTS_PER_EDGE);
  const graph = createGridGraph(columns, rows, BLOCK_M);
  const areaPerAgent = ((columns - 1) * BLOCK_M * (rows - 1) * BLOCK_M) / agents;
  const focus = avoidance
    ? { x: 0, z: 0, radius: Math.sqrt((NEAR_AGENTS * areaPerAgent) / Math.PI) }
    : undefined;

  const shared = new SharedArrayBuffer(AgentStore.bytesFor(agents));
  const control = new SharedArrayBuffer(3 * 4);
  const timings = new SharedArrayBuffer(workers * TICKS * 8);
  const counters = new SharedArrayBuffer(workers * COUNTER_FIELDS * 8);
  const per = Math.ceil(agents / workers);

  const spawnStart = performance.now();
  const threads = Array.from({ length: workers }, (_, index) => {
    const setup: WorkerSetup = {
      index,
      workers,
      graph,
      agents: shared,
      capacity: agents,
      start: Math.min(agents, index * per),
      end: Math.min(agents, (index + 1) * per),
      control,
      timings,
      counters,
      focus,
      avoidance,
      tickMs: TICK_MS,
      warmupTicks: WARMUP_TICKS,
      ticks: TICKS,
      seed: 12345,
    };
    return new Worker(new URL('./worker.ts', import.meta.url), { workerData: setup });
  });
  const ready = new Int32Array(control);
  while (Atomics.load(ready, 2) < workers) await new Promise((resolve) => setTimeout(resolve, 5));
  const spawnMs = performance.now() - spawnStart;
  await Promise.all(
    threads.map(
      (thread) =>
        new Promise<void>((resolve, reject) => {
          thread.once('message', () => {
            resolve();
          });
          thread.once('error', reject);
        }),
    ),
  );
  await Promise.all(threads.map((thread) => thread.terminate()));

  // A tick lasts as long as its slowest worker.
  const perWorker = new Float64Array(timings);
  const ticks = Array.from({ length: TICKS }, (_, t) => {
    let max = 0;
    for (let w = 0; w < workers; w++) max = Math.max(max, perWorker[w * TICKS + t] ?? 0);
    return max;
  }).sort((a, b) => a - b);
  const totals = new Float64Array(counters);
  const sum = (field: number) => {
    let s = 0;
    for (let w = 0; w < workers; w++) s += totals[w * COUNTER_FIELDS + field] ?? 0;
    return s / TICKS;
  };
  const mean = ticks.reduce((a, b) => a + b, 0) / ticks.length;
  const dirtyPerTick = sum(1);
  return {
    agents,
    workers,
    avoidance,
    gridNodes: graph.nodeCount,
    gridEdges: graph.edgeCount,
    spawnMs,
    tickMs: {
      p50: ticks[Math.floor(TICKS * 0.5)] ?? 0,
      p95: ticks[Math.floor(TICKS * 0.95)] ?? 0,
      max: ticks[TICKS - 1] ?? 0,
      mean,
    },
    eventsPerTick: sum(0),
    dirtyPerTick,
    nearAgents: sum(2),
    lateralChangesPerTick: sum(3),
    uploadBytesPerTick: dirtyPerTick * AGENT_RECORD_BYTES,
    realtimeFactor: TICK_MS / Math.max(mean, 1e-6),
  };
}

const results: RunResult[] = [];
console.log(
  `CPU: ${cpus()[0]?.model ?? '?'} · ${availableParallelism()} threads · ${(totalmem() / 2 ** 30).toFixed(0)} GB · Node ${process.version}`,
);
console.log(
  'agents   workers avoid  tick p50   tick p95   events/tick dirty/tick near   upload/tick  ×realtime',
);
for (const agents of AGENT_COUNTS) {
  for (const avoidance of [false, true]) {
    for (const workers of WORKER_COUNTS) {
      const r = await run(agents, workers, avoidance);
      results.push(r);
      console.log(
        [
          String(agents).padEnd(8),
          String(workers).padEnd(7),
          (avoidance ? 'on' : 'off').padEnd(6),
          `${r.tickMs.p50.toFixed(3)} ms`.padEnd(10),
          `${r.tickMs.p95.toFixed(3)} ms`.padEnd(10),
          r.eventsPerTick.toFixed(0).padEnd(11),
          r.dirtyPerTick.toFixed(0).padEnd(10),
          r.nearAgents.toFixed(0).padEnd(6),
          `${(r.uploadBytesPerTick / 1024).toFixed(1)} KiB`.padEnd(12),
          r.realtimeFactor.toFixed(0),
        ].join(' '),
      );
    }
  }
}

if (outFile !== undefined) {
  writeFileSync(
    outFile,
    `${JSON.stringify(
      {
        schema: 'city-sim-bench/1',
        createdAt: new Date().toISOString(),
        cpu: cpus()[0]?.model,
        threads: availableParallelism(),
        node: process.version,
        tickMs: TICK_MS,
        measuredTicks: TICKS,
        agentsPerEdge: AGENTS_PER_EDGE,
        blockMetres: BLOCK_M,
        nearAgentsTarget: NEAR_AGENTS,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${outFile}`);
}
