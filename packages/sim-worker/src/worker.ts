/// <reference lib="webworker" />
import { readNavTile } from '@city/formats';
import { simGraphFromTile } from '@city/nav';
import { CitySimulation } from '@city/sim';
import { barrier, Exchange, partitionOf } from './partition.ts';
import type { FollowState, FromWorker, ToWorker } from './protocol.ts';
import { Clock, Focus, RingWriter, View } from './shared.ts';

/**
 * Simulation worker, one partition of the population (partition.ts): follows the render thread's
 * clock (shared memory), advances its CitySimulation tick by tick in lockstep with the other
 * workers, and publishes changed records through its own shared ring.
 */
const LOOP_MS = 8;
const STATS_MS = 500;
/** Longest stretch of ticks between two publishes. */
const CATCH_UP_SLICE_MS = 50;

const post = (message: FromWorker) => {
  self.postMessage(message);
};

let simulation: CitySimulation | null = null;
let rowStart = 0;

self.onmessage = (event: MessageEvent<ToWorker>) => {
  try {
    const message = event.data;
    if (message.kind === 'pickFollow') {
      const local = simulation?.pickFollowCandidate(message.agentKind) ?? -1;
      post({ kind: 'followCandidate', agent: local < 0 ? -1 : local + rowStart });
      return;
    }
    start(message);
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};

function start({ files, config, shared, partition }: Extract<ToWorker, { kind: 'start' }>): void {
  const t0 = performance.now();
  const { index, workers, layout } = partition;
  const part = partitionOf(index, workers, config.agents, config.population, config.seed);
  rowStart = part.rowStart;
  const tile = readNavTile(files);
  const graph = simGraphFromTile(tile);
  const clock = new Int32Array(shared.clock);
  const focus = new Float32Array(shared.clock);
  const ring = new RingWriter(shared.rings[index]);
  const exchange = new Exchange(shared.exchange, layout);
  const reached = new Int32Array(shared.reached);
  const sim = new CitySimulation({
    tile,
    graph,
    agents: part.rowCount,
    population: part.population,
    robotShare: config.robotShare,
    seed: part.seed,
    human: config.human,
    robot: config.robot,
    humanVariants: config.humanVariants,
    ...(config.humanShares === undefined ? {} : { humanShares: config.humanShares }),
    avoidance: config.avoidance,
    records: new DataView(shared.records, part.rowStart * 24, part.rowCount * 24),
    startMs: Atomics.load(clock, Clock.TargetMs),
    firstRoofEdge: config.firstRoofEdge,
    roofShare: config.roofShare,
    ...(config.roofZone === undefined ? {} : { roofZone: config.roofZone }),
    startHour: config.startHour,
    ...(config.showcase ? { stayOutdoors: true, startWalkingShare: 1 } : {}),
    ...(config.scale ?? {}),
    ...(config.areas?.[index] === undefined ? {} : { area: config.areas[index] }),
  });
  simulation = sim;
  const publish = () => {
    const count = sim.flush((agent) => {
      ring.push(agent + part.rowStart);
    });
    ring.publish();
    return count;
  };
  publish();
  Atomics.store(reached, index, sim.now);
  post({ kind: 'ready', setupMs: performance.now() - t0 });

  let busyMs = 0;
  /** Time blocked at the tick barrier (waiting for slower partitions), inside busyMs. */
  let waitMs = 0;
  let records = 0;
  let parity = 0;
  let windowStart = performance.now();
  let simAtWindowStart = sim.now;
  const loop = () => {
    if (Atomics.load(clock, Clock.Running) === 1) {
      const begin = performance.now();
      if (focus[Focus.Set] === 1) sim.setFocus(focus[Focus.X], focus[Focus.Z]);
      const target = Atomics.load(clock, Clock.TargetMs);
      // Catching up after a stall is done in slices, publishing in between, so the renderer
      // keeps receiving records and the reached time keeps moving.
      while (sim.nextTickMs <= target && performance.now() - begin < CATCH_UP_SLICE_MS) {
        const t = sim.stepEvents();
        exchange.publish(sim, index, t, parity);
        const waitStart = performance.now();
        barrier(exchange.control, workers);
        waitMs += performance.now() - waitStart;
        exchange.consume(sim, index, t, parity, config.avoidance);
        parity ^= 1;
      }
      records += publish();
      Atomics.store(reached, index, Math.min(sim.now, target));
      busyMs += performance.now() - begin;
    }
    const now = performance.now();
    if (now - windowStart >= STATS_MS) {
      const simSeconds = (sim.now - simAtWindowStart) / 1000;
      post({
        kind: 'stats',
        stats: sim.snapshotStats(),
        simMs: sim.now,
        tickMsPerSimSecond: simSeconds > 0 ? (busyMs - waitMs) / simSeconds : 0,
        barrierMsPerSimSecond: simSeconds > 0 ? waitMs / simSeconds : 0,
        recordsPerSecond: (records * 1000) / (now - windowStart),
        follow: followState(sim, Atomics.load(clock, View.Follow) - part.rowStart, part.rowStart),
        population: sim.population,
      });
      busyMs = 0;
      waitMs = 0;
      records = 0;
      windowStart = now;
      simAtWindowStart = sim.now;
    }
    setTimeout(loop, LOOP_MS);
  };
  loop();
}

function followState(sim: CitySimulation, local: number, offset: number): FollowState | null {
  if (local < 0 || local >= sim.agents) return null;
  const s = sim.agentState(local);
  return {
    agent: local + offset,
    state: s.state,
    building: s.building,
    roof: s.roof,
    robot: s.robot,
    seed: s.seed,
  };
}
