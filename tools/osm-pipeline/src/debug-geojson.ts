import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Building } from './buildings.ts';
import { EdgeFlag } from '@city/core-types';
import type { Topology } from './topology.ts';

/** Debug dumps in WGS84 (plan §10: every stage inspectable in any GIS tool). */
export function writeDebugGeoJson(
  dir: string,
  topology: Topology,
  buildings: readonly Building[],
  toWgs84: (x: number, y: number) => [number, number],
): void {
  const round = ([lon, lat]: [number, number]): [number, number] => [
    Math.round(lon * 1e7) / 1e7,
    Math.round(lat * 1e7) / 1e7,
  ];
  const collection = (features: object[]) =>
    JSON.stringify({ type: 'FeatureCollection', features });
  writeFileSync(
    join(dir, 'edges.geojson'),
    collection(
      topology.edges.map((e, i) => ({
        type: 'Feature',
        properties: {
          edge: i,
          osmWay: e.osmWayId,
          type: e.attributes.type,
          flags: e.attributes.flags,
          source:
            (e.attributes.flags & EdgeFlag.Implicit) !== 0
              ? 'implicit'
              : (e.attributes.flags & EdgeFlag.Inferred) !== 0
                ? 'inferred'
                : 'mapped',
          level: e.attributes.level,
          widthCm: e.attributes.widthCm,
          length: Math.round(e.length * 100) / 100,
        },
        geometry: {
          type: 'LineString',
          coordinates: e.points.map(([x, y]) => round(toWgs84(x, y))),
        },
      })),
    ),
  );
  writeFileSync(
    join(dir, 'buildings.geojson'),
    collection(
      buildings.map((b) => ({
        type: 'Feature',
        properties: {
          osmId: b.osmId,
          relation: b.isRelation,
          type: b.type,
          flags: b.flags,
          height: Math.round(b.height * 10) / 10,
          baseZ: b.baseZ,
          levels: b.levels,
          capacity: b.capacity,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [[...b.ring, b.ring[0] ?? [0, 0]].map(([x, y]) => round(toWgs84(x, y)))],
        },
      })),
    ),
  );
}
