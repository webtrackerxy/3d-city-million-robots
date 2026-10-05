import { AGENT_RECORD_BYTES, BuildingType } from '@city/core-types';
import { simGraphFromTile } from '@city/nav';
import { describe, expect, it } from 'vitest';
import { CitySimulation } from './city-sim.ts';
import { Period, periodOf } from './demand.ts';
import { gridTile } from './test-tile.ts';

/** The grid town with typed buildings: homes, offices, a shop, and a station (building 4). */
function town() {
  const tile = gridTile();
  const types = [
    BuildingType.Residential,
    BuildingType.Office,
    BuildingType.Office,
    BuildingType.Retail,
    BuildingType.Transport,
    BuildingType.Residential,
  ];
  tile.buildings.type.set(types);
  tile.buildings.capacity.set([1500, 2500, 2500, 400, 3000, 1500]);
  return tile;
}

function create(startHour: number, population = 5000, agents = 600, tickMs?: number) {
  const tile = town();
  return new CitySimulation({
    tile,
    graph: simGraphFromTile(tile),
    agents,
    population,
    startHour,
    ...(tickMs === undefined ? {} : { tickMs }),
    robotShare: 0.2,
    seed: 3,
    human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
    robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
    humanVariants: 1,
    records: new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES)),
  });
}

describe('demand model', () => {
  it('knows the periods of the day', () => {
    expect(periodOf(3 * 3_600_000)).toBe(Period.Night);
    expect(periodOf(8.5 * 3_600_000)).toBe(Period.Morning);
    expect(periodOf(13 * 3_600_000)).toBe(Period.Midday);
    expect(periodOf(18 * 3_600_000)).toBe(Period.Evening);
    expect(periodOf(22 * 3_600_000)).toBe(Period.Late);
    expect(periodOf(27 * 3_600_000)).toBe(Period.Night); // wraps
  });

  it('conserves a population larger than the rows, all day', () => {
    // Coarse ticks: conservation does not depend on the tick, and 12 h at 33 ms is slow.
    const sim = create(7, 5000, 600, 500);
    expect(sim.population).toBe(5000);
    for (let t = 60_000; t <= 12 * 3_600_000; t += 60_000) {
      sim.advanceTo(t);
      sim.flush(() => undefined);
      expect(sim.population).toBe(5000);
    }
    const stats = sim.snapshotStats();
    expect(stats.emissions).toBeGreaterThan(1000);
    expect(stats.collapses).toBeGreaterThan(1000);
  }, 60_000);

  it('fills the streets in the morning peak and empties the station, then refills it in the evening', () => {
    const night = create(2, 5000, 600, 200);
    night.advanceTo(3_600_000); // 03:00
    const walkingAtNight = night.snapshotStats().walking;

    const day = create(7, 5000, 600, 200);
    const stationAt7 = day.aggregateOf(4);
    day.advanceTo(1.5 * 3_600_000); // 08:30
    const walkingInPeak = day.snapshotStats().walking;
    const stationAt830 = day.aggregateOf(4);
    day.advanceTo(9.5 * 3_600_000); // 16:30
    const stationAfternoon = day.aggregateOf(4);
    day.advanceTo(12 * 3_600_000); // 19:00
    const stationEvening = day.aggregateOf(4);

    expect(walkingInPeak).toBeGreaterThan(walkingAtNight * 3);
    expect(stationAt830).toBeLessThan(stationAt7);
    expect(stationEvening).toBeGreaterThan(stationAfternoon);
  }, 60_000);

  it('keeps everyone outdoors in showcase mode', () => {
    const tile = town();
    const sim = new CitySimulation({
      tile,
      graph: simGraphFromTile(tile),
      agents: 800,
      population: 800,
      startHour: 8,
      startWalkingShare: 1,
      stayOutdoors: true,
      robotShare: 1,
      seed: 5,
      human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
      robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
      humanVariants: 1,
      records: new DataView(new ArrayBuffer(800 * AGENT_RECORD_BYTES)),
      tickMs: 100,
    });
    sim.advanceTo(1_800_000);
    const stats = sim.snapshotStats();
    expect(stats.walking + stats.waiting).toBe(800);
    expect(stats.indoor).toBe(0);
    expect(stats.collapses).toBe(0);
  }, 60_000);
});
