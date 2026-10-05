import { BuildingFlag, BuildingType } from '@city/core-types';
import type { NavBuildings } from '@city/formats';
import { ShapeUtils, Vector2 } from 'three';

/**
 * Extruded footprints for every building in a tile, merged into one indexed mesh (one draw).
 * Tile frame (x east, y north, z up) → Three (X = x, Y = z, Z = −y).
 */
export interface MeshArrays {
  positions: Float32Array;
  normals: Float32Array;
  colours: Float32Array;
  indices: Uint32Array;
  /** Buildings drawn (outlines whose parts are drawn instead are skipped). */
  drawn: number;
}

/** Linear RGB per BuildingType. */
const TYPE_COLOURS: Record<number, [number, number, number]> = {
  [BuildingType.Other]: [0.55, 0.57, 0.6],
  [BuildingType.Residential]: [0.72, 0.62, 0.5],
  [BuildingType.Office]: [0.45, 0.58, 0.72],
  [BuildingType.Commercial]: [0.5, 0.64, 0.72],
  [BuildingType.Retail]: [0.75, 0.55, 0.45],
  [BuildingType.Industrial]: [0.55, 0.52, 0.45],
  [BuildingType.Public]: [0.62, 0.7, 0.52],
  [BuildingType.Transport]: [0.7, 0.66, 0.4],
};
/** Buildings with a guessed height are drawn paler, so the data gap is visible. */
const DEFAULT_HEIGHT_TINT = 0.55;

/**
 * `ground` (region frame; the tile's origin is `ox`, `oy`): where a wall corner starts, if not at
 * the building's base — the street beside it, on a slope (never below the base).
 */
export function buildingGeometry(
  buildings: NavBuildings,
  ground?: (x: number, y: number) => number | null,
  ox = 0,
  oy = 0,
): MeshArrays {
  const count = buildings.ringOffset.length;
  let vertices = 0;
  let triangles = 0;
  const include = (i: number) =>
    (buildings.flags[i] & (BuildingFlag.HasParts | BuildingFlag.Virtual)) === 0;
  for (let i = 0; i < count; i++) {
    if (!include(i)) continue;
    const n = buildings.ringCount[i];
    vertices += n * 4 + n; // wall quads + roof
    triangles += n * 2 + (n - 2);
  }
  const positions = new Float32Array(vertices * 3);
  const normals = new Float32Array(vertices * 3);
  const colours = new Float32Array(vertices * 3);
  const indices = new Uint32Array(triangles * 3);
  let v = 0;
  let t = 0;
  let drawn = 0;
  const vertex = (
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    c: [number, number, number],
  ) => {
    positions.set([x, z, -y], v * 3);
    normals.set([nx, nz, -ny], v * 3);
    colours.set(c, v * 3);
    return v++;
  };

  for (let i = 0; i < count; i++) {
    if (!include(i)) continue;
    drawn++;
    const offset = buildings.ringOffset[i];
    const n = buildings.ringCount[i];
    const base = buildings.baseZ[i];
    const top = Math.max(base + 0.5, buildings.height[i]);
    const foot = (x: number, y: number) =>
      Math.min(top - 0.5, Math.max(base, ground?.(x + ox, y + oy) ?? base));
    let colour = TYPE_COLOURS[buildings.type[i]] ?? TYPE_COLOURS[BuildingType.Other];
    if ((buildings.flags[i] & BuildingFlag.HeightDefault) !== 0)
      colour = colour.map((c) => c + (1 - c) * DEFAULT_HEIGHT_TINT) as [number, number, number];

    // Walls: the ring is counter-clockwise, so (dy, −dx) points outwards.
    for (let k = 0; k < n; k++) {
      const x1 = buildings.ringX[offset + k];
      const y1 = buildings.ringY[offset + k];
      const x2 = buildings.ringX[offset + ((k + 1) % n)];
      const y2 = buildings.ringY[offset + ((k + 1) % n)];
      const length = Math.hypot(x2 - x1, y2 - y1) || 1;
      const nx = (y2 - y1) / length;
      const ny = -(x2 - x1) / length;
      const a = vertex(x1, y1, foot(x1, y1), nx, ny, 0, colour);
      const b = vertex(x2, y2, foot(x2, y2), nx, ny, 0, colour);
      const c = vertex(x2, y2, top, nx, ny, 0, colour);
      const d = vertex(x1, y1, top, nx, ny, 0, colour);
      indices.set([a, b, c, a, c, d], t);
      t += 6;
    }

    // Roof: triangulated footprint at the top.
    const contour = Array.from(
      { length: n },
      (_, k) => new Vector2(buildings.ringX[offset + k], buildings.ringY[offset + k]),
    );
    const first = v;
    for (const p of contour) vertex(p.x, p.y, top, 0, 0, 1, colour);
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      if (t + 3 > indices.length) break;
      indices.set([first + a, first + b, first + c], t);
      t += 3;
    }
  }
  return { positions, normals, colours, indices: indices.subarray(0, t), drawn };
}
