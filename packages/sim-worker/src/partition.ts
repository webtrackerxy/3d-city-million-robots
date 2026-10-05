import type { CitySimulation } from '@city/sim';

/**
 * Partitioned simulation (implementation plan §16: workers partition agents by index range; per-edge
 * density is accumulated per worker and merged each tick). Each worker owns a range of rows, a share
 * of the population and of the building aggregates, and runs its own CitySimulation; every tick the
 * workers exchange, through shared memory:
 *
 * - occupancy per nav edge, which the others add to their density speed (one tick late);
 * - near-tier walkers' positions, which the others avoid (the positions of tick t, double-buffered
 *   by tick parity so a worker already publishing t + 1 cannot overwrite what another still reads).
 *
 * A tick is publish → barrier → consume. With one barrier per tick no worker can be more than one
 * tick ahead, so two parity buffers suffice. Given the seed and the worker count, runs are
 * deterministic; different worker counts partition the aggregates differently, so they agree
 * statistically, not bit for bit.
 */
export interface ExchangeLayout {
  workers: number;
  edges: number;
  /** Near-tier walkers each worker may publish per tick. */
  maxNear: number;
}

export function exchangeBytes(layout: ExchangeLayout): number {
  const { workers, edges, maxNear } = layout;
  const control = 16; // barrier generation, arrived, 2 spare
  const counts = 2 * workers * 4;
  const occupancy = Math.ceil((workers * edges * 2) / 8) * 8;
  const near = 2 * workers * maxNear * 16;
  return control + counts + occupancy + near;
}

export class Exchange {
  readonly layout: ExchangeLayout;
  readonly control: Int32Array;
  private readonly counts: Int32Array;
  private readonly occupancyViews: Uint16Array[];
  private readonly nearViews: Float32Array[];
  /** Per-worker scratch: the sum of the other workers' occupancy. */
  private readonly others: Uint16Array;

  constructor(buffer: SharedArrayBuffer | ArrayBuffer, layout: ExchangeLayout) {
    this.layout = layout;
    const { workers, edges, maxNear } = layout;
    this.control = new Int32Array(buffer, 0, 4);
    this.counts = new Int32Array(buffer, 16, 2 * workers);
    const occupancyAt = 16 + 2 * workers * 4;
    this.occupancyViews = Array.from(
      { length: workers },
      (_, w) => new Uint16Array(buffer, occupancyAt + w * edges * 2, edges),
    );
    const nearAt = occupancyAt + Math.ceil((workers * edges * 2) / 8) * 8;
    this.nearViews = Array.from(
      { length: 2 * workers },
      (_, i) => new Float32Array(buffer, nearAt + i * maxNear * 16, maxNear * 4),
    );
    this.others = new Uint16Array(edges);
  }

  /** Before the barrier: this worker's occupancy and near walkers at tick `t`. */
  publish(sim: CitySimulation, worker: number, t: number, parity: number): void {
    this.occupancyViews[worker].set(sim.occupancyCounts);
    const slot = parity * this.layout.workers + worker;
    this.counts[slot] = sim.nearPositions(t, this.nearViews[slot], this.layout.maxNear);
  }

  /** After the barrier: the others' occupancy into density, their walkers into avoidance. */
  consume(
    sim: CitySimulation,
    worker: number,
    t: number,
    parity: number,
    avoidance: boolean,
  ): void {
    const { workers, edges } = this.layout;
    if (workers > 1) {
      this.others.fill(0);
      for (let w = 0; w < workers; w++) {
        if (w === worker) continue;
        const view = this.occupancyViews[w];
        for (let e = 0; e < edges; e++) this.others[e] += view[e];
      }
      sim.setExternalOccupancy(this.others);
    }
    if (!avoidance) return;
    const external: { data: Float32Array; count: number }[] = [];
    for (let w = 0; w < workers; w++) {
      if (w === worker) continue;
      const slot = parity * workers + w;
      external.push({ data: this.nearViews[slot], count: this.counts[slot] });
    }
    sim.avoid(t, external);
  }
}

/** Blocks until all `workers` have arrived (worker threads only: Atomics.wait). */
export function barrier(control: Int32Array, workers: number): void {
  const generation = Atomics.load(control, 0);
  if (Atomics.add(control, 1, 1) === workers - 1) {
    Atomics.store(control, 1, 0);
    Atomics.add(control, 0, 1);
    Atomics.notify(control, 0);
    return;
  }
  while (Atomics.load(control, 0) === generation) Atomics.wait(control, 0, generation);
}

/** The rows, population share and seed of partition `index` of `workers`. */
export function partitionOf(
  index: number,
  workers: number,
  rows: number,
  population: number,
  seed: number,
): { rowStart: number; rowCount: number; population: number; seed: number } {
  const rowStart = Math.floor((rows * index) / workers);
  const rowEnd = Math.floor((rows * (index + 1)) / workers);
  const popStart = Math.floor((population * index) / workers);
  const popEnd = Math.floor((population * (index + 1)) / workers);
  return {
    rowStart,
    rowCount: rowEnd - rowStart,
    population: Math.max(rowEnd - rowStart, popEnd - popStart),
    seed: (Math.imul(seed ^ 0x9e3779b9, index + 1) ^ (index * 0x85ebca6b)) >>> 0,
  };
}
