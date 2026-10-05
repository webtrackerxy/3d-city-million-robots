/**
 * Tile-size benchmark (implementation plan §16, milestone M5): what the streaming tile size costs,
 * from regions built at several sizes (`yarn region --tile-size N --out …`).
 *
 *   yarn workspace @city/sim-bench tile-bench [dir …] [--agents 100000] [--seconds 60]
 *
 * Per size: tiles, portals and bytes per tile; stitching time; the tiles and bytes within 150 /
 * 500 / 1000 m of three foci (the streaming working set); and, running the city simulation on the
 * stitched graph, tile-boundary crossings per second (hand-offs once tiers are tile-granular) and
 * the simulation cost of the extra boundary segments. Browser-side load and render costs are
 * measured separately in the city app.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type NavTile, readTileContainer, type RegionManifest } from '@city/formats';
import { simGraphFromTile, stitchTiles } from '@city/nav';
import { CitySimulation } from '@city/sim';

const root = resolve(import.meta.dirname, '../../..');
const argument = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const dirs = process.argv
  .slice(2)
  .filter((a, i, all) => !a.startsWith('--') && !all[i - 1]?.startsWith('--'));
const regions = dirs.length > 0 ? dirs : ['canary-wharf-128', 'canary-wharf', 'canary-wharf-512'];
const AGENTS = Number(argument('agents') ?? 100_000);
const SECONDS = Number(argument('seconds') ?? 60);
const WARMUP_S = 10;
const RADII = [150, 500, 1000];
/** Foci in the region frame: Canary Wharf centre, a street near One Canada Square, the Isle's south. */
const FOCI = [
  { x: 0, y: 0 },
  { x: 150, y: 160 },
  { x: -200, y: -700 },
];

interface Result {
  region: string;
  tileSizeM: number;
  tiles: number;
  portals: number;
  bytesTotal: number;
  bytesPerTile: { mean: number; max: number };
  readMsPerTile: { mean: number; max: number };
  stitchMs: number;
  stitchedNodes: number;
  stitchedEdges: number;
  simSegments: number;
  working: { radiusM: number; tiles: number; bytes: number }[];
  sim: {
    agents: number;
    seconds: number;
    boundaryCrossingsPerS: number;
    edgeEntriesPerS: number;
    eventsPerS: number;
    workerMsPerSimS: number;
  };
}

const results: Result[] = [];
for (const region of regions) {
  const dir = resolve(root, 'apps/city/public/regions', region);
  const manifest = JSON.parse(
    readFileSync(resolve(dir, 'manifest.json'), 'utf8'),
  ) as RegionManifest;
  const size = manifest.tileSizeM;
  const readMs: number[] = [];
  const tiles: NavTile[] = manifest.tiles.map((entry) => {
    const b = readFileSync(resolve(dir, entry.file));
    const buffer = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const t0 = performance.now();
    const tile = readTileContainer(buffer);
    readMs.push(performance.now() - t0);
    return tile;
  });
  const t0 = performance.now();
  const stitched = stitchTiles({
    tiles,
    buildingOffset: manifest.tiles.map((e) => e.buildingOffset),
    gridOrigin: manifest.gridOrigin,
    tileSizeM: size,
  });
  const stitchMs = performance.now() - t0;

  const bytes = manifest.tiles.map((e) => e.bytes);
  const working = RADII.map((radiusM) => {
    let count = 0;
    let sum = 0;
    for (const focus of FOCI)
      for (const entry of manifest.tiles) {
        // Distance from the focus to the tile's square.
        const x0 = manifest.gridOrigin.x + entry.x * size;
        const y0 = manifest.gridOrigin.y + entry.y * size;
        const dx = Math.max(x0 - focus.x, 0, focus.x - (x0 + size));
        const dy = Math.max(y0 - focus.y, 0, focus.y - (y0 + size));
        if (Math.hypot(dx, dy) <= radiusM) {
          count++;
          sum += entry.bytes;
        }
      }
    return { radiusM, tiles: count / FOCI.length, bytes: sum / FOCI.length };
  });

  // Boundary nodes: those on a grid line (cut points; original nodes almost never are).
  const onLine = (v: number, origin: number) => {
    const r = (((v - origin) % size) + size) % size;
    return r < 1e-3 || size - r < 1e-3;
  };
  const boundary = new Uint8Array(stitched.nodes.x.length);
  for (let n = 0; n < boundary.length; n++)
    if (
      onLine(stitched.nodes.x[n] ?? 0, manifest.gridOrigin.x) ||
      onLine(stitched.nodes.y[n] ?? 0, manifest.gridOrigin.y)
    )
      boundary[n] = 1;

  const graph = simGraphFromTile(stitched);
  let crossings = 0;
  let entries = 0;
  let measuring = false;
  const records = new DataView(new ArrayBuffer(AGENTS * 24));
  const sim = new CitySimulation({
    tile: stitched,
    graph,
    agents: AGENTS,
    robotShare: 0.2,
    seed: 1,
    human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
    robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
    humanVariants: 1,
    records,
    focus: { x: 150, z: -160 },
    onEnterEdge: (_agent, navHalf) => {
      if (!measuring) return;
      entries++;
      const e = navHalf >>> 1;
      const start = (navHalf & 1) === 0 ? stitched.edges.from[e] : stitched.edges.to[e];
      if (boundary[start ?? 0] === 1) crossings++;
    },
  });
  sim.advanceTo(WARMUP_S * 1000);
  sim.flush(() => undefined);
  const eventsBefore = sim.snapshotStats().events;
  measuring = true;
  const simStart = performance.now();
  for (let t = WARMUP_S * 1000; t <= (WARMUP_S + SECONDS) * 1000; t += 100) {
    sim.advanceTo(t);
    sim.flush(() => undefined);
  }
  const simMs = performance.now() - simStart;
  const events = sim.snapshotStats().events - eventsBefore;

  const result: Result = {
    region,
    tileSizeM: size,
    tiles: manifest.tiles.length,
    portals: manifest.tiles.reduce((n, e) => n + e.counts.portals, 0),
    bytesTotal: bytes.reduce((a, b) => a + b, 0),
    bytesPerTile: {
      mean: bytes.reduce((a, b) => a + b, 0) / bytes.length,
      max: Math.max(...bytes),
    },
    readMsPerTile: {
      mean: readMs.reduce((a, b) => a + b, 0) / readMs.length,
      max: Math.max(...readMs),
    },
    stitchMs,
    stitchedNodes: stitched.nodes.x.length,
    stitchedEdges: stitched.edges.from.length,
    simSegments: graph.edgeCount,
    working,
    sim: {
      agents: AGENTS,
      seconds: SECONDS,
      boundaryCrossingsPerS: crossings / SECONDS,
      edgeEntriesPerS: entries / SECONDS,
      eventsPerS: events / SECONDS,
      workerMsPerSimS: simMs / SECONDS,
    },
  };
  results.push(result);
  console.log(JSON.stringify(result));
}

const out = argument('out');
if (out !== undefined) writeFileSync(resolve(root, out), `${JSON.stringify(results, null, 2)}\n`);
