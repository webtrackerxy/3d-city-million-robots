import { BuildingFlag, EdgeType } from '@city/core-types';
import { type Building, pointInPolygon } from './buildings.ts';
import { distance, GridIndex, type Point, projectOnSegment } from './geometry.ts';
import type { OsmData } from './opl.ts';
import { type Barriers, inferredAttributes, type SegmentIndex, type WaySet } from './way-set.ts';

/**
 * Stage 9 (implementation plan §10): every building gets at least one entrance node joined to
 * the pedestrian network.
 *
 * Mapped `entrance=*` nodes are assigned to the building whose wall they sit on. Those already on
 * a walkway are connected as they are; the rest get a connector to the nearest walkway within
 * `maxM` that crosses no road and no other building. Buildings with no mapped entrance get a
 * synthetic one on the wall closest to the network.
 */
export interface EntranceNode {
  building: number;
  synthetic: boolean;
}

export interface EntranceQa {
  mapped: number;
  mappedOnNetwork: number;
  mappedConnected: number;
  mappedUnassigned: number;
  mappedUnreachable: number;
  synthetic: number;
  buildingsWithoutEntrance: number;
}

const SKIPPED_ENTRANCES = new Set(['no', 'emergency', 'exit', 'garage']);
/** A mapped entrance belongs to a building if it lies within this distance of its wall. */
const ON_WALL_M = 1.5;
/** Buildings smaller than this (sheds, kiosks, substations) get no synthetic entrance. */
const MIN_SYNTHETIC_AREA_M2 = 25;

export function connectEntrances(
  set: WaySet,
  index: SegmentIndex,
  roads: Barriers,
  data: OsmData,
  buildings: readonly Building[],
  toLocal: (lon: number, lat: number) => Point,
  maxM = 30,
): { entrances: Map<number, EntranceNode>; qa: EntranceQa } {
  const qa: EntranceQa = {
    mapped: 0,
    mappedOnNetwork: 0,
    mappedConnected: 0,
    mappedUnassigned: 0,
    mappedUnreachable: 0,
    synthetic: 0,
    buildingsWithoutEntrance: 0,
  };
  const entrances = new Map<number, EntranceNode>();
  // Whole buildings only: parts share their outline's entrances.
  const walls = new GridIndex<{ building: number; a: Point; b: Point }>(16);
  const wallBarriers = new GridIndex<{ building: number; a: Point; b: Point }>(16);
  buildings.forEach((building, i) => {
    const ring = building.ring;
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      const box = [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[0], b[0]),
        Math.max(a[1], b[1]),
      ] as const;
      wallBarriers.insert({ building: i, a, b }, ...box);
      if ((building.flags & BuildingFlag.Part) === 0) walls.insert({ building: i, a, b }, ...box);
    }
  });
  // Includes the entrance's own building, so a connector cannot cut back through it; walls the
  // entrance sits on touch the connector at its start and do not count. A connector running
  // corner to corner through the inside touches walls only at its ends: the midpoint test.
  const crossesBuilding = (p: Point, q: Point): boolean => {
    const mid: Point = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    const near = new Set<number>();
    for (const wall of wallBarriers.query(mid, distance(p, q) / 2 + 1)) {
      if (segmentsCrossLoose(p, q, wall.a, wall.b)) return true;
      near.add(wall.building);
    }
    for (const b of near) if (pointInPolygon(mid, buildings[b].ring)) return true;
    return false;
  };
  const onNetwork = new Set(set.ways.flatMap((way) => way.refs));

  const connect = (node: number, p: Point): boolean => {
    const hit = index
      .nearest(p, maxM, (way) => way.attributes.level === 0)
      .slice(0, 8)
      .find((c) => !roads.crosses(p, c.point) && !crossesBuilding(p, c.point));
    if (hit === undefined) return false;
    const target = index.attach(hit);
    const way = {
      id: 0,
      refs: [node, target],
      attributes: inferredAttributes(EdgeType.Entrance, 150),
    };
    set.add(way);
    index.addWay(way);
    return true;
  };

  // Mapped entrances.
  const hasEntrance = new Set<number>();
  for (const node of data.nodes.values()) {
    const value = node.tags.entrance;
    if (value === undefined || SKIPPED_ENTRANCES.has(value)) continue;
    const p = toLocal(node.lon, node.lat);
    let best: { building: number; distance: number } | undefined;
    for (const wall of walls.query(p, ON_WALL_M)) {
      const d = projectOnSegment(p, wall.a, wall.b).distance;
      if (d <= ON_WALL_M && (best === undefined || d < best.distance))
        best = { building: wall.building, distance: d };
    }
    if (best === undefined) continue; // e.g. a station entrance in open ground, or outside the area
    qa.mapped++;
    set.positions.set(node.id, p);
    if (onNetwork.has(node.id)) qa.mappedOnNetwork++;
    else if (connect(node.id, p)) qa.mappedConnected++;
    else {
      qa.mappedUnreachable++;
      continue;
    }
    entrances.set(node.id, { building: best.building, synthetic: false });
    hasEntrance.add(best.building);
  }

  // Synthetic entrances: the wall midpoint nearest the network.
  buildings.forEach((building, i) => {
    if ((building.flags & BuildingFlag.Part) !== 0 || hasEntrance.has(i)) return;
    if (building.areaM2 < MIN_SYNTHETIC_AREA_M2) return;
    const ring = building.ring;
    const candidates: { p: Point; distance: number }[] = [];
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % ring.length];
      if (distance(a, b) < 1.5) continue;
      const p: Point = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const nearest = index.nearest(p, maxM, (way) => way.attributes.level === 0).at(0);
      if (nearest !== undefined) candidates.push({ p, distance: nearest.distance });
    }
    candidates.sort((x, y) => x.distance - y.distance);
    for (const candidate of candidates.slice(0, 4)) {
      const node = set.addNode(candidate.p);
      if (connect(node, candidate.p)) {
        entrances.set(node, { building: i, synthetic: true });
        qa.synthetic++;
        return;
      }
      set.positions.delete(node);
    }
    qa.buildingsWithoutEntrance++;
  });
  qa.mappedUnassigned =
    [...data.nodes.values()].filter(
      (n) => n.tags.entrance !== undefined && !SKIPPED_ENTRANCES.has(n.tags.entrance),
    ).length - qa.mapped;
  return { entrances, qa };
}

/**
 * Crossing test that also counts passing through a wall's end point; orientations within 1 mm²
 * count as touching, so a connector starting on a wall does not cross it.
 */
function segmentsCrossLoose(p1: Point, p2: Point, q1: Point, q2: Point): boolean {
  const o = (a: Point, b: Point, c: Point) => {
    const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    return Math.abs(v) < 1e-3 ? 0 : v;
  };
  const d1 = o(q1, q2, p1);
  const d2 = o(q1, q2, p2);
  const d3 = o(p1, p2, q1);
  const d4 = o(p1, p2, q2);
  return d1 * d2 < 0 && d3 * d4 <= 0;
}
