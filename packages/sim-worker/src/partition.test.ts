import { AGENT_RECORD_BYTES, BuildingType } from '@city/core-types';
import { simGraphFromTile } from '@city/nav';
import { CitySimulation } from '@city/sim';
import { describe, expect, it } from 'vitest';
import { Exchange, exchangeBytes, partitionOf } from './partition.ts';
import { city } from './test-city.ts';

/** Runs `workers` partitions in lockstep in one thread (publish all, then consume all). */
function run(workers: number, seconds: number, seed = 9) {
  const tile = city();
  tile.buildings.type.set([
    BuildingType.Office,
    BuildingType.Residential,
    BuildingType.Office,
    BuildingType.Retail,
    BuildingType.Residential,
    BuildingType.Transport,
  ]);
  const graph = simGraphFromTile(tile);
  const layout = { workers, edges: tile.edges.from.length, maxNear: 2048 };
  const exchange = new Exchange(new ArrayBuffer(exchangeBytes(layout)), layout);
  const sims = Array.from({ length: workers }, (_, w) => {
    const part = partitionOf(w, workers, 800, 4000, seed);
    return new CitySimulation({
      tile,
      graph,
      agents: part.rowCount,
      population: part.population,
      seed: part.seed,
      robotShare: 0.2,
      human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
      robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
      humanVariants: 1,
      records: new DataView(new ArrayBuffer(part.rowCount * AGENT_RECORD_BYTES)),
      focus: { x: 75, z: -75 },
      startHour: 8,
    });
  });
  let tick = 0;
  while (sims[0].nextTickMs <= seconds * 1000) {
    const parity = tick++ & 1;
    const times = sims.map((sim, w) => {
      const t = sim.stepEvents();
      exchange.publish(sim, w, t, parity);
      return t;
    });
    sims.forEach((sim, w) => {
      exchange.consume(sim, w, times[w], parity, true);
    });
  }
  return sims;
}

describe('partitioned simulation', () => {
  it('conserves the population across partitions and is deterministic for a worker count', () => {
    const a = run(4, 600);
    const b = run(4, 600);
    expect(a.reduce((n, s) => n + s.population, 0)).toBe(4000);
    expect(a.map((s) => s.stateHash())).toEqual(b.map((s) => s.stateHash()));
    // Partitions see each other: someone's avoidance used others' walkers.
    expect(a.some((s) => s.snapshotStats().lateralChanges > 0)).toBe(true);
  }, 60_000);

  it('splits rows and population exactly', () => {
    let rows = 0;
    let people = 0;
    for (let w = 0; w < 3; w++) {
      const p = partitionOf(w, 3, 1000, 10_000, 1);
      rows += p.rowCount;
      people += p.population;
    }
    expect(rows).toBe(1000);
    expect(people).toBe(10_000);
  });

  it('agrees statistically with a single worker', () => {
    const one = run(1, 900);
    const four = run(4, 900);
    const walking = (sims: CitySimulation[]) =>
      sims.reduce((n, s) => n + s.snapshotStats().walking, 0);
    const w1 = walking(one);
    const w4 = walking(four);
    expect(Math.abs(w1 - w4) / Math.max(w1, w4)).toBeLessThan(0.25);
  }, 60_000);
});
