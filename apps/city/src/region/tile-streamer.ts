import { type NavTile, readTileContainer, type RegionManifest } from '@city/formats';

type TileEntry = RegionManifest['tiles'][number];

export interface StreamedArea {
  /** Region-frame square the streamed tiles cover. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface TileSink {
  add(tile: NavTile, originX: number, originY: number, firstBuilding: number): void;
  /** Tiles wanted around the focus and how many of them are loaded (the loading bar). */
  progress?(loaded: number, wanted: number): void;
  remove(originX: number, originY: number): void;
  /** The area now covered by streamed tiles (the base map fills in the rest). */
  area(area: StreamedArea): void;
}

const CONCURRENCY = 6;

/**
 * Keeps the tiles within `radiusM` (a square) of the focus loaded, for a region too large to load
 * whole (London: ~6,000 tiles, 470k buildings): nearest first, and drops tiles once the focus has
 * moved `radiusM × 1.5` away. The graph itself comes whole from region.nav; tiles are only for
 * drawing buildings.
 */
export class TileStreamer {
  private readonly manifest: RegionManifest;
  private readonly base: string;
  private readonly radiusM: number;
  private readonly sink: TileSink;
  private readonly byKey = new Map<string, TileEntry>();
  private readonly loaded = new Set<string>();
  private readonly pending = new Set<string>();
  private queue: TileEntry[] = [];
  private wanted: string[] = [];
  private active = 0;
  private focus = { x: Number.NaN, y: Number.NaN };
  private disposed = false;

  constructor(regionId: string, manifest: RegionManifest, radiusM: number, sink: TileSink) {
    this.manifest = manifest;
    this.base = `${import.meta.env.BASE_URL}regions/${encodeURIComponent(regionId)}/`;
    this.radiusM = radiusM;
    this.sink = sink;
    for (const entry of manifest.tiles) this.byKey.set(`${entry.x},${entry.y}`, entry);
  }

  /** Call as the camera moves; cheap when the focus has moved less than a tile. */
  update(x: number, y: number): void {
    const size = this.manifest.tileSizeM;
    if (Math.hypot(x - this.focus.x, y - this.focus.y) < size / 2) return;
    this.focus = { x, y };
    const { x: gx, y: gy } = this.manifest.gridOrigin;
    const cx = Math.floor((x - gx) / size);
    const cy = Math.floor((y - gy) / size);
    const reach = Math.ceil(this.radiusM / size);
    const wanted: TileEntry[] = [];
    for (let dy = -reach; dy <= reach; dy++)
      for (let dx = -reach; dx <= reach; dx++) {
        const entry = this.byKey.get(`${cx + dx},${cy + dy}`);
        if (entry !== undefined) wanted.push(entry);
      }
    const centre = (e: TileEntry) => [gx + (e.x + 0.5) * size, gy + (e.y + 0.5) * size] as const;
    wanted.sort((a, b) => {
      const [ax, ay] = centre(a);
      const [bx, by] = centre(b);
      return Math.hypot(ax - x, ay - y) - Math.hypot(bx - x, by - y);
    });
    this.wanted = wanted.map((e) => `${e.x},${e.y}`);
    this.queue = wanted.filter((e) => {
      const key = `${e.x},${e.y}`;
      return !this.loaded.has(key) && !this.pending.has(key);
    });
    // Drop tiles well outside the square (hysteresis: a camera wobbling at the edge keeps them).
    const keep = this.radiusM * 1.5 + size;
    for (const key of [...this.loaded]) {
      const entry = this.byKey.get(key);
      if (entry === undefined) continue;
      const [ex, ey] = centre(entry);
      if (Math.max(Math.abs(ex - x), Math.abs(ey - y)) <= keep) continue;
      this.loaded.delete(key);
      this.sink.remove(gx + entry.x * size, gy + entry.y * size);
    }
    this.sink.area({
      minX: gx + (cx - reach) * size,
      minY: gy + (cy - reach) * size,
      maxX: gx + (cx + reach + 1) * size,
      maxY: gy + (cy + reach + 1) * size,
    });
    this.pump();
  }

  get tiles(): number {
    return this.loaded.size;
  }

  private isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
  }

  private pump(): void {
    while (this.active < CONCURRENCY && this.queue.length > 0) {
      const entry = this.queue.shift();
      if (entry === undefined) break;
      const key = `${entry.x},${entry.y}`;
      this.pending.add(key);
      this.active++;
      void this.fetchTile(entry, key).finally(() => {
        this.pending.delete(key);
        this.active--;
        this.pump();
      });
    }
  }

  private async fetchTile(entry: TileEntry, key: string): Promise<void> {
    const response = await fetch(`${this.base}${entry.file}`);
    if (!response.ok || this.disposed) return;
    const tile = readTileContainer(await response.arrayBuffer());
    // The streamer may have been disposed while the body downloaded.
    if (this.isDisposed()) return;
    const size = this.manifest.tileSizeM;
    this.loaded.add(key);
    this.sink.progress?.(this.wanted.filter((k) => this.loaded.has(k)).length, this.wanted.length);
    this.sink.add(
      tile,
      this.manifest.gridOrigin.x + entry.x * size,
      this.manifest.gridOrigin.y + entry.y * size,
      entry.buildingOffset,
    );
  }
}

/** A large region's whole graph, from its stitched `region.nav`. */
export async function loadRegionGraph(
  regionId: string,
  file: string,
  onProgress: (received: number, total: number) => void = () => undefined,
): Promise<{ tile: NavTile; bytes: number; ms: number }> {
  const begin = performance.now();
  const response = await fetch(
    `${import.meta.env.BASE_URL}regions/${encodeURIComponent(regionId)}/${file}`,
  );
  if (!response.ok) throw new Error(`${file}: HTTP ${response.status}`);
  // Read in chunks to report progress (the file is ~125 MB for London).
  const total = Number(response.headers.get('content-length') ?? 0);
  const reader = response.body?.getReader();
  let buffer: ArrayBuffer;
  if (reader === undefined || total === 0) buffer = await response.arrayBuffer();
  else {
    const bytes = new Uint8Array(total);
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes.set(value, received);
      received += value.byteLength;
      onProgress(received, total);
    }
    buffer = bytes.buffer;
  }
  return {
    tile: readTileContainer(buffer),
    bytes: buffer.byteLength,
    ms: performance.now() - begin,
  };
}

/**
 * A large region's graph keeps its buildings without outlines when the manifest says
 * `buildingOutlines: 'tiles'`. Fills in the outlines of the buildings in the tiles overlapping
 * `zone` (the roof walks there need them), in the region frame; others stay without one.
 */
export async function withOutlines(
  regionId: string,
  manifest: RegionManifest,
  graph: NavTile,
  zone: StreamedArea,
): Promise<NavTile> {
  const size = manifest.tileSizeM;
  const { x: gx, y: gy } = manifest.gridOrigin;
  const entries = manifest.tiles.filter(
    (t) =>
      gx + (t.x + 1) * size > zone.minX &&
      gx + t.x * size < zone.maxX &&
      gy + (t.y + 1) * size > zone.minY &&
      gy + t.y * size < zone.maxY,
  );
  const base = `${import.meta.env.BASE_URL}regions/${encodeURIComponent(regionId)}/`;
  const tiles: { entry: TileEntry; tile: NavTile }[] = [];
  for (let i = 0; i < entries.length; i += CONCURRENCY * 2)
    tiles.push(
      ...(await Promise.all(
        entries.slice(i, i + CONCURRENCY * 2).map(async (entry) => {
          const response = await fetch(`${base}${entry.file}`);
          if (!response.ok) throw new Error(`${entry.file}: HTTP ${response.status}`);
          return { entry, tile: readTileContainer(await response.arrayBuffer()) };
        }),
      )),
    );
  const count = graph.buildings.ringOffset.length;
  const ringOffset = new Uint32Array(count);
  const ringCount = new Uint16Array(count);
  const points = tiles.reduce((s, t) => s + t.tile.buildings.ringX.length, 0);
  const ringX = new Float32Array(points);
  const ringY = new Float32Array(points);
  let r0 = 0;
  for (const { entry, tile } of tiles) {
    const b = tile.buildings;
    const ox = gx + entry.x * size;
    const oy = gy + entry.y * size;
    for (let i = 0; i < b.ringOffset.length; i++) {
      const id = entry.buildingOffset + i;
      if (id >= count) continue;
      ringOffset[id] = r0 + (b.ringOffset[i] ?? 0);
      ringCount[id] = b.ringCount[i] ?? 0;
    }
    for (let k = 0; k < b.ringX.length; k++) {
      ringX[r0 + k] = (b.ringX[k] ?? 0) + ox;
      ringY[r0 + k] = (b.ringY[k] ?? 0) + oy;
    }
    r0 += b.ringX.length;
  }
  return { ...graph, buildings: { ...graph.buildings, ringOffset, ringCount, ringX, ringY } };
}
