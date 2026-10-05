import type { NavTileFiles } from '@city/formats';
import type { CityStats, FollowKind } from '@city/sim';
import { exchangeBytes, type ExchangeLayout } from './partition.ts';
import type { FollowState, FromWorker, SimConfig } from './protocol.ts';
import { allocateShared, Clock, Focus, RingReader, View } from './shared.ts';

type StatsMessage = Extract<FromWorker, { kind: 'stats' }>;

/** Near-tier walkers each worker may publish per tick for the others' avoidance. */
const MAX_NEAR = 16_384;

/**
 * Render-thread side of the simulation workers: owns the shared clock, starts one worker per
 * partition, drains every worker's dirty ring once per frame and sums their statistics.
 */
export class SimWorkerClient {
  readonly records: DataView;
  readonly agents: number;
  readonly workers: number;
  readonly ready: Promise<number>;
  private readonly latest: (StatsMessage | null)[];
  private pendingFollow: {
    resolve: (agent: number) => void;
    answers: number;
    found: number;
  } | null = null;
  private readonly threads: Worker[];
  private readonly clock: Int32Array;
  private readonly reached: Int32Array;
  private readonly focus: Float32Array;
  private readonly rings: RingReader[];
  private readonly all: Uint32Array;
  private readonly batch: Uint32Array;

  constructor(
    files: NavTileFiles,
    config: SimConfig,
    startMs: number,
    workers: number,
    edges: number,
  ) {
    this.workers = Math.max(1, Math.min(workers, config.agents));
    const layout: ExchangeLayout = { workers: this.workers, edges, maxNear: MAX_NEAR };
    const shared = allocateShared(config.agents, this.workers, exchangeBytes(layout));
    this.agents = config.agents;
    this.records = new DataView(shared.records);
    this.clock = new Int32Array(shared.clock);
    this.reached = new Int32Array(shared.reached);
    this.focus = new Float32Array(shared.clock);
    this.rings = shared.rings.map((ring) => new RingReader(ring));
    this.all = Uint32Array.from({ length: config.agents }, (_, i) => i);
    this.batch = new Uint32Array(config.agents * 2);
    this.latest = new Array<StatsMessage | null>(this.workers).fill(null);
    Atomics.store(this.clock, Clock.TargetMs, startMs);
    Atomics.store(this.clock, Clock.Running, 1);
    Atomics.store(this.clock, View.Follow, -1);
    const readies: Promise<number>[] = [];
    this.threads = Array.from({ length: this.workers }, (_, index) => {
      const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
      readies.push(
        new Promise((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<FromWorker>) => {
            const message = event.data;
            if (message.kind === 'ready') resolve(message.setupMs);
            else if (message.kind === 'stats') this.latest[index] = message;
            else if (message.kind === 'followCandidate') this.answerFollow(message.agent);
            else reject(new Error(message.message));
          };
        }),
      );
      worker.postMessage({
        kind: 'start',
        files: structuredClone(files),
        config,
        shared,
        partition: { index, workers: this.workers, layout },
      });
      return worker;
    });
    this.ready = Promise.all(readies).then((times) => Math.max(...times));
  }

  /** Every worker's latest statistics, summed (worker time: the slowest worker). */
  get latestStats(): StatsMessage | null {
    const reports = this.latest.filter((r): r is StatsMessage => r !== null);
    const first = reports.at(0);
    if (first === undefined) return null;
    const stats: CityStats = { ...first.stats };
    for (const report of reports.slice(1))
      for (const key of Object.keys(stats) as (keyof CityStats)[])
        if (key !== 'timeOfDayMs') stats[key] += report.stats[key];
    let follow: FollowState | null = null;
    for (const report of reports) follow ??= report.follow;
    return {
      kind: 'stats',
      stats,
      simMs: Math.min(...reports.map((r) => r.simMs)),
      tickMsPerSimSecond: Math.max(...reports.map((r) => r.tickMsPerSimSecond)),
      barrierMsPerSimSecond: Math.max(...reports.map((r) => r.barrierMsPerSimSecond)),
      recordsPerSecond: reports.reduce((n, r) => n + r.recordsPerSecond, 0),
      follow,
      population: reports.reduce((n, r) => n + r.population, 0),
    };
  }

  /** Sim time every worker has reached and published (ms): safe to draw. */
  reachedMs(): number {
    let reached = Infinity;
    for (let i = 0; i < this.workers; i++)
      reached = Math.min(reached, Atomics.load(this.reached, i));
    return reached;
  }

  /** The simulation catches up to this time (integer ms). */
  setTime(simMs: number): void {
    Atomics.store(this.clock, Clock.TargetMs, Math.max(0, Math.floor(simMs)) | 0);
  }

  /** Near-tier focus in Three coordinates (usually the camera's orbit target). */
  setFocus(x: number, z: number): void {
    this.focus[Focus.X] = x;
    this.focus[Focus.Z] = z;
    this.focus[Focus.Set] = 1;
  }

  /** The agent whose state the stats report (−1: none). */
  setFollow(agent: number): void {
    Atomics.store(this.clock, View.Follow, agent);
  }

  /** A roof walker (of `agentKind`, if set) near the focus (any worker), or −1. */
  pickFollow(agentKind?: FollowKind): Promise<number> {
    return new Promise((resolve) => {
      this.pendingFollow = { resolve, answers: 0, found: -1 };
      for (const worker of this.threads) worker.postMessage({ kind: 'pickFollow', agentKind });
    });
  }

  private answerFollow(agent: number): void {
    const pending = this.pendingFollow;
    if (pending === null) return;
    pending.answers++;
    if (pending.found < 0) pending.found = agent;
    if (pending.answers === this.threads.length) {
      this.pendingFollow = null;
      pending.resolve(pending.found);
    }
  }

  setRunning(running: boolean): void {
    Atomics.store(this.clock, Clock.Running, running ? 1 : 0);
  }

  /** Agent ids whose records changed since the last call (every agent after an overflow). */
  drain(): { ids: Uint32Array; count: number } {
    let count = 0;
    for (const ring of this.rings) {
      const batch = ring.drain();
      if (batch === null) return { ids: this.all, count: this.agents };
      this.batch.set(batch.ids.subarray(0, batch.count), count);
      count += batch.count;
    }
    return { ids: this.batch, count };
  }

  dispose(): void {
    for (const worker of this.threads) worker.terminate();
  }
}
