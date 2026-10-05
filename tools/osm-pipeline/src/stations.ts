import { BuildingFlag, BuildingType, EdgeType } from '@city/core-types';
import type { Building } from './buildings.ts';
import type { EntranceNode } from './entrances.ts';
import type { Point } from './geometry.ts';
import type { OsmData, Tags } from './opl.ts';
import { type Barriers, inferredAttributes, type SegmentIndex, type WaySet } from './way-set.ts';

/**
 * Stations as demand nodes (implementation plan §15: stations are sources and sinks with a
 * time-of-day profile). Each `railway=station` becomes a virtual building — not drawn, type
 * Transport — whose entrances are its mapped subway/station entrances within 400 m, or the
 * station point itself when none are mapped (most DLR stops). Entrances are linked to the
 * pedestrian network like building doors; the simulation treats a station's aggregate as the
 * people beyond the region.
 */
export interface StationQa {
  stations: number;
  entrances: number;
  connected: number;
  unreachable: number;
}

/** Relative size of a station's passenger flow, as a capacity for destination weighting. */
export function stationCapacity(tags: Tags): number {
  const network = tags.network ?? '';
  if (/Elizabeth|Underground/i.test(network) || tags.station === 'subway') return 40_000;
  if (/National Rail|Overground/i.test(network)) return 15_000;
  return 8_000; // DLR and others
}

export function connectStations(
  set: WaySet,
  index: SegmentIndex,
  roads: Barriers,
  data: OsmData,
  buildings: Building[],
  entrances: Map<number, EntranceNode>,
  toLocal: (lon: number, lat: number) => Point,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  maxM = 60,
): StationQa {
  const qa: StationQa = { stations: 0, entrances: 0, connected: 0, unreachable: 0 };
  const inside = (p: Point) =>
    p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY;
  const stations: { id: number; p: Point; tags: Tags }[] = [];
  const gates: { id: number; p: Point }[] = [];
  for (const node of data.nodes.values()) {
    const railway = node.tags.railway;
    if (railway === 'station') {
      const p = toLocal(node.lon, node.lat);
      if (inside(p)) stations.push({ id: node.id, p, tags: node.tags });
    } else if (railway === 'subway_entrance' || railway === 'train_station_entrance') {
      gates.push({ id: node.id, p: toLocal(node.lon, node.lat) });
    }
  }
  // Each entrance belongs to the nearest station within 400 m; interchange stations (Jubilee +
  // DLR at Canary Wharf) stay separate stations.
  const gatesOf = new Map<number, { id: number; p: Point }[]>();
  for (const gate of gates) {
    let best = -1;
    let bestDistance = 400;
    stations.forEach((station, i) => {
      const d = Math.hypot(station.p[0] - gate.p[0], station.p[1] - gate.p[1]);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    if (best >= 0) gatesOf.set(best, [...(gatesOf.get(best) ?? []), gate]);
  }

  const onNetwork = new Set(set.ways.flatMap((w) => w.refs));
  stations.forEach((station, i) => {
    const building = buildings.length;
    const [x, y] = station.p;
    // A 6 m square marker: gives the virtual building a ring for tiling and bookkeeping.
    buildings.push({
      osmId: station.id,
      isRelation: false,
      ring: [
        [x - 3, y - 3],
        [x + 3, y - 3],
        [x + 3, y + 3],
        [x - 3, y + 3],
      ],
      areaM2: 36,
      levels: 1,
      baseZ: 0,
      height: 0,
      type: BuildingType.Transport,
      flags: BuildingFlag.Virtual,
      capacity: stationCapacity(station.tags),
      seed: Math.imul(station.id, 2654435761) >>> 0,
    });
    qa.stations++;
    const points = gatesOf.get(i) ?? [{ id: station.id, p: station.p }];
    for (const gate of points) {
      qa.entrances++;
      set.positions.set(gate.id, gate.p);
      if (!onNetwork.has(gate.id)) {
        const hit = index
          .nearest(gate.p, maxM, (way) => way.attributes.level === 0)
          .slice(0, 8)
          .find((c) => !roads.crosses(gate.p, c.point));
        if (hit === undefined) {
          qa.unreachable++;
          continue;
        }
        const target = index.attach(hit);
        const way = {
          id: 0,
          refs: [gate.id, target],
          attributes: inferredAttributes(EdgeType.Entrance, 300),
        };
        set.add(way);
        index.addWay(way);
      }
      qa.connected++;
      entrances.set(gate.id, { building, synthetic: false });
    }
  });
  return qa;
}
