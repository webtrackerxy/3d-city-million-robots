/**
 * Building names for the city view's labels: every named OSM building in a region, matched to
 * the region's buildings by OSM id, with its centroid and roof height in the region frame. Reads
 * the built region (no tiles are rewritten) and the newest extract in data/raw/:
 *
 *   yarn workspace @city/osm-pipeline labels --region docklands
 *
 * Writes apps/city/public/regions/<region>/labels.json.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readTileContainer, type RegionManifest } from '@city/formats';
import { unescapeOpl } from './opl.ts';

const root = resolve(import.meta.dirname, '../../..');
const argument = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const region = argument('region', 'docklands') ?? 'docklands';
const regionDir = join(root, 'apps/city/public/regions', region);
const work = join(root, 'data/work', region);
mkdirSync(work, { recursive: true });

const raw = join(root, 'data/raw');
const pbf = argument(
  'pbf',
  join(
    raw,
    readdirSync(raw)
      .filter((f) => f.endsWith('.osm.pbf'))
      .sort()
      .at(-1) ?? '',
  ),
);
if (!pbf?.endsWith('.osm.pbf')) throw new Error('no .osm.pbf in data/raw/');

const manifest = JSON.parse(
  readFileSync(join(regionDir, 'manifest.json'), 'utf8'),
) as RegionManifest;
const [west, south, east, north] = manifest.bboxWgs84;

// Named ways and relations in the region's box (ids and tags only: no geometry needed).
const extract = join(work, 'labels-extract.osm.pbf');
const named = join(work, 'labels-named.opl');
const osmium = (args: string[]) => execFileSync('osmium', args, { cwd: root, stdio: 'inherit' });
osmium(['extract', '--overwrite', '-b', `${west},${south},${east},${north}`, pbf, '-o', extract]);
osmium(['tags-filter', '--overwrite', '-R', extract, 'wr/name', '-o', named, '-f', 'opl']);

/** OSM key ('w123' or 'r123') → name, for buildings and building parts. */
const names = new Map<string, string>();
for (const line of readFileSync(named, 'utf8').split('\n')) {
  const kind = line[0];
  if (kind !== 'w' && kind !== 'r') continue;
  const id = line.slice(1, line.indexOf(' '));
  const tagsField = line.split(' ').find((field) => field.startsWith('T'));
  if (tagsField === undefined) continue;
  const tags = new Map<string, string>();
  for (const pair of tagsField.slice(1).split(',')) {
    const eq = pair.indexOf('=');
    if (eq > 0) tags.set(unescapeOpl(pair.slice(0, eq)), unescapeOpl(pair.slice(eq + 1)));
  }
  const name = tags.get('name');
  if (name === undefined || (!tags.has('building') && !tags.has('building:part'))) continue;
  names.set(`${kind}${id}`, name);
}

/** One label per OSM building: the largest ring's centroid and the highest roof. */
const labels = new Map<string, { name: string; x: number; y: number; top: number; ring: number }>();
const size = manifest.tileSizeM;
for (const entry of manifest.tiles) {
  const buffer = readFileSync(join(regionDir, entry.file));
  const tile = readTileContainer(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
  );
  const b = tile.buildings;
  const ox = manifest.gridOrigin.x + entry.x * size;
  const oy = manifest.gridOrigin.y + entry.y * size;
  for (let i = 0; i < b.ringOffset.length; i++) {
    const relation = (b.osmIdHi[i] & 0x80000000) !== 0;
    const id = (b.osmIdHi[i] & 0x7fffffff) * 2 ** 32 + b.osmIdLo[i];
    const key = `${relation ? 'r' : 'w'}${id}`;
    const name = names.get(key);
    if (name === undefined) continue;
    const o = b.ringOffset[i];
    const n = b.ringCount[i];
    if (n === 0) continue;
    let x = 0;
    let y = 0;
    for (let k = 0; k < n; k++) {
      x += b.ringX[o + k];
      y += b.ringY[o + k];
    }
    const label = { name, x: ox + x / n, y: oy + y / n, top: b.height[i], ring: n };
    const previous = labels.get(key);
    if (previous === undefined) labels.set(key, label);
    else {
      previous.top = Math.max(previous.top, label.top);
      if (label.ring > previous.ring) Object.assign(previous, { x: label.x, y: label.y, ring: n });
    }
  }
}

const out = [...labels.values()]
  .sort((a, b) => b.top - a.top)
  .map(({ name, x, y, top }) => ({
    name,
    x: Math.round(x * 10) / 10,
    y: Math.round(y * 10) / 10,
    top: Math.round(top * 10) / 10,
  }));
writeFileSync(join(regionDir, 'labels.json'), JSON.stringify({ version: 1, region, labels: out }));
console.log(`labels: ${out.length} named buildings (of ${names.size} named in the extract)`);
console.log(
  `tallest: ${out
    .slice(0, 5)
    .map((l) => `${l.name} ${l.top} m`)
    .join(', ')}`,
);
