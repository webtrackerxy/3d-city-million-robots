/**
 * M7 exit measurement (implementation plan §26): 1M people on the Docklands region — how many are
 * aggregated in buildings (T3), individually simulated and event-driven (T2), ticked with
 * avoidance (T0), at five times of day; worker CPU per simulated second; memory against §21.
 * (What is rendered is measured in the browser.)
 *
 *   yarn workspace @city/sim-bench m7-bench [--population 1000000] [--rows 200000] [--out file]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { appendRoofs } from '@city/buildings';
import { BuildingFlag, NodeType } from '@city/core-types';
import { readTileContainer, type RegionManifest } from '@city/formats';
import { simGraphFromTile, stitchTiles } from '@city/nav';
import { CitySimulation } from '@city/sim';

const root = resolve(import.meta.dirname, '../../..');
const argument = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const POPULATION = Number(argument('population') ?? 1_000_000);
const ROWS = Number(argument('rows') ?? 200_000);
const HOURS = (argument('hours') ?? '3,8.5,13,18,22').split(',').map(Number);
const WARMUP_S = Number(argument('warmup') ?? 600);
const MEASURE_S = 60;

const dir = resolve(root, 'apps/city/public/regions/docklands');
const manifest = JSON.parse(readFileSync(resolve(dir, 'manifest.json'), 'utf8')) as RegionManifest;
const tiles = manifest.tiles.map((entry) => {
  const b = readFileSync(resolve(dir, entry.file));
  return readTileContainer(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
});
const region = stitchTiles({
  tiles,
  buildingOffset: manifest.tiles.map((e) => e.buildingOffset),
  gridOrigin: manifest.gridOrigin,
  tileSizeM: manifest.tileSizeM,
});
// Focus: among the 12 tallest buildings with entrances (Canary Wharf's towers).
const withEntrance = new Set<number>();
for (let n = 0; n < region.nodes.x.length; n++)
  if (region.nodes.type[n] === NodeType.Entrance)
    withEntrance.add(region.nodes.buildingId[n] ?? -1);
const candidates: [number, number][] = [];
for (let b = 0; b < region.buildings.ringOffset.length; b++) {
  const flags = region.buildings.flags[b] ?? 0;
  if ((flags & (BuildingFlag.Part | BuildingFlag.HasParts | BuildingFlag.Virtual)) !== 0) continue;
  if ((region.buildings.levels[b] ?? 0) < 2 || !withEntrance.has(b)) continue;
  candidates.push([b, region.buildings.height[b] ?? 0]);
}
const tallest = candidates
  .sort((a, b) => b[1] - a[1])
  .slice(0, 12)
  .map(([b]) => b);
const towers = tallest.map((b) => {
  const o = region.buildings.ringOffset[b] ?? 0;
  return { x: region.buildings.ringX[o] ?? 0, y: region.buildings.ringY[o] ?? 0 };
});
const cw = {
  x: towers.reduce((n, t) => n + t.x, 0) / towers.length,
  y: towers.reduce((n, t) => n + t.y, 0) / towers.length,
};
const roofs = appendRoofs(region);
const graph = simGraphFromTile(roofs.tile);
console.log(
  `docklands: ${region.nodes.x.length} nodes, ${region.edges.from.length} edges, ${region.buildings.ringOffset.length} buildings; ${roofs.roofs} roof walks, +${roofs.tile.nodes.x.length - region.nodes.x.length} roof nodes`,
);

const results = [];
for (const hour of HOURS) {
  const heapBefore = process.memoryUsage();
  const t0 = performance.now();
  const sim = new CitySimulation({
    tile: roofs.tile,
    graph,
    agents: ROWS,
    population: POPULATION,
    startHour: hour,
    robotShare: 0.2,
    seed: 1,
    human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
    robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
    humanVariants: 1,
    records: new DataView(new ArrayBuffer(ROWS * 24)),
    firstRoofEdge: roofs.firstRoofEdge,
    roofShare: 0.1,
    focus: { x: cw.x, z: -cw.y },
  });
  const setupMs = performance.now() - t0;
  for (let t = 1000; t <= WARMUP_S * 1000; t += 1000) {
    sim.advanceTo(t);
    sim.flush(() => undefined);
  }
  const before = sim.snapshotStats();
  let records = 0;
  const start = performance.now();
  for (let t = WARMUP_S * 1000 + 1000; t <= (WARMUP_S + MEASURE_S) * 1000; t += 1000) {
    sim.advanceTo(t);
    records += sim.flush(() => undefined);
  }
  const workerMs = performance.now() - start;
  const s = sim.snapshotStats();
  const heapAfter = process.memoryUsage();
  const memory = sim.memoryReport();
  const result = {
    hour,
    timeOfDay: `${String(Math.floor(hour)).padStart(2, '0')}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`,
    population: sim.population,
    split: {
      aggregated: s.indoor,
      rows: ROWS - s.freeRows,
      walking: s.walking,
      waiting: s.waiting,
      onRoof: s.onRoof,
      ticked: s.nearTier,
    },
    eventsPerS: (s.events - before.events) / MEASURE_S,
    recordsPerS: records / MEASURE_S,
    workerMsPerSimS: workerMs / MEASURE_S,
    blockedEmissions: s.blockedEmissions,
    tablesBuilt: s.tablesBuilt,
    setupMs,
    memory: {
      ...memory,
      heapDeltaMb: (heapAfter.heapUsed - heapBefore.heapUsed) / 2 ** 20,
      arrayBuffersMb: heapAfter.arrayBuffers / 2 ** 20,
    },
  };
  results.push(result);
  console.log(JSON.stringify(result));
}
const out = argument('out');
if (out !== undefined) writeFileSync(resolve(root, out), `${JSON.stringify(results, null, 2)}\n`);
