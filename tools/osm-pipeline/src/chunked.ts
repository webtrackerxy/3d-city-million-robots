/**
 * Chunked region build, for a city too large to hold in memory at once (London: 20 × 20 km,
 * 470k buildings).
 *
 *   yarn workspace @city/osm-pipeline build-chunked --region london [--chunk-tiles 10] [--margin 400]
 *
 * The region's tile grid is cut into chunks of `chunk-tiles` × `chunk-tiles` tiles. Each chunk is
 * built on its own (stages 3–11, build-area.ts) from its core plus a margin, on the region's frame
 * and grid, and keeps only its core tiles. The margin makes the geometry at a seam the same seen
 * from either side, so after all chunks:
 *
 * - portals across a seam are re-linked by position (the chunk's own `otherNode` indices point into
 *   its throwaway copy of the neighbour tile);
 * - building ids are renumbered region-wide, tile by tile; an entrance's building (which may sit in
 *   a tile of another chunk) is found again by its OSM id.
 *
 * Tiles go to disk as each chunk finishes; memory stays at one chunk's worth.
 */
import { applyRoadTerrain, loadTerrain, TERRAIN_SOURCE } from './terrain.ts';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { BuildingFlag, NO_BUILDING, NodeType } from '@city/core-types';
import {
  type NavTile,
  readTileContainer,
  type RegionManifest,
  writeNavTile,
  writeRoadNetwork,
  writeTileContainer,
} from '@city/formats';
import { stitchTiles } from '@city/nav';
import { buildArea } from './build-area.ts';
import type { Point } from './geometry.ts';
import { parseOplStream } from './opl.ts';
import { LocalFrame } from './projection.ts';
import { gateFailures } from './qa.ts';
import { REGIONS } from './regions.ts';
import { extractRoadNetwork } from './roads.ts';
import { buildingsOnly, withoutOutlines } from './slim.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const regionId = argument('region') ?? 'london';
const region = REGIONS[regionId];
if (region === undefined) throw new Error(`Unknown region ${regionId}`);
const pbf = resolve(root, argument('pbf') ?? 'data/raw/greater-london-260927.osm.pbf');
const out = resolve(root, argument('out') ?? `apps/city/public/regions/${regionId}`);
const work = resolve(root, `data/work/${regionId}`);
const TILE_M = 256;
const chunkTiles = Number(argument('chunk-tiles') ?? 10);
const marginM = Number(argument('margin') ?? 400);
/** Seam portals further apart than this are not the same crossing point. */
const SEAM_TOLERANCE_M = 2;

const t0 = performance.now();
const step = (label: string): void => {
  console.log(`[${((performance.now() - t0) / 1000).toFixed(1)} s] ${label}`);
};
const osmium = (args: string[]) =>
  execFileSync('osmium', args, { cwd: root, maxBuffer: 1 << 26, encoding: 'utf8' });
const parse = async (file: string) => {
  const cat = spawn('osmium', ['cat', '-f', 'opl', file], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  return parseOplStream(createInterface({ input: cat.stdout, crlfDelay: Infinity }));
};

/**
 * The whole graph stitched once into `region.nav`; returns its entry for the manifest. Each thing
 * is then kept once: region.nav drops the building outlines and every tile drops its walking graph
 * (see slim.ts), and the tiles' `bytes` are updated in place.
 */
function writeRegionGraph(
  entries: RegionManifest['tiles'],
  gridOrigin: { x: number; y: number },
): NonNullable<RegionManifest['graph']> {
  step('stitching the region graph');
  const tiles = entries.map((entry) =>
    readTileContainer(toArrayBuffer(readFileSync(join(out, entry.file)))),
  );
  tiles.forEach((tile, i) => {
    if (tile.nodes.x.length === 0 && (entries[i]?.counts.nodes ?? 0) > 0)
      throw new Error(
        `${entries[i]?.file ?? ''} holds buildings only: rebuild the region to stitch it again`,
      );
  });
  const stitched = stitchTiles({
    tiles,
    buildingOffset: entries.map((entry) => entry.buildingOffset),
    gridOrigin,
    tileSizeM: TILE_M,
  });
  const container = writeTileContainer(writeNavTile(withoutOutlines(stitched)));
  writeFileSync(join(out, 'region.nav'), new Uint8Array(container));
  step(
    `region.nav: ${stitched.nodes.x.length} nodes, ${stitched.edges.from.length} edges, ${(container.byteLength / 1024 / 1024).toFixed(0)} MB`,
  );
  let tileBytes = 0;
  entries.forEach((entry, i) => {
    const slim = writeTileContainer(writeNavTile(buildingsOnly(tiles[i])));
    writeFileSync(join(out, entry.file), new Uint8Array(slim));
    entry.bytes = slim.byteLength;
    tileBytes += slim.byteLength;
  });
  step(`tiles: buildings only, ${(tileBytes / 1024 / 1024).toFixed(0)} MB`);
  return { file: 'region.nav', bytes: container.byteLength, buildingOutlines: 'tiles' };
}

if (process.argv.includes('--stitch-only')) {
  const file = join(out, 'manifest.json');
  const built = JSON.parse(readFileSync(file, 'utf8')) as RegionManifest;
  const graph = writeRegionGraph(built.tiles, built.gridOrigin);
  writeFileSync(file, `${JSON.stringify({ ...built, graph }, null, 2)}\n`);
  process.exit(0);
}

mkdirSync(join(work, 'tiles'), { recursive: true });
const [west, south, east, north] = region.bboxWgs84;
const frame = new LocalFrame((west + east) / 2, (south + north) / 2);
const corners = [
  frame.toLocal(west, south),
  frame.toLocal(east, south),
  frame.toLocal(east, north),
  frame.toLocal(west, north),
];
const bounds = {
  minX: Math.max(corners[0][0], corners[3][0]),
  maxX: Math.min(corners[1][0], corners[2][0]),
  minY: Math.max(corners[0][1], corners[1][1]),
  maxY: Math.min(corners[2][1], corners[3][1]),
};
const grid = { originX: bounds.minX, originY: bounds.minY, sizeM: TILE_M };
// Ground heights for the whole region, once (Phase 3 of the 3D Tiles plan): on unless
// --no-terrain; --terrain-res metres (4 by default: London at 1 m would be 1.6 GB).
const terrainPixelM = Number(argument('terrain-res') ?? 4);
const terrain = process.argv.includes('--no-terrain')
  ? undefined
  : await (async () => {
      const t = await loadTerrain(
        {
          minE: frame.easting + bounds.minX - 50,
          minN: frame.northing + bounds.minY - 50,
          maxE: frame.easting + bounds.maxX + 50,
          maxN: frame.northing + bounds.maxY + 50,
        },
        terrainPixelM,
        join(root, 'data/raw/dtm'),
        (message) => {
          console.log(message);
        },
      );
      // One zero for every chunk: the median ground on a 200 m grid over the region (a chunk's
      // own node median would differ from its neighbours' and break the seams).
      const samples: number[] = [];
      for (let x = bounds.minX; x <= bounds.maxX; x += 200)
        for (let y = bounds.minY; y <= bounds.maxY; y += 200) {
          const h = t.sample(frame.easting + x, frame.northing + y);
          if (h !== null) samples.push(h);
        }
      samples.sort((a, b) => a - b);
      return { terrain: t, zero: samples[Math.floor(samples.length / 2)] ?? 0 };
    })();
const tilesX = Math.ceil((bounds.maxX - bounds.minX) / TILE_M);
const tilesY = Math.ceil((bounds.maxY - bounds.minY) / TILE_M);

// The region's filtered extract, once; chunks are cut from it.
const filtered = join(work, 'filtered.osm.pbf');
if (!existsSync(filtered) || process.argv.includes('--fresh')) {
  step(`osmium extract ${region.name}`);
  const extract = join(work, 'extract.osm.pbf');
  osmium([
    'extract',
    '--bbox',
    `${west},${south},${east},${north}`,
    '-s',
    'smart',
    '-O',
    '-o',
    extract,
    pbf,
  ]);
  osmium([
    'tags-filter',
    '-O',
    '-o',
    filtered,
    extract,
    'w/highway',
    'w/building',
    'w/building:part',
    'r/type=multipolygon',
    'n/entrance',
    'n/door',
    'n/railway=station,subway_entrance,train_station_entrance',
  ]);
  rmSync(extract);
}

interface SeamPortal {
  tile: string;
  portal: number;
  local: number;
  x: number;
  y: number;
  to: string;
}
interface KeptTile {
  key: string;
  tx: number;
  ty: number;
  nodes: number;
  /** Entrance nodes' buildings by OSM key (node index → key). */
  nodeBuilding: Map<number, string>;
  /** The tile's own buildings' OSM keys, in order. */
  buildingKeys: string[];
}
const keyOfTile = (tx: number, ty: number) => `${tx},${ty}`;
const buildingKey = (hi: number, lo: number, flags: number) =>
  `${hi}:${lo}:${flags & BuildingFlag.Virtual}`;
const kept = new Map<string, KeptTile>();
const seams: SeamPortal[] = [];
const qaSums: Record<string, number> = {};

const chunksX = Math.ceil(tilesX / chunkTiles);
const chunksY = Math.ceil(tilesY / chunkTiles);
step(`${tilesX} × ${tilesY} tiles in ${chunksX} × ${chunksY} chunks of ${chunkTiles}`);
for (let cy = 0; cy < chunksY; cy++)
  for (let cx = 0; cx < chunksX; cx++) {
    const tx0 = cx * chunkTiles;
    const ty0 = cy * chunkTiles;
    const tx1 = Math.min(tilesX, tx0 + chunkTiles);
    const ty1 = Math.min(tilesY, ty0 + chunkTiles);
    const inCore = (tx: number, ty: number) => tx >= tx0 && tx < tx1 && ty >= ty0 && ty < ty1;
    const chunkBounds = {
      minX: Math.max(bounds.minX, grid.originX + tx0 * TILE_M - marginM),
      minY: Math.max(bounds.minY, grid.originY + ty0 * TILE_M - marginM),
      maxX: Math.min(bounds.maxX, grid.originX + tx1 * TILE_M + marginM),
      maxY: Math.min(bounds.maxY, grid.originY + ty1 * TILE_M + marginM),
    };
    const lonLat = [
      frame.toWgs84(chunkBounds.minX, chunkBounds.minY),
      frame.toWgs84(chunkBounds.maxX, chunkBounds.minY),
      frame.toWgs84(chunkBounds.maxX, chunkBounds.maxY),
      frame.toWgs84(chunkBounds.minX, chunkBounds.maxY),
    ];
    const pad = 0.0005;
    const bbox = [
      Math.min(...lonLat.map((p) => p[0])) - pad,
      Math.min(...lonLat.map((p) => p[1])) - pad,
      Math.max(...lonLat.map((p) => p[0])) + pad,
      Math.max(...lonLat.map((p) => p[1])) + pad,
    ].join(',');
    const chunkFile = join(work, 'chunk.osm.pbf');
    osmium(['extract', '--bbox', bbox, '-s', 'smart', '-O', '-o', chunkFile, filtered]);
    const data = await parse(chunkFile);
    const positions = new Map<number, Point>();
    for (const node of data.nodes.values())
      positions.set(node.id, frame.toLocal(node.lon, node.lat));
    const label = `chunk ${cx},${cy}`;
    const area = buildArea({
      data,
      frame,
      bounds: chunkBounds,
      positions,
      grid,
      landMasses: region.landMasses,
      step: () => undefined,
      terrain,
    });
    for (const [name, value] of Object.entries(area.qa))
      if (!name.endsWith('Share')) qaSums[name] = (qaSums[name] ?? 0) + value;

    // Chunk-wide building id → OSM key.
    const chunkKeys: string[] = [];
    area.tiled.tiles.forEach((tile, t) => {
      const b = tile.buildings;
      const first = area.tiled.buildingOffset[t] ?? 0;
      for (let i = 0; i < b.ringOffset.length; i++)
        chunkKeys[first + i] = buildingKey(b.osmIdHi[i] ?? 0, b.osmIdLo[i] ?? 0, b.flags[i] ?? 0);
    });
    let keptHere = 0;
    for (const tile of area.tiled.tiles) {
      if (!inCore(tile.tileX, tile.tileY)) continue;
      const key = keyOfTile(tile.tileX, tile.tileY);
      const nodeBuilding = new Map<number, string>();
      tile.nodes.buildingId.forEach((b, n) => {
        if (b !== NO_BUILDING) nodeBuilding.set(n, chunkKeys[b] ?? '');
      });
      const buildingKeys: string[] = [];
      const b = tile.buildings;
      for (let i = 0; i < b.ringOffset.length; i++)
        buildingKeys.push(buildingKey(b.osmIdHi[i] ?? 0, b.osmIdLo[i] ?? 0, b.flags[i] ?? 0));
      const ox = grid.originX + tile.tileX * TILE_M;
      const oy = grid.originY + tile.tileY * TILE_M;
      const p = tile.portals;
      for (let k = 0; k < p.localNode.length; k++) {
        const tx = p.otherTileX[k] ?? 0;
        const ty = p.otherTileY[k] ?? 0;
        if (inCore(tx, ty)) continue;
        const local = p.localNode[k] ?? 0;
        seams.push({
          tile: key,
          portal: k,
          local,
          x: ox + (tile.nodes.x[local] ?? 0),
          y: oy + (tile.nodes.y[local] ?? 0),
          to: keyOfTile(tx, ty),
        });
      }
      writeFileSync(
        join(work, 'tiles', `tile_${tile.tileX}_${tile.tileY}.nav`),
        new Uint8Array(writeTileContainer(writeNavTile(tile))),
      );
      kept.set(key, {
        key,
        tx: tile.tileX,
        ty: tile.tileY,
        nodes: tile.nodes.x.length,
        nodeBuilding,
        buildingKeys,
      });
      keptHere++;
    }
    step(
      `${label}: ${keptHere} tiles, ${area.topology.nodes.length} graph nodes, ${area.buildings.length} buildings (${kept.size} tiles so far)`,
    );
  }

// Region-wide building ids, tile by tile.
const ordered = [...kept.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx);
const globalBuilding = new Map<string, number>();
const buildingOffset = new Map<string, number>();
let buildingCount = 0;
for (const tile of ordered) {
  buildingOffset.set(tile.key, buildingCount);
  for (const key of tile.buildingKeys) globalBuilding.set(key, buildingCount++);
}

// Seams: each portal to another chunk's tile is matched to that tile's portal back, by position.
const patch = new Map<string, Map<number, number>>();
const setPatch = (tile: string, portal: number, other: number) => {
  let map = patch.get(tile);
  if (map === undefined) patch.set(tile, (map = new Map<number, number>()));
  map.set(portal, other);
};
const byPair = new Map<string, SeamPortal[]>();
for (const s of seams) {
  const pair = `${s.tile}>${s.to}`;
  const list = byPair.get(pair);
  if (list === undefined) byPair.set(pair, [s]);
  else list.push(s);
}
let matched = 0;
for (const s of seams) {
  const back = byPair.get(`${s.to}>${s.tile}`) ?? [];
  let best: SeamPortal | null = null;
  let bestDistance = SEAM_TOLERANCE_M;
  for (const c of back) {
    const d = Math.hypot(c.x - s.x, c.y - s.y);
    if (d < bestDistance) {
      bestDistance = d;
      best = c;
    }
  }
  setPatch(s.tile, s.portal, best === null ? -1 : best.local);
  if (best !== null) matched++;
}
step(`seams: ${matched} of ${seams.length} portals matched across chunks`);

// Final pass: patch and write every tile; connectivity over the whole region by union-find.
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const nodeBase = new Map<string, number>();
let totalNodes = 0;
for (const tile of ordered) {
  nodeBase.set(tile.key, totalNodes);
  totalNodes += tile.nodes;
}
const parent = Int32Array.from({ length: totalNodes }, (_, i) => i);
const find = (i: number): number => {
  let r = i;
  while (parent[r] !== r) r = parent[r] ?? r;
  while (parent[i] !== r) {
    const next = parent[i] ?? r;
    parent[i] = r;
    i = next;
  }
  return r;
};
const union = (a: number, b: number) => {
  const ra = find(a);
  const rb = find(b);
  if (ra !== rb) parent[ra] = rb;
};
const nodeLength = new Float64Array(totalNodes);
const entranceNodes: number[] = [];
const entranceBuilding: number[] = [];
const wholeBuilding = new Uint8Array(buildingCount);
let dangling = 0;
let lostBuildings = 0;
const entries: RegionManifest['tiles'] = [];
for (const tile of ordered) {
  const file = `tile_${tile.tx}_${tile.ty}.nav`;
  const nav: NavTile = readTileContainer(toArrayBuffer(readFileSync(join(work, 'tiles', file))));
  const base = nodeBase.get(tile.key) ?? 0;
  const firstBuilding = buildingOffset.get(tile.key) ?? 0;
  // Buildings: region-wide ids.
  nav.nodes.buildingId.forEach((_, n) => {
    const key = tile.nodeBuilding.get(n);
    if (key === undefined) return;
    const id = globalBuilding.get(key);
    if (id === undefined) lostBuildings++;
    nav.nodes.buildingId[n] = id ?? NO_BUILDING;
  });
  // Portals: seam ones re-linked or dropped.
  const fixes = patch.get(tile.key);
  if (fixes !== undefined) {
    const keep: number[] = [];
    for (let k = 0; k < nav.portals.localNode.length; k++) {
      const other = fixes.get(k);
      if (other === undefined) keep.push(k);
      else if (other >= 0) {
        nav.portals.otherNode[k] = other;
        keep.push(k);
      }
    }
    nav.portals = {
      localNode: Uint32Array.from(keep, (k) => nav.portals.localNode[k] ?? 0),
      otherTileX: Int32Array.from(keep, (k) => nav.portals.otherTileX[k] ?? 0),
      otherTileY: Int32Array.from(keep, (k) => nav.portals.otherTileY[k] ?? 0),
      otherNode: Uint32Array.from(keep, (k) => nav.portals.otherNode[k] ?? 0),
    };
  }
  // Connectivity bookkeeping.
  const { edges, nodes } = nav;
  for (let e = 0; e < edges.from.length; e++) {
    const a = base + (edges.from[e] ?? 0);
    union(a, base + (edges.to[e] ?? 0));
    nodeLength[a] = (nodeLength[a] ?? 0) + (edges.length[e] ?? 0);
  }
  for (let k = 0; k < nav.portals.localNode.length; k++) {
    const other = nodeBase.get(
      keyOfTile(nav.portals.otherTileX[k] ?? 0, nav.portals.otherTileY[k] ?? 0),
    );
    if (other !== undefined)
      union(base + (nav.portals.localNode[k] ?? 0), other + (nav.portals.otherNode[k] ?? 0));
  }
  for (let n = 0; n < nodes.x.length; n++) {
    if (nodes.type[n] === NodeType.End) dangling++;
    if (nodes.type[n] === NodeType.Entrance) {
      entranceNodes.push(base + n);
      entranceBuilding.push(nodes.buildingId[n] ?? NO_BUILDING);
    }
  }
  const b = nav.buildings;
  for (let i = 0; i < b.ringOffset.length; i++)
    if (
      ((b.flags[i] ?? 0) & (BuildingFlag.Part | BuildingFlag.Virtual)) === 0 &&
      ringArea(nav, i) >= 25
    )
      wholeBuilding[firstBuilding + i] = 1;
  const container = writeTileContainer(writeNavTile(nav));
  writeFileSync(join(out, file), new Uint8Array(container));
  entries.push({
    x: tile.tx,
    y: tile.ty,
    file,
    counts: {
      nodes: nodes.x.length,
      edges: edges.from.length,
      buildings: b.ringOffset.length,
      portals: nav.portals.localNode.length,
    },
    buildingOffset: firstBuilding,
    bytes: container.byteLength,
  });
}

// Connectivity as qa.ts measures it, over the whole region.
const rootLength = new Map<number, number>();
let totalLength = 0;
for (let n = 0; n < totalNodes; n++) {
  const l = nodeLength[n] ?? 0;
  if (l === 0) continue;
  const r = find(n);
  rootLength.set(r, (rootLength.get(r) ?? 0) + l);
  totalLength += l;
}
const main = new Set(
  [...rootLength.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, region.landMasses)
    .map(([r]) => r),
);
const mainLength = [...main].reduce((s, r) => s + (rootLength.get(r) ?? 0), 0);
const reachable = new Set<number>();
let connectedEntrances = 0;
entranceNodes.forEach((n, i) => {
  if (!main.has(find(n))) return;
  connectedEntrances++;
  reachable.add(entranceBuilding[i] ?? NO_BUILDING);
});
let whole = 0;
let wholeReachable = 0;
wholeBuilding.forEach((w, id) => {
  if (w === 0) return;
  whole++;
  if (reachable.has(id)) wholeReachable++;
});
const qa: Record<string, number> = {
  ...qaSums,
  'graph.connectedShare': totalLength > 0 ? mainLength / totalLength : 0,
  'graph.danglingShare': totalNodes > 0 ? dangling / totalNodes : 0,
  'entrances.nodes': entranceNodes.length,
  'entrances.connectedShare':
    entranceNodes.length > 0 ? connectedEntrances / entranceNodes.length : 0,
  'entrances.buildingsReachableShare': whole > 0 ? wholeReachable / whole : 0,
  'entrances.buildingsLostAtSeams': lostBuildings,
  'tiles.seamPortals': seams.length,
  'tiles.seamPortalsMatched': matched,
};

// Traffic: the drivable roads over the whole region (highways only: light to parse).
step('roads');
const roadsFile = join(work, 'roads.osm.pbf');
osmium(['tags-filter', '-O', '-o', roadsFile, filtered, 'w/highway']);
const roadData = await parse(roadsFile);
const roadPositions = new Map<number, Point>();
for (const node of roadData.nodes.values())
  roadPositions.set(node.id, frame.toLocal(node.lon, node.lat));
const { roads, km, onGround } = extractRoadNetwork(roadData, roadPositions, bounds);
if (terrain !== undefined) applyRoadTerrain(roads, onGround, terrain.terrain, frame, terrain.zero);
writeFileSync(join(out, 'roads.bin'), new Uint8Array(writeRoadNetwork(roads)));

const graph = writeRegionGraph(entries, { x: grid.originX, y: grid.originY });

const manifest: RegionManifest = {
  format: 'city-nav',
  version: 1,
  region: regionId,
  origin: { crs: 'EPSG:27700', easting: frame.easting, northing: frame.northing },
  bboxWgs84: region.bboxWgs84,
  tileSizeM: TILE_M,
  gridOrigin: { x: grid.originX, y: grid.originY },
  ...(terrain === undefined
    ? {}
    : {
        terrain: {
          source: TERRAIN_SOURCE,
          datum: 'ODN' as const,
          zeroM: Math.round(terrain.zero * 100) / 100,
          pixelM: terrainPixelM,
        },
      }),
  roads: {
    file: 'roads.bin',
    nodes: roads.nodeX.length,
    edges: roads.edgeFrom.length,
    km: Math.round(km * 10) / 10,
  },
  graph,
  tiles: entries,
  qa,
  build: {
    source: relative(root, pbf),
    tool: `@city/osm-pipeline (chunked ${chunkTiles}×${chunkTiles} tiles, ${marginM} m margin)`,
    createdAt: new Date().toISOString(),
    attribution: '© OpenStreetMap contributors, ODbL',
  },
};
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
const bytes = entries.reduce((n, e) => n + e.bytes, 0);
step(
  `wrote ${relative(root, out)}: ${entries.length} tiles, ${(bytes / 1024 / 1024).toFixed(0)} MB, ${buildingCount} buildings, ${totalNodes} nodes`,
);
console.log(JSON.stringify(qa, null, 2));
const failures = gateFailures(qa, region.gates);
if (failures.length > 0) {
  console.error(`QA gates failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
} else console.log(`QA gates passed (${Object.keys(region.gates).length})`);

function ringArea(tile: NavTile, b: number): number {
  const { ringOffset, ringCount, ringX, ringY } = tile.buildings;
  const o = ringOffset[b] ?? 0;
  const c = ringCount[b] ?? 0;
  let area = 0;
  for (let k = 0; k < c; k++) {
    const k2 = (k + 1) % c;
    area += (ringX[o + k] ?? 0) * (ringY[o + k2] ?? 0) - (ringX[o + k2] ?? 0) * (ringY[o + k] ?? 0);
  }
  return Math.abs(area) / 2;
}

function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}
