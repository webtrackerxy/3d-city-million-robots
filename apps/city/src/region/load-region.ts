import {
  type NavTile,
  type NavTileFiles,
  readTileContainer,
  type RegionManifest,
  writeNavTile,
} from '@city/formats';
import { stitchTiles } from '@city/nav';

type TileEntry = RegionManifest['tiles'][number];

export interface StreamedTile {
  entry: TileEntry;
  tile: NavTile;
  /** South-west corner of the tile in the region frame. */
  originX: number;
  originY: number;
}

export interface LoadStats {
  tiles: number;
  /** Manifest to stitched graph. */
  totalMs: number;
  /** Main-thread work per tile (wrap the buffers + the consumer's work, e.g. building meshes). */
  meanTileMs: number;
  maxTileMs: number;
  stitchMs: number;
  meanTileBytes: number;
  maxTileBytes: number;
}

export interface LoadedRegion {
  manifest: RegionManifest;
  /** All tiles stitched into one region graph (region frame). */
  tile: NavTile;
  /** The stitched graph as binary files, for the workers. */
  files: NavTileFiles;
  bytes: number;
  load: LoadStats;
}

const CONCURRENCY = 6;

function base(regionId: string): string {
  return `${import.meta.env.BASE_URL}regions/${encodeURIComponent(regionId)}/`;
}

export async function fetchManifest(regionId: string): Promise<RegionManifest> {
  const response = await fetch(`${base(regionId)}manifest.json`);
  if (!response.ok) {
    throw new Error(
      `Region "${regionId}" has not been built (${response.status}). Run: yarn region --region ${regionId}`,
    );
  }
  return (await response.json()) as RegionManifest;
}

/** Region size in metres covered by the manifest's tiles (for the ground and camera). */
export function regionExtent(manifest: RegionManifest): number {
  const xs = manifest.tiles.map((t) => t.x);
  const ys = manifest.tiles.map((t) => t.y);
  const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) + 1;
  return span * manifest.tileSizeM;
}

/**
 * Streams a region's tiles nearest `focus` first (region frame), handing each to `onTile` as it
 * arrives (`onTile` returns the main-thread ms it spent), then stitches all of them in manifest
 * order — so the graph is identical however the tiles arrived.
 */
export async function streamRegion(
  regionId: string,
  manifest: RegionManifest,
  focus: { x: number; y: number },
  onTile: (tile: StreamedTile) => number,
): Promise<LoadedRegion> {
  const t0 = performance.now();
  const size = manifest.tileSizeM;
  const corner = (entry: TileEntry) => ({
    x: manifest.gridOrigin.x + entry.x * size,
    y: manifest.gridOrigin.y + entry.y * size,
  });
  const order = [...manifest.tiles].sort((a, b) => {
    const da = Math.hypot(corner(a).x + size / 2 - focus.x, corner(a).y + size / 2 - focus.y);
    const db = Math.hypot(corner(b).x + size / 2 - focus.x, corner(b).y + size / 2 - focus.y);
    return da - db;
  });
  const loaded = new Map<TileEntry, NavTile>();
  const tileMs: number[] = [];
  let bytes = 0;
  let next = 0;
  const fetchTile = async (entry: TileEntry) => {
    const response = await fetch(`${base(regionId)}${entry.file}`);
    if (!response.ok) throw new Error(`Missing ${entry.file} (${response.status})`);
    const buffer = await response.arrayBuffer();
    const begin = performance.now();
    const tile = readTileContainer(buffer);
    const readMs = performance.now() - begin;
    loaded.set(entry, tile);
    bytes += buffer.byteLength;
    const { x, y } = corner(entry);
    tileMs.push(readMs + onTile({ entry, tile, originX: x, originY: y }));
  };
  const worker = async () => {
    while (next < order.length) {
      await fetchTile(order[next++]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, order.length) }, worker));

  const stitchStart = performance.now();
  const tile = stitchTiles({
    tiles: manifest.tiles.map((entry) => {
      const t = loaded.get(entry);
      if (t === undefined) throw new Error(`Tile ${entry.x},${entry.y} did not load`);
      return t;
    }),
    buildingOffset: manifest.tiles.map((entry) => entry.buildingOffset),
    gridOrigin: manifest.gridOrigin,
    tileSizeM: size,
  });
  const stitchMs = performance.now() - stitchStart;
  const sizes = manifest.tiles.map((entry) => entry.bytes);
  return {
    manifest,
    tile,
    files: writeNavTile(tile),
    bytes,
    load: {
      tiles: manifest.tiles.length,
      totalMs: performance.now() - t0,
      meanTileMs: tileMs.reduce((a, b) => a + b, 0) / Math.max(1, tileMs.length),
      maxTileMs: Math.max(0, ...tileMs),
      stitchMs,
      meanTileBytes: sizes.reduce((a, b) => a + b, 0) / Math.max(1, sizes.length),
      maxTileBytes: Math.max(0, ...sizes),
    },
  };
}
