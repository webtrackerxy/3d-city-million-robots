import { BuildingFlag, EdgeFlag, EdgePermission, EdgeType, NodeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import type { Point } from './polygon.ts';
import { pointInPolygon } from './polygon.ts';
import { roofWalk } from './roof.ts';

/** A box in the region frame (x east, y north, metres). */
export interface RoofZone {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface AppendedRoofs {
  /** The region graph with the roof walks appended (their nodes and edges come after the rest). */
  tile: NavTile;
  /** Edges from here on are roof walks. */
  firstRoofEdge: number;
  /** Buildings that got a roof walk. */
  roofs: number;
}

/** Roofs lower than this (two storeys or so) get no walk. */
export const MIN_ROOF_HEIGHT_M = 6;
/** Roof walk width: one lane, its walkers kept within ±0.5 m of the line. */
const ROOF_WIDTH_CM = 160;
/** Feet this far above the roof, so they never sink into it. */
const ROOF_STAND_M = 0.02;
/** Points of a walk are checked against taller buildings this far apart. */
const OVERLAP_STEP_M = 3;
const GRID_M = 50;

/**
 * Appends a roof walk for every drawn building at least MIN_ROOF_HEIGHT_M tall whose centre is in
 * `zone` (default: the whole region). Each walk is an island: it joins nothing on the ground, and
 * routing never uses it (EdgeType.Roof). A roof partly under a taller building (a podium round a
 * tower) gets no walk, so nobody walks through the tower's walls.
 */
export function appendRoofs(region: NavTile, zone?: RoofZone): AppendedRoofs {
  const { nodes, edges, buildings } = region;
  const count = buildings.ringOffset.length;
  const drawn = (b: number) =>
    (buildings.flags[b] & (BuildingFlag.HasParts | BuildingFlag.Virtual)) === 0 &&
    buildings.ringCount[b] >= 3;
  const top = (b: number) => Math.max(buildings.baseZ[b] + 0.5, buildings.height[b]);
  const ringOf = (b: number): Point[] => {
    const ring: Point[] = [];
    for (let k = 0; k < buildings.ringCount[b]; k++)
      ring.push([
        buildings.ringX[buildings.ringOffset[b] + k],
        buildings.ringY[buildings.ringOffset[b] + k],
      ]);
    return ring;
  };
  const box = (b: number) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < buildings.ringCount[b]; k++) {
      const x = buildings.ringX[buildings.ringOffset[b] + k];
      const y = buildings.ringY[buildings.ringOffset[b] + k];
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
    return { minX, minY, maxX, maxY };
  };
  const inZone = (b: number) => {
    if (zone === undefined) return true;
    const { minX, minY, maxX, maxY } = box(b);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    return cx >= zone.minX && cx < zone.maxX && cy >= zone.minY && cy < zone.maxY;
  };

  // Drawn buildings by grid cell (their boxes), for the taller-neighbour check.
  const cellKey = (i: number, j: number) => i * 1_000_003 + j;
  const grid = new Map<number, number[]>();
  const margin = 200;
  for (let b = 0; b < count; b++) {
    if (!drawn(b)) continue;
    const bb = box(b);
    if (
      zone !== undefined &&
      (bb.maxX < zone.minX - margin ||
        bb.minX > zone.maxX + margin ||
        bb.maxY < zone.minY - margin ||
        bb.minY > zone.maxY + margin)
    )
      continue;
    for (let i = Math.floor(bb.minX / GRID_M); i <= Math.floor(bb.maxX / GRID_M); i++)
      for (let j = Math.floor(bb.minY / GRID_M); j <= Math.floor(bb.maxY / GRID_M); j++) {
        const key = cellKey(i, j);
        const list = grid.get(key);
        if (list === undefined) grid.set(key, [b]);
        else list.push(b);
      }
  }
  const rings = new Map<number, Point[]>();
  const underTaller = (b: number, x: number, y: number): boolean => {
    for (const o of grid.get(cellKey(Math.floor(x / GRID_M), Math.floor(y / GRID_M))) ?? []) {
      if (o === b || top(o) <= top(b) + 0.5) continue;
      let ring = rings.get(o);
      if (ring === undefined) rings.set(o, (ring = ringOf(o)));
      if (pointInPolygon([x, y], ring)) return true;
    }
    return false;
  };

  const nx: number[] = [];
  const ny: number[] = [];
  const nz: number[] = [];
  const nBuilding: number[] = [];
  const eFrom: number[] = [];
  const eTo: number[] = [];
  const eLength: number[] = [];
  const baseNodes = nodes.x.length;
  const baseEdges = edges.from.length;
  let roofs = 0;

  for (let b = 0; b < count; b++) {
    if (!drawn(b) || top(b) < MIN_ROOF_HEIGHT_M || !inZone(b)) continue;
    const walk = roofWalk(ringOf(b));
    if (walk === null) continue;
    let covered = walk.x.some((x, i) => underTaller(b, x, walk.y[i]));
    for (let e = 0; e < walk.from.length && !covered; e++) {
      const steps = Math.floor(walk.length[e] / OVERLAP_STEP_M);
      const [a, c] = [walk.from[e], walk.to[e]];
      for (let s = 1; s <= steps && !covered; s++) {
        const t = s / (steps + 1);
        covered = underTaller(
          b,
          walk.x[a] + (walk.x[c] - walk.x[a]) * t,
          walk.y[a] + (walk.y[c] - walk.y[a]) * t,
        );
      }
    }
    if (covered) continue;
    const firstNode = baseNodes + nx.length;
    const z = top(b) + ROOF_STAND_M;
    for (let i = 0; i < walk.x.length; i++) {
      nx.push(walk.x[i]);
      ny.push(walk.y[i]);
      nz.push(z);
      nBuilding.push(b);
    }
    for (let e = 0; e < walk.from.length; e++) {
      eFrom.push(firstNode + walk.from[e]);
      eTo.push(firstNode + walk.to[e]);
      eLength.push(walk.length[e]);
    }
    roofs++;
  }

  // Concatenate and rebuild the CSR adjacency.
  const nodeCount = baseNodes + nx.length;
  const edgeCount = baseEdges + eFrom.length;
  const cat = <T extends Float32Array | Uint32Array | Uint16Array | Uint8Array | Int8Array>(
    make: new (n: number) => T,
    base: T,
    extra: readonly number[] | number,
    total: number,
  ): T => {
    const out = new make(total);
    out.set(base);
    if (typeof extra === 'number') out.fill(extra, base.length);
    else out.set(extra, base.length);
    return out;
  };
  const from = cat(Uint32Array, edges.from, eFrom, edgeCount);
  const to = cat(Uint32Array, edges.to, eTo, edgeCount);
  const degree = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    degree[from[e] + 1]++;
    degree[to[e] + 1]++;
  }
  const firstHalfEdge = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) firstHalfEdge[n + 1] = firstHalfEdge[n] + degree[n + 1];
  const cursor = firstHalfEdge.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    adjacency[cursor[from[e]]++] = e * 2;
    adjacency[cursor[to[e]]++] = e * 2 + 1;
  }
  return {
    tile: {
      tileX: region.tileX,
      tileY: region.tileY,
      tileSizeM: region.tileSizeM,
      nodes: {
        x: cat(Float32Array, nodes.x, nx, nodeCount),
        y: cat(Float32Array, nodes.y, ny, nodeCount),
        z: cat(Float32Array, nodes.z, nz, nodeCount),
        level: cat(Int8Array, nodes.level, 0, nodeCount),
        type: cat(Uint8Array, nodes.type, NodeType.Roof, nodeCount),
        flags: cat(Uint16Array, nodes.flags, 0, nodeCount),
        firstHalfEdge,
        buildingId: cat(Uint32Array, nodes.buildingId, nBuilding, nodeCount),
      },
      edges: {
        from,
        to,
        length: cat(Float32Array, edges.length, eLength, edgeCount),
        // No polyline points: each roof edge is one straight segment.
        polyOffset: cat(Uint32Array, edges.polyOffset, region.polylines.x.length, edgeCount),
        polyCount: cat(Uint16Array, edges.polyCount, 0, edgeCount),
        widthCm: cat(Uint16Array, edges.widthCm, ROOF_WIDTH_CM, edgeCount),
        type: cat(Uint8Array, edges.type, EdgeType.Roof, edgeCount),
        permissions: cat(
          Uint8Array,
          edges.permissions,
          EdgePermission.Human | EdgePermission.Robot | EdgePermission.StepFree,
          edgeCount,
        ),
        levelDelta: cat(Int8Array, edges.levelDelta, 0, edgeCount),
        flags: cat(Uint8Array, edges.flags, EdgeFlag.Inferred, edgeCount),
        osmIdLo: cat(Uint32Array, edges.osmIdLo, 0, edgeCount),
        osmIdHi: cat(Uint32Array, edges.osmIdHi, 0, edgeCount),
      },
      adjacency,
      portals: noPortals(),
      polylines: region.polylines,
      buildings: region.buildings,
    },
    firstRoofEdge: baseEdges,
    roofs,
  };
}
