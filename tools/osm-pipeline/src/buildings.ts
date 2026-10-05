import { BuildingFlag, BuildingType } from '@city/core-types';
import type { OsmData, Tags } from './opl.ts';

/**
 * Stage 8 (implementation plan §10): building footprints, parts, heights, types and capacity.
 * v1 keeps the outer ring only (courtyards and other inner rings are M3+).
 */
export interface Building {
  osmId: number;
  /** Relations carry bit 31 in osmIdHi so way and relation ids cannot collide. */
  isRelation: boolean;
  /** Outer ring, local metres, counter-clockwise, not closed. */
  ring: [number, number][];
  areaM2: number;
  levels: number;
  baseZ: number;
  height: number;
  type: BuildingType;
  flags: number;
  capacity: number;
  seed: number;
}

export interface BuildingsQa {
  buildings: number;
  parts: number;
  outlinesWithParts: number;
  heightFromTag: number;
  heightFromLevels: number;
  heightDefault: number;
  skippedTiny: number;
  skippedOpenRings: number;
  multipolygons: number;
}

const STOREY_M: Partial<Record<BuildingType, number>> = {
  [BuildingType.Office]: 3.9,
  [BuildingType.Commercial]: 3.9,
  [BuildingType.Residential]: 3.0,
  [BuildingType.Retail]: 4.5,
  [BuildingType.Industrial]: 6.0,
};
const DEFAULT_STOREY_M = 3.5;
const DEFAULT_LEVELS: Partial<Record<BuildingType, number>> = {
  [BuildingType.Residential]: 4,
  [BuildingType.Office]: 6,
  [BuildingType.Commercial]: 4,
  [BuildingType.Retail]: 1,
  [BuildingType.Industrial]: 1,
};
const M2_PER_PERSON: Partial<Record<BuildingType, number>> = {
  [BuildingType.Office]: 10,
  [BuildingType.Commercial]: 10,
  [BuildingType.Retail]: 5,
  [BuildingType.Residential]: 30,
  [BuildingType.Public]: 10,
  [BuildingType.Transport]: 5,
};

export function buildingType(tags: Tags): BuildingType {
  const value = tags.building ?? tags['building:part'] ?? 'yes';
  if (
    [
      'house',
      'residential',
      'apartments',
      'terrace',
      'detached',
      'semidetached_house',
      'houseboat',
      'dormitory',
    ].includes(value)
  )
    return BuildingType.Residential;
  if (value === 'office') return BuildingType.Office;
  if (value === 'commercial') return BuildingType.Commercial;
  if (['retail', 'supermarket', 'kiosk'].includes(value)) return BuildingType.Retail;
  if (['industrial', 'warehouse'].includes(value)) return BuildingType.Industrial;
  if (
    [
      'school',
      'university',
      'college',
      'hospital',
      'civic',
      'public',
      'church',
      'government',
    ].includes(value)
  )
    return BuildingType.Public;
  if (['train_station', 'transportation'].includes(value)) return BuildingType.Transport;
  return BuildingType.Other;
}

/** "45", "45 m", "150'" (feet) → metres; unparseable → undefined. */
export function parseMetres(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const feet = /^\s*([\d.]+)\s*('|ft)\s*$/.exec(value);
  if (feet !== null) return Number(feet[1]) * 0.3048;
  const metres = /^\s*([\d.]+)\s*(m)?\s*$/.exec(value);
  if (metres === null) return undefined;
  const n = Number(metres[1]);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Height rule: height tag → levels × storey height → type default. */
export function heightOf(
  tags: Tags,
  type: BuildingType,
): { height: number; baseZ: number; levels: number; flag: number } {
  const storey = STOREY_M[type] ?? DEFAULT_STOREY_M;
  const levelsTag = parseMetres(tags['building:levels']);
  const minLevel = parseMetres(tags['building:min_level']) ?? 0;
  const baseZ = parseMetres(tags.min_height) ?? minLevel * storey;
  const tagged = parseMetres(tags.height);
  if (tagged !== undefined && tagged > baseZ) {
    return {
      height: tagged,
      baseZ,
      levels: Math.max(1, Math.round(levelsTag ?? tagged / storey)),
      flag: BuildingFlag.HeightFromTag,
    };
  }
  if (levelsTag !== undefined && levelsTag > 0) {
    return {
      height: baseZ + levelsTag * storey,
      baseZ,
      levels: Math.round(levelsTag),
      flag: BuildingFlag.HeightFromLevels,
    };
  }
  const levels = DEFAULT_LEVELS[type] ?? 2;
  return { height: baseZ + levels * storey, baseZ, levels, flag: BuildingFlag.HeightDefault };
}

export function extractBuildings(
  data: OsmData,
  toLocal: (lon: number, lat: number) => [number, number],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): { buildings: Building[]; qa: BuildingsQa } {
  const qa: BuildingsQa = {
    buildings: 0,
    parts: 0,
    outlinesWithParts: 0,
    heightFromTag: 0,
    heightFromLevels: 0,
    heightDefault: 0,
    skippedTiny: 0,
    skippedOpenRings: 0,
    multipolygons: 0,
  };
  const buildings: Building[] = [];
  const project = (refs: number[]): [number, number][] | null => {
    const points: [number, number][] = [];
    for (const ref of refs) {
      const node = data.nodes.get(ref);
      if (node === undefined) return null;
      points.push(toLocal(node.lon, node.lat));
    }
    return points;
  };

  const add = (osmId: number, isRelation: boolean, tags: Tags, refs: number[]): void => {
    const isPart = tags['building:part'] !== undefined && tags['building:part'] !== 'no';
    const isBuilding =
      tags.building !== undefined && tags.building !== 'no' && tags.building !== 'construction';
    if (!isPart && !isBuilding) return;
    if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) {
      qa.skippedOpenRings++;
      return;
    }
    const projected = project(refs.slice(0, -1));
    if (projected === null) return;
    let ring = removeDuplicates(projected);
    let area = signedArea(ring);
    if (Math.abs(area) < 4 || ring.length < 3) {
      qa.skippedTiny++;
      return;
    }
    if (area < 0) {
      ring = ring.reverse();
      area = -area;
    }
    const [cx, cy] = centroid(ring);
    if (cx < bounds.minX || cx > bounds.maxX || cy < bounds.minY || cy > bounds.maxY) return;
    const type = buildingType(tags);
    const { height, baseZ, levels, flag } = heightOf(tags, type);
    const capacity = isPart ? 0 : Math.round((area * levels) / (M2_PER_PERSON[type] ?? 25));
    buildings.push({
      osmId,
      isRelation,
      ring,
      areaM2: area,
      levels,
      baseZ,
      height,
      type,
      flags: flag | (isPart ? BuildingFlag.Part : 0),
      capacity,
      seed: hashId(osmId, isRelation),
    });
  };

  for (const way of data.ways.values()) add(way.id, false, way.tags, way.refs);
  for (const relation of data.relations.values()) {
    if (relation.tags.type !== 'multipolygon') continue;
    if (relation.tags.building === undefined && relation.tags['building:part'] === undefined)
      continue;
    const outers = relation.members
      .filter((m) => m.type === 'w' && (m.role === 'outer' || m.role === ''))
      .map((m) => data.ways.get(m.ref)?.refs)
      .filter((refs): refs is number[] => refs !== undefined);
    for (const ring of assembleRings(outers)) add(relation.id, true, relation.tags, ring);
    qa.multipolygons++;
  }

  // Outlines with parts inside: renderers draw the parts instead.
  const parts = buildings.filter((b) => (b.flags & BuildingFlag.Part) !== 0);
  for (const building of buildings) {
    if ((building.flags & BuildingFlag.Part) !== 0) continue;
    if (parts.some((part) => pointInPolygon(centroid(part.ring), building.ring)))
      building.flags |= BuildingFlag.HasParts;
  }

  for (const b of buildings) {
    if ((b.flags & BuildingFlag.Part) !== 0) qa.parts++;
    else qa.buildings++;
    if ((b.flags & BuildingFlag.HasParts) !== 0) qa.outlinesWithParts++;
    if ((b.flags & BuildingFlag.HeightFromTag) !== 0) qa.heightFromTag++;
    if ((b.flags & BuildingFlag.HeightFromLevels) !== 0) qa.heightFromLevels++;
    if ((b.flags & BuildingFlag.HeightDefault) !== 0) qa.heightDefault++;
  }
  return { buildings, qa };
}

/** Joins open member ways end to end into closed rings (node id lists, first == last). */
export function assembleRings(ways: number[][]): number[][] {
  const pending = ways.map((w) => [...w]);
  const rings: number[][] = [];
  for (let next = pending.shift(); next !== undefined; next = pending.shift()) {
    let ring = next;
    let extended = true;
    while (ring[0] !== ring[ring.length - 1] && extended) {
      extended = false;
      for (let i = 0; i < pending.length; i++) {
        const way = pending[i];
        const tail = ring[ring.length - 1];
        if (way[0] === tail) ring = [...ring, ...way.slice(1)];
        else if (way[way.length - 1] === tail) ring = [...ring, ...[...way].reverse().slice(1)];
        else continue;
        pending.splice(i, 1);
        extended = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

export function signedArea(ring: readonly [number, number][]): number {
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

export function centroid(ring: readonly [number, number][]): [number, number] {
  let x = 0;
  let y = 0;
  for (const p of ring) {
    x += p[0];
    y += p[1];
  }
  return [x / ring.length, y / ring.length];
}

export function pointInPolygon(p: [number, number], ring: readonly [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

function removeDuplicates(ring: [number, number][]): [number, number][] {
  return ring.filter((p, i) => {
    const q = ring[(i + ring.length - 1) % ring.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.01;
  });
}

function hashId(id: number, isRelation: boolean): number {
  let x = (id ^ (isRelation ? 0x9e3779b9 : 0)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}
