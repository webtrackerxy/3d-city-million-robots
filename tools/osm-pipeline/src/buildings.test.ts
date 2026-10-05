import { BuildingFlag, BuildingType } from '@city/core-types';
import { describe, expect, it } from 'vitest';
import {
  assembleRings,
  buildingType,
  extractBuildings,
  heightOf,
  parseMetres,
} from './buildings.ts';
import type { OsmData } from './opl.ts';

const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
// 1 unit of "lon/lat" = 1 m, so the tests read in metres.
const toLocal = (lon: number, lat: number): [number, number] => [lon, lat];

function data(): OsmData {
  const nodes = new Map<
    number,
    { id: number; lon: number; lat: number; tags: Record<string, string> }
  >();
  const square = (base: number, x: number, y: number, size: number, clockwise = false) => {
    const corners: [number, number][] = [
      [x, y],
      [x + size, y],
      [x + size, y + size],
      [x, y + size],
    ];
    (clockwise ? corners.reverse() : corners).forEach(([lon, lat], i) =>
      nodes.set(base + i, { id: base + i, lon, lat, tags: {} }),
    );
    return [base, base + 1, base + 2, base + 3, base];
  };
  const tower = square(10, 0, 0, 40, true);
  const part = square(20, 10, 10, 10);
  const house = square(30, 100, 0, 8);
  const shed = square(40, 200, 0, 1); // 1 m²: too small
  const mp = square(50, 300, 0, 20);
  return {
    nodes,
    ways: new Map([
      [1, { id: 1, tags: { building: 'office', 'building:levels': '50' }, refs: tower }],
      [
        2,
        { id: 2, tags: { 'building:part': 'yes', height: '235 m', min_height: '10' }, refs: part },
      ],
      [3, { id: 3, tags: { building: 'house' }, refs: house }],
      [4, { id: 4, tags: { building: 'yes' }, refs: shed }],
      [5, { id: 5, tags: {}, refs: mp.slice(0, 3) }],
      [6, { id: 6, tags: {}, refs: mp.slice(2) }],
    ]),
    relations: new Map([
      [
        7,
        {
          id: 7,
          tags: { type: 'multipolygon', building: 'retail' },
          members: [
            { type: 'w' as const, ref: 5, role: 'outer' },
            { type: 'w' as const, ref: 6, role: 'outer' },
          ],
        },
      ],
    ]),
  };
}

describe('building heights', () => {
  it('prefers the height tag, then levels × storey height, then a type default', () => {
    expect(
      heightOf({ height: '120 m', 'building:levels': '30' }, BuildingType.Office),
    ).toMatchObject({ height: 120, levels: 30, flag: BuildingFlag.HeightFromTag });
    expect(heightOf({ 'building:levels': '10' }, BuildingType.Office).height).toBeCloseTo(39, 6);
    expect(heightOf({}, BuildingType.Residential)).toMatchObject({
      height: 12,
      flag: BuildingFlag.HeightDefault,
    });
    expect(
      heightOf({ 'building:levels': '3', 'building:min_level': '2' }, BuildingType.Residential),
    ).toMatchObject({ baseZ: 6, height: 15 });
  });

  it('parses metres and feet', () => {
    expect(parseMetres('45')).toBe(45);
    expect(parseMetres('45 m')).toBe(45);
    expect(parseMetres("100'")).toBeCloseTo(30.48, 6);
    expect(parseMetres('tall')).toBeUndefined();
  });

  it('maps building values to types', () => {
    expect(buildingType({ building: 'apartments' })).toBe(BuildingType.Residential);
    expect(buildingType({ building: 'office' })).toBe(BuildingType.Office);
    expect(buildingType({ 'building:part': 'yes' })).toBe(BuildingType.Other);
  });
});

describe('assembleRings', () => {
  it('joins open ways end to end, reversing where needed', () => {
    expect(
      assembleRings([
        [1, 2, 3],
        [1, 4, 3],
      ]),
    ).toEqual([[1, 2, 3, 4, 1]]);
    expect(assembleRings([[1, 2]])).toEqual([]);
  });
});

describe('extractBuildings', () => {
  it('extracts ways and multipolygons, fixes orientation, flags parts, and skips slivers', () => {
    const { buildings, qa } = extractBuildings(data(), toLocal, bounds);
    expect(qa).toMatchObject({
      buildings: 3,
      parts: 1,
      outlinesWithParts: 1,
      skippedTiny: 1,
      multipolygons: 1,
    });
    const tower = buildings.find((b) => b.osmId === 1);
    expect(tower?.areaM2).toBeCloseTo(1600, 6);
    expect((tower?.flags ?? 0) & BuildingFlag.HasParts).toBe(BuildingFlag.HasParts);
    expect(tower?.capacity).toBe(Math.round((1600 * 50) / 10));
    const part = buildings.find((b) => b.osmId === 2);
    expect(part).toMatchObject({ height: 235, baseZ: 10, capacity: 0 });
    const retail = buildings.find((b) => b.isRelation);
    expect(retail?.type).toBe(BuildingType.Retail);
    for (const b of buildings) {
      let area = 0;
      b.ring.forEach(([x1, y1], i) => {
        const [x2, y2] = b.ring[(i + 1) % b.ring.length] ?? [0, 0];
        area += x1 * y2 - x2 * y1;
      });
      expect(area).toBeGreaterThan(0); // counter-clockwise
    }
  });
});
