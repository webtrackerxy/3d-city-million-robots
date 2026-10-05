/**
 * Ground heights from the Environment Agency's LIDAR Composite DTM (1 m, England; Open Government
 * Licence), in metres above Ordnance Datum Newlyn, fetched from its OGC WCS in chunks and cached
 * under data/raw/dtm/. A Terrain samples it bilinearly at British National Grid coordinates.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { EdgeFlag } from '@city/core-types';
import type { NavTile, RoadNetworkData } from '@city/formats';

const WCS =
  'https://environment.data.gov.uk/spatialdata/lidar-composite-digital-terrain-model-dtm-1m/wcs';
const COVERAGE = '13787b9a-26a4-4775-8523-806d13af58fc__Lidar_Composite_Elevation_DTM_1m';
/** Pixels per side of one fetched chunk (the service scales the 1 m source to the resolution). */
const CHUNK_PX = 1000;

export const TERRAIN_SOURCE =
  'Environment Agency LIDAR Composite DTM 1 m (OGL), heights above Ordnance Datum Newlyn';

/** A float32 raster: `width` × `height` samples, row 0 at the north edge. */
export interface Raster {
  width: number;
  height: number;
  /** BNG of the top-left corner of the top-left pixel, and the pixel size in metres. */
  west: number;
  north: number;
  pixelM: number;
  data: Float32Array;
  nodata: number | null;
}

export interface Terrain {
  /** Ground height (m ODN) at BNG (e, n), or null where there is no data. */
  sample(e: number, n: number): number | null;
}

/**
 * Reads an uncompressed float32 GeoTIFF (tiled or stripped, either byte order), georeferenced by
 * ModelTransformation or ModelPixelScale + ModelTiepoint: what the EA's WCS returns.
 */
export function readGeoTiff(buffer: ArrayBuffer): Raster {
  const view = new DataView(buffer);
  const little = view.getUint16(0) === 0x4949;
  const u16 = (o: number) => view.getUint16(o, little);
  const u32 = (o: number) => view.getUint32(o, little);
  if (u16(2) !== 42) throw new Error('not a classic TIFF');
  const ifd = u32(4);
  const count = u16(ifd);
  const sizes: Partial<Record<number, number>> = { 1: 1, 2: 1, 3: 2, 4: 4, 11: 4, 12: 8 };
  const tags = new Map<number, { type: number; n: number; at: number }>();
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    const type = u16(e + 2);
    const n = u32(e + 4);
    const bytes = (sizes[type] ?? 1) * n;
    tags.set(u16(e), { type, n, at: bytes <= 4 ? e + 8 : u32(e + 8) });
  }
  const numbers = (tag: number): number[] => {
    const t = tags.get(tag);
    if (t === undefined) return [];
    const out: number[] = [];
    for (let i = 0; i < t.n; i++) {
      if (t.type === 3) out.push(u16(t.at + i * 2));
      else if (t.type === 4) out.push(u32(t.at + i * 4));
      else if (t.type === 12) out.push(view.getFloat64(t.at + i * 8, little));
    }
    return out;
  };
  const text = (tag: number): string | null => {
    const t = tags.get(tag);
    if (t === undefined) return null;
    return new TextDecoder().decode(new Uint8Array(buffer, t.at, t.n)).replace(/\0+$/, '');
  };
  const width = numbers(256)[0] ?? 0;
  const height = numbers(257)[0] ?? 0;
  if ((numbers(259)[0] ?? 1) !== 1) throw new Error('compressed TIFF');
  if ((numbers(258)[0] ?? 0) !== 32 || (numbers(339)[0] ?? 1) !== 3) throw new Error('not float32');

  const data = new Float32Array(width * height);
  const copy = (offset: number, w: number, h: number, x0: number, y0: number) => {
    for (let j = 0; j < h; j++)
      for (let i = 0; i < w; i++) {
        const x = x0 + i;
        const y = y0 + j;
        if (x < width && y < height)
          data[y * width + x] = view.getFloat32(offset + (j * w + i) * 4, little);
      }
  };
  if (tags.has(324)) {
    const tw = numbers(322)[0] ?? 0;
    const th = numbers(323)[0] ?? 0;
    const across = Math.ceil(width / tw);
    numbers(324).forEach((offset, k) => {
      copy(offset, tw, th, (k % across) * tw, Math.floor(k / across) * th);
    });
  } else {
    const rows = numbers(278)[0] ?? height;
    numbers(273).forEach((offset, k) => {
      copy(offset, width, Math.min(rows, height - k * rows), 0, k * rows);
    });
  }

  let west: number;
  let north: number;
  let pixelM: number;
  const transform = numbers(34264);
  if (transform.length === 16) {
    pixelM = transform[0] ?? 1;
    west = transform[3] ?? 0;
    north = transform[7] ?? 0;
  } else {
    const scale = numbers(33550);
    const tie = numbers(33922);
    pixelM = scale[0] ?? 1;
    west = (tie[3] ?? 0) - (tie[0] ?? 0) * pixelM;
    north = (tie[4] ?? 0) + (tie[1] ?? 0) * pixelM;
  }
  const nodataText = text(42113);
  const nodata = nodataText === null ? null : Number(nodataText);
  return { width, height, west, north, pixelM, data, nodata };
}

/** Bilinear height in a raster at BNG (e, n), ignoring no-data samples; null outside or no data. */
export function sampleRaster(r: Raster, e: number, n: number): number | null {
  const fx = (e - r.west) / r.pixelM - 0.5;
  const fy = (r.north - n) / r.pixelM - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  if (x0 < -1 || y0 < -1 || x0 >= r.width || y0 >= r.height) return null;
  let sum = 0;
  let weight = 0;
  for (const [dx, dy] of [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ] as const) {
    const x = Math.min(r.width - 1, Math.max(0, x0 + dx));
    const y = Math.min(r.height - 1, Math.max(0, y0 + dy));
    const v = r.data[y * r.width + x] ?? Number.NaN;
    if (!Number.isFinite(v) || v < -1000 || (r.nodata !== null && v === r.nodata)) continue;
    const w = (dx === 0 ? 1 - (fx - x0) : fx - x0) * (dy === 0 ? 1 - (fy - y0) : fy - y0);
    sum += v * w;
    weight += w;
  }
  return weight > 1e-6 ? sum / weight : null;
}

/**
 * The terrain over a BNG box at `pixelM` metres (1 m source, scaled by the service), fetched in
 * CHUNK_PX-pixel chunks on a fixed grid and cached as GeoTIFFs in `cacheDir`.
 */
export async function loadTerrain(
  box: { minE: number; minN: number; maxE: number; maxN: number },
  pixelM: number,
  cacheDir: string,
  log: (message: string) => void = () => undefined,
): Promise<Terrain> {
  mkdirSync(cacheDir, { recursive: true });
  const span = CHUNK_PX * pixelM;
  const chunks = new Map<string, Raster>();
  const e0 = Math.floor(box.minE / span) * span;
  const n0 = Math.floor(box.minN / span) * span;
  const total = Math.ceil((box.maxE - e0) / span) * Math.ceil((box.maxN - n0) / span);
  let done = 0;
  for (let e = e0; e < box.maxE; e += span)
    for (let n = n0; n < box.maxN; n += span) {
      const file = join(cacheDir, `dtm_${pixelM}m_${e}_${n}.tif`);
      if (!existsSync(file)) {
        const url =
          `${WCS}?service=WCS&version=2.0.1&request=GetCoverage&CoverageId=${COVERAGE}` +
          `&format=image/tiff&subset=E(${e},${e + span})&subset=N(${n},${n + span})` +
          `&SCALEFACTOR=${1 / pixelM}`;
        const response = await fetch(url);
        const type = response.headers.get('content-type') ?? '';
        if (!response.ok || !type.includes('tiff'))
          throw new Error(`terrain ${e},${n}: HTTP ${response.status} ${type}`);
        writeFileSync(file, Buffer.from(await response.arrayBuffer()));
      }
      const bytes = readFileSync(file);
      chunks.set(
        `${e},${n}`,
        readGeoTiff(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
      );
      done++;
      log(`terrain ${done}/${total} (${pixelM} m)`);
    }
  return {
    sample(e, n) {
      const key = `${Math.floor(e / span) * span},${Math.floor(n / span) * span}`;
      const raster = chunks.get(key);
      return raster === undefined ? null : sampleRaster(raster, e, n);
    },
  };
}

/**
 * Puts a region (before tiling, region frame) on the terrain: heights become metres above
 * `zeroM` (m ODN), by default the median ground under the walking graph's nodes, so most
 * streets sit near y = 0, where the flat base map is drawn. Returns the zero it used.
 *
 * - Ground nodes take the terrain under them. Nodes with no data, or only on bridges or tunnels,
 *   take their neighbours' mean (relaxed a few times), so bridges do not dip to the river.
 * - Polyline points follow the terrain, except on bridges and tunnels, where they run straight
 *   between the edge's ends.
 * - Buildings stand on the lowest ground under their outline (base and roof both move).
 */
export function applyTerrain(
  tile: NavTile,
  terrain: Terrain,
  origin: { easting: number; northing: number },
  zero: number | 'median' = 'median',
): Record<string, number> {
  const { nodes, edges, polylines, buildings } = tile;
  const odn = (x: number, y: number) => terrain.sample(origin.easting + x, origin.northing + y);
  let zeroM = 0;
  if (zero === 'median') {
    const heights: number[] = [];
    for (let n = 0; n < nodes.x.length; n++) {
      const h = odn(nodes.x[n], nodes.y[n]);
      if (h !== null) heights.push(h);
    }
    heights.sort((a, b) => a - b);
    zeroM = heights[Math.floor(heights.length / 2)] ?? 0;
  } else zeroM = zero;
  const ground = (x: number, y: number): number | null => {
    const h = odn(x, y);
    return h === null ? null : h - zeroM;
  };
  const elevated = (e: number) => (edges.flags[e] & (EdgeFlag.Bridge | EdgeFlag.Tunnel)) !== 0;

  const count = nodes.x.length;
  const onGround = new Uint8Array(count);
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let e = 0; e < edges.from.length; e++) {
    const a = edges.from[e];
    const b = edges.to[e];
    neighbours[a].push(b);
    neighbours[b].push(a);
    if (!elevated(e)) {
      onGround[a] = 1;
      onGround[b] = 1;
    }
  }
  // Isolated nodes (no edges) count as on the ground.
  for (let n = 0; n < count; n++) if (neighbours[n].length === 0) onGround[n] = 1;

  const known = new Uint8Array(count);
  const base = new Float32Array(count);
  let missing = 0;
  for (let n = 0; n < count; n++) {
    if (onGround[n] === 0) continue;
    const g = ground(nodes.x[n], nodes.y[n]);
    if (g === null) missing++;
    else {
      base[n] = g;
      known[n] = 1;
    }
  }
  let filled = 0;
  for (let pass = 0; pass < 50; pass++) {
    let changed = false;
    for (let n = 0; n < count; n++) {
      if (known[n] === 1) continue;
      let sum = 0;
      let k = 0;
      for (const m of neighbours[n])
        if (known[m] === 1) {
          sum += base[m];
          k++;
        }
      if (k > 0) {
        base[n] = sum / k;
        known[n] = 2;
        changed = true;
        filled++;
      }
    }
    for (let n = 0; n < count; n++) if (known[n] === 2) known[n] = 1;
    if (!changed) break;
  }
  let min = Infinity;
  let max = -Infinity;
  for (let n = 0; n < count; n++) {
    nodes.z[n] += base[n];
    min = Math.min(min, base[n]);
    max = Math.max(max, base[n]);
  }

  for (let e = 0; e < edges.from.length; e++) {
    const za = nodes.z[edges.from[e]];
    const zb = nodes.z[edges.to[e]];
    const length = edges.length[e] || 1;
    for (let k = 0; k < edges.polyCount[e]; k++) {
      const p = edges.polyOffset[e] + k;
      const straight = za + (zb - za) * Math.min(1, polylines.cumLength[p] / length);
      const g = elevated(e) ? null : ground(polylines.x[p], polylines.y[p]);
      polylines.z[p] += g ?? straight;
    }
  }

  let buildingsMoved = 0;
  for (let b = 0; b < buildings.ringOffset.length; b++) {
    let lowest = Infinity;
    const o = buildings.ringOffset[b];
    for (let k = 0; k < buildings.ringCount[b]; k++) {
      const g = ground(buildings.ringX[o + k], buildings.ringY[o + k]);
      if (g !== null) lowest = Math.min(lowest, g);
    }
    if (!Number.isFinite(lowest)) continue;
    buildings.baseZ[b] += lowest;
    buildings.height[b] += lowest;
    buildingsMoved++;
  }

  return {
    zeroM,
    nodes: count,
    nodesWithoutData: missing,
    nodesFilledFromNeighbours: filled,
    minHeightM: Number.isFinite(min) ? min : 0,
    maxHeightM: Number.isFinite(max) ? max : 0,
    buildingsOnTerrain: buildingsMoved,
  };
}

/**
 * Heights for a road network (roads.bin), as applyTerrain does for the walking graph: road nodes
 * on the ground take the terrain (minus `zeroM`); nodes only on bridges or tunnels, or without
 * data, take their neighbours' mean, so cars cross the Thames at deck level. Sets
 * `roads.nodeHeight`.
 */
export function applyRoadTerrain(
  roads: RoadNetworkData,
  onGround: Uint8Array,
  terrain: Terrain,
  origin: { easting: number; northing: number },
  zeroM: number,
): { nodes: number; filledFromNeighbours: number } {
  const count = roads.nodeX.length;
  const heights = new Float32Array(count);
  const known = new Uint8Array(count);
  const neighbours: number[][] = Array.from({ length: count }, () => []);
  for (let e = 0; e < roads.edgeFrom.length; e++) {
    const a = roads.edgeFrom[e];
    const b = roads.edgeTo[e];
    neighbours[a].push(b);
    neighbours[b].push(a);
  }
  for (let n = 0; n < count; n++) {
    if (onGround[n] !== 1) continue;
    const h = terrain.sample(origin.easting + roads.nodeX[n], origin.northing + roads.nodeY[n]);
    if (h === null) continue;
    heights[n] = h - zeroM;
    known[n] = 1;
  }
  let filled = 0;
  for (let pass = 0; pass < 100; pass++) {
    let changed = false;
    for (let n = 0; n < count; n++) {
      if (known[n] === 1) continue;
      let sum = 0;
      let k = 0;
      for (const m of neighbours[n])
        if (known[m] === 1) {
          sum += heights[m];
          k++;
        }
      if (k > 0) {
        heights[n] = sum / k;
        known[n] = 2;
        changed = true;
        filled++;
      }
    }
    for (let n = 0; n < count; n++) if (known[n] === 2) known[n] = 1;
    if (!changed) break;
  }
  roads.nodeHeight = heights;
  return { nodes: count, filledFromNeighbours: filled };
}
