/**
 * OSM → navigation tiles (implementation plan §10, milestone M2).
 *
 *   yarn workspace @city/osm-pipeline build-region [--region canary-wharf] [--pbf <file>] [--out <dir>]
 *
 * Needs `osmium` (Homebrew: osmium-tool) and a Geofabrik extract in data/raw/. Paths are relative
 * to the repository root.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type NavTile,
  readTileContainer,
  type RegionManifest,
  writeRoadNetwork,
} from '@city/formats';
import { stitchTiles } from '@city/nav';
import { parseOplStream } from './opl.ts';
import { connectivity, gateFailures } from './qa.ts';
import { LocalFrame } from './projection.ts';
import { buildArea } from './build-area.ts';
import { REGIONS } from './regions.ts';
import { extractRoadNetwork } from './roads.ts';
import { applyRoadTerrain, loadTerrain, TERRAIN_SOURCE } from './terrain.ts';
import { packRegion } from './write-region.ts';
import { writeDebugGeoJson } from './debug-geojson.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const regionId = argument('region') ?? 'canary-wharf';
const region = REGIONS[regionId];
if (region === undefined)
  throw new Error(`Unknown region ${regionId}; known: ${Object.keys(REGIONS).join(', ')}`);
const pbf = resolve(root, argument('pbf') ?? newestExtract());
const out = resolve(root, argument('out') ?? `apps/city/public/regions/${regionId}`);
/** Streaming tile size (plan §16: a pipeline parameter, chosen by the tile-size benchmark). */
const gridSizeM = Number(argument('tile-size') ?? 256);
if (!(gridSizeM > 0)) throw new Error(`Bad --tile-size ${argument('tile-size') ?? ''}`);
const work = resolve(root, `data/work/${regionId}`);

function newestExtract(): string {
  const raw = join(root, 'data/raw');
  const candidates = existsSync(raw)
    ? readdirSync(raw)
        .filter((f) => f.endsWith('.osm.pbf'))
        .sort()
    : [];
  const newest = candidates.at(-1);
  if (newest === undefined)
    throw new Error('No .osm.pbf in data/raw; download a Geofabrik extract first');
  return join('data/raw', newest);
}

function osmium(args: string[]): string {
  return execFileSync('osmium', args, { cwd: root, maxBuffer: 1 << 30, encoding: 'utf8' });
}

const t0 = performance.now();
const step = (label: string): void => {
  console.log(`[${((performance.now() - t0) / 1000).toFixed(1)} s] ${label}`);
};
mkdirSync(work, { recursive: true });

// Stage 1: extract and filter.
const [west, south, east, north] = region.bboxWgs84;

/**
 * `--roads-only --roads-bbox w,s,e,n`: a road network over a larger area than the region (traffic
 * can drive London-wide around a smaller pedestrian region), in the region's frame. Only highway
 * ways are read, so even a 20 km city parses in a few hundred MB.
 */
const roadsBbox = argument('roads-bbox');
if (process.argv.includes('--roads-only') && roadsBbox !== undefined) {
  const [rw = 0, rs = 0, re = 0, rn = 0] = roadsBbox.split(',').map(Number);
  step(`osmium extract highways in ${roadsBbox}`);
  osmium([
    'extract',
    '--bbox',
    roadsBbox,
    '--strategy',
    'complete_ways',
    '-O',
    '-o',
    join(work, 'roads-extract.osm.pbf'),
    pbf,
  ]);
  osmium([
    'tags-filter',
    '-O',
    '-o',
    join(work, 'roads.osm.pbf'),
    join(work, 'roads-extract.osm.pbf'),
    'w/highway',
  ]);
  const roadsCat = spawn('osmium', ['cat', '-f', 'opl', join(work, 'roads.osm.pbf')], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const roadData = await parseOplStream(
    createInterface({ input: roadsCat.stdout, crlfDelay: Infinity }),
  );
  const roadFrame = new LocalFrame((west + east) / 2, (south + north) / 2);
  const roadPositions = new Map<number, [number, number]>();
  for (const node of roadData.nodes.values())
    roadPositions.set(node.id, roadFrame.toLocal(node.lon, node.lat));
  const [x0, y0] = roadFrame.toLocal(rw, rs);
  const [x1, y1] = roadFrame.toLocal(re, rn);
  const {
    roads: wide,
    km,
    onGround,
  } = extractRoadNetwork(roadData, roadPositions, {
    minX: Math.min(x0, x1),
    minY: Math.min(y0, y1),
    maxX: Math.max(x0, x1),
    maxY: Math.max(y0, y1),
  });
  const manifestFile = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as RegionManifest;
  if (
    manifest.origin.easting !== roadFrame.easting ||
    manifest.origin.northing !== roadFrame.northing
  )
    throw new Error('The built region has a different origin; rebuild it fully');
  // Heights at the region's terrain zero, so cars meet the walking graph (4 m terrain by default:
  // the road box can be London's 20 km).
  if (manifest.terrain !== undefined && !process.argv.includes('--no-terrain')) {
    const pixelM = Number(argument('roads-terrain-res') ?? 4);
    step(`road terrain at ${pixelM} m`);
    const t = await loadTerrain(
      {
        minE: roadFrame.easting + Math.min(x0, x1) - 50,
        minN: roadFrame.northing + Math.min(y0, y1) - 50,
        maxE: roadFrame.easting + Math.max(x0, x1) + 50,
        maxN: roadFrame.northing + Math.max(y0, y1) + 50,
      },
      pixelM,
      join(root, 'data/raw/dtm'),
    );
    const qa = applyRoadTerrain(wide, onGround, t, roadFrame, manifest.terrain.zeroM);
    step(`road heights: ${qa.nodes} nodes, ${qa.filledFromNeighbours} on bridges or tunnels`);
  }
  const entry = {
    file: 'roads.bin',
    nodes: wide.nodeX.length,
    edges: wide.edgeFrom.length,
    km: Math.round(km * 10) / 10,
    bboxWgs84: [rw, rs, re, rn] as [number, number, number, number],
  };
  writeFileSync(join(out, entry.file), new Uint8Array(writeRoadNetwork(wide)));
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, roads: entry }, null, 2)}\n`);
  step(
    `roads: ${entry.edges} directed edges, ${entry.km} km → ${relative(root, join(out, entry.file))}`,
  );
  process.exit(0);
}

step(`osmium extract ${region.name} from ${relative(root, pbf)}`);
osmium([
  'extract',
  '--bbox',
  `${west},${south},${east},${north}`,
  '--strategy',
  'complete_ways',
  '-O',
  '-o',
  join(work, 'extract.osm.pbf'),
  pbf,
]);
osmium([
  'tags-filter',
  '-O',
  '-o',
  join(work, 'filtered.osm.pbf'),
  join(work, 'extract.osm.pbf'),
  'w/highway',
  'w/building',
  'w/building:part',
  'r/type=multipolygon',
  'n/entrance',
  'n/door',
  'n/railway=station,subway_entrance,train_station_entrance',
]);
const cat = spawn('osmium', ['cat', '-f', 'opl', join(work, 'filtered.osm.pbf')], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const data = await parseOplStream(createInterface({ input: cat.stdout, crlfDelay: Infinity }));
step(`parsed ${data.nodes.size} nodes, ${data.ways.size} ways, ${data.relations.size} relations`);

// Stage 2: project to a local BNG frame centred on the region.
const frame = new LocalFrame((west + east) / 2, (south + north) / 2);
const corners = [
  frame.toLocal(west, south),
  frame.toLocal(east, south),
  frame.toLocal(east, north),
  frame.toLocal(west, north),
];
// The lon/lat box is slightly rotated in BNG: use the largest axis-aligned box inside it.
const bounds = {
  minX: Math.max(corners[0][0], corners[3][0]),
  maxX: Math.min(corners[1][0], corners[2][0]),
  minY: Math.max(corners[0][1], corners[1][1]),
  maxY: Math.min(corners[2][1], corners[3][1]),
};
const positions = new Map<number, [number, number]>();
for (const node of data.nodes.values()) positions.set(node.id, frame.toLocal(node.lon, node.lat));

// Traffic: the drivable road network, written next to the tiles.
const {
  roads: drivable,
  km: roadKm,
  onGround: roadOnGround,
} = extractRoadNetwork(data, positions, bounds);
const roadsEntry = {
  file: 'roads.bin',
  nodes: drivable.nodeX.length,
  edges: drivable.edgeFrom.length,
  km: Math.round(roadKm * 10) / 10,
};
step(`roads: ${roadsEntry.edges} directed edges, ${roadsEntry.km} km`);
if (process.argv.includes('--roads-only')) {
  // Adds the road network to an already built region without rebuilding its tiles.
  const manifestFile = join(out, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as RegionManifest;
  if (manifest.origin.easting !== frame.easting || manifest.origin.northing !== frame.northing)
    throw new Error('The built region has a different origin; rebuild it fully');
  if (manifest.terrain !== undefined && !process.argv.includes('--no-terrain')) {
    const t = await loadTerrain(
      {
        minE: frame.easting + bounds.minX - 50,
        minN: frame.northing + bounds.minY - 50,
        maxE: frame.easting + bounds.maxX + 50,
        maxN: frame.northing + bounds.maxY + 50,
      },
      manifest.terrain.pixelM,
      join(root, 'data/raw/dtm'),
    );
    applyRoadTerrain(drivable, roadOnGround, t, frame, manifest.terrain.zeroM);
  }
  writeFileSync(join(out, roadsEntry.file), new Uint8Array(writeRoadNetwork(drivable)));
  writeFileSync(manifestFile, `${JSON.stringify({ ...manifest, roads: roadsEntry }, null, 2)}\n`);
  step(`wrote ${relative(root, join(out, roadsEntry.file))}`);
  process.exit(0);
}

// Stages 3–11.
const grid = { originX: bounds.minX, originY: bounds.minY, sizeM: gridSizeM };
// Ground heights (Phase 3 of the 3D Tiles plan): on unless --no-terrain; --terrain-res metres.
const terrainPixelM = Number(argument('terrain-res') ?? 2);
const terrain = process.argv.includes('--no-terrain')
  ? undefined
  : await (async () => {
      step(`terrain at ${terrainPixelM} m`);
      const t = await loadTerrain(
        {
          minE: frame.easting + bounds.minX - 50,
          minN: frame.northing + bounds.minY - 50,
          maxE: frame.easting + bounds.maxX + 50,
          maxN: frame.northing + bounds.maxY + 50,
        },
        terrainPixelM,
        join(root, 'data/raw/dtm'),
      );
      return { terrain: t, zero: 'median' as const };
    })();
const { tile, tiled, topology, buildings, qa } = buildArea({
  data,
  frame,
  bounds,
  positions,
  grid,
  landMasses: region.landMasses,
  step,
  terrain,
});
if (terrain !== undefined)
  applyRoadTerrain(drivable, roadOnGround, terrain.terrain, frame, qa['terrain.zeroM'] ?? 0);
const roadsBinary = writeRoadNetwork(drivable);
const md5File = `${pbf}.md5`;
const packed = packRegion(tiled.tiles, tiled.buildingOffset, {
  region: regionId,
  origin: { crs: 'EPSG:27700', easting: frame.easting, northing: frame.northing },
  bboxWgs84: region.bboxWgs84,
  tileSizeM: gridSizeM,
  gridOrigin: { x: grid.originX, y: grid.originY },
  roads: roadsEntry,
  ...(terrain === undefined
    ? {}
    : {
        terrain: {
          source: TERRAIN_SOURCE,
          datum: 'ODN' as const,
          zeroM: Math.round((qa['terrain.zeroM'] ?? 0) * 100) / 100,
          pixelM: terrainPixelM,
        },
      }),
  qa,
  build: {
    source: relative(root, pbf),
    ...(existsSync(md5File)
      ? { sourceMd5: readFileSync(md5File, 'utf8').split(/\s/)[0] ?? '' }
      : {}),
    tool: `@city/osm-pipeline, osmium ${osmium(['--version']).split('\n')[0]?.replace('osmium version ', '') ?? '?'}`,
    createdAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors, ODbL',
  },
});

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'debug'), { recursive: true });
for (const [name, buffer] of Object.entries(packed.binaries))
  writeFileSync(join(out, name), new Uint8Array(buffer));
writeFileSync(join(out, roadsEntry.file), new Uint8Array(roadsBinary));
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(packed.manifest, null, 2)}\n`);
writeDebugGeoJson(join(out, 'debug'), topology, buildings, (x, y) => frame.toWgs84(x, y));

// Round-trip check: every tile reads back identically, and the tiles stitched together behave
// exactly like the untiled region graph (same lengths per OSM way, same connectivity).
const readTiles = packed.manifest.tiles.map((entry, t) => {
  const read = readTileContainer(toArrayBuffer(readFileSync(join(out, entry.file))));
  if (digest(read) !== digest(tiled.tiles[t]))
    throw new Error(`Round-trip mismatch in tile ${entry.x},${entry.y}`);
  return read;
});
const stitched = stitchTiles({
  tiles: readTiles,
  buildingOffset: packed.manifest.tiles.map((entry) => entry.buildingOffset),
  gridOrigin: packed.manifest.gridOrigin,
  tileSizeM: gridSizeM,
});
verifyStitch(tile, stitched, region.landMasses);
const bytes = Object.values(packed.binaries).reduce((n, b) => n + b.byteLength, 0);
step(
  `wrote ${relative(root, out)} (${(bytes / 1024).toFixed(0)} KiB in ${packed.manifest.tiles.length} tiles, round-trip and stitch verified)`,
);
console.log(JSON.stringify(qa, null, 2));

// Stage 10: QA gates. Outputs stay on disk for inspection in the viewer either way.
const failures = gateFailures(qa, region.gates);
if (failures.length > 0) {
  console.error(`QA gates failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else {
  console.log(`QA gates passed (${Object.keys(region.gates).length})`);
}

/** The stitched tiles must match the region: length per OSM way, connectivity, entrances. */
function verifyStitch(region: NavTile, joined: NavTile, landMasses: number): void {
  const lengths = (t: NavTile) => {
    const map = new Map<string, number>();
    for (let e = 0; e < t.edges.from.length; e++) {
      const key = `${t.edges.osmIdHi[e]}:${t.edges.osmIdLo[e]}:${t.edges.type[e]}`;
      map.set(key, (map.get(key) ?? 0) + t.edges.length[e]);
    }
    return map;
  };
  const a = lengths(region);
  const b = lengths(joined);
  if (a.size !== b.size) throw new Error(`Stitch: ${a.size} ways before, ${b.size} after`);
  for (const [key, length] of a) {
    const other = b.get(key) ?? 0;
    if (Math.abs(other - length) > 0.01 + length * 1e-5)
      throw new Error(`Stitch: way ${key} is ${length} m untiled, ${other} m stitched`);
  }
  const before = connectivity(region, landMasses);
  const after = connectivity(joined, landMasses);
  for (const key of [
    'connectedShare',
    'entrances',
    'entranceConnectedShare',
    'buildingsReachableShare',
  ] as const) {
    if (Math.abs(before[key] - after[key]) > 1e-6)
      throw new Error(`Stitch: ${key} ${before[key]} untiled, ${after[key]} stitched`);
  }
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function digest(value: unknown): string {
  const hash = createHash('sha256');
  const walk = (v: unknown): void => {
    if (ArrayBuffer.isView(v)) hash.update(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    else if (typeof v === 'object' && v !== null)
      for (const key of Object.keys(v).sort()) walk((v as Record<string, unknown>)[key]);
    else hash.update(String(v));
  };
  walk(value);
  return hash.digest('hex');
}
