import { NO_BUILDING, NodeFlag, NodeType } from '@city/core-types';
import {
  type NavTile,
  noPortals,
  type RegionManifest,
  writeNavTile,
  writeTileContainer,
} from '@city/formats';
import type { Building } from './buildings.ts';
import type { EntranceNode } from './entrances.ts';
import type { Topology } from './topology.ts';

/**
 * Stage 11 (implementation plan §10): the tile arrays, CSR adjacency and interior polylines.
 * M2 writes one tile covering the region; the format and manifest already describe a tile grid
 * (M5 adds tiling, portals and streaming).
 */
export function buildNavTile(
  topology: Topology,
  buildings: readonly Building[],
  tileSizeM: number,
  entrances: ReadonlyMap<number, EntranceNode> = new Map(),
): NavTile {
  const { nodes, edges } = topology;
  const nodeCount = nodes.length;
  const edgeCount = edges.length;

  // CSR adjacency: half-edge e·2 leaves `from`, e·2 + 1 leaves `to`.
  const degree = new Uint32Array(nodeCount + 1);
  for (const e of edges) {
    degree[e.from + 1]++;
    degree[e.to + 1]++;
  }
  const firstHalfEdge = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) firstHalfEdge[n + 1] = firstHalfEdge[n] + degree[n + 1];
  const cursor = firstHalfEdge.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeCount * 2);
  edges.forEach((e, i) => {
    adjacency[cursor[e.from]++] = i * 2;
    adjacency[cursor[e.to]++] = i * 2 + 1;
  });

  const interior = edges.reduce((n, e) => n + Math.max(0, e.points.length - 2), 0);
  const poly = {
    x: new Float32Array(interior),
    y: new Float32Array(interior),
    z: new Float32Array(interior),
    cumLength: new Float32Array(interior),
  };
  const edgeArrays = {
    from: new Uint32Array(edgeCount),
    to: new Uint32Array(edgeCount),
    length: new Float32Array(edgeCount),
    polyOffset: new Uint32Array(edgeCount),
    polyCount: new Uint16Array(edgeCount),
    widthCm: new Uint16Array(edgeCount),
    type: new Uint8Array(edgeCount),
    permissions: new Uint8Array(edgeCount),
    levelDelta: new Int8Array(edgeCount),
    flags: new Uint8Array(edgeCount),
    osmIdLo: new Uint32Array(edgeCount),
    osmIdHi: new Uint32Array(edgeCount),
  };
  let p = 0;
  edges.forEach((e, i) => {
    edgeArrays.from[i] = e.from;
    edgeArrays.to[i] = e.to;
    edgeArrays.length[i] = e.length;
    edgeArrays.polyOffset[i] = p;
    edgeArrays.widthCm[i] = e.attributes.widthCm;
    edgeArrays.type[i] = e.attributes.type;
    edgeArrays.permissions[i] = e.attributes.permissions;
    edgeArrays.flags[i] = e.attributes.flags;
    edgeArrays.osmIdLo[i] = e.osmWayId >>> 0;
    edgeArrays.osmIdHi[i] = Math.floor(e.osmWayId / 2 ** 32);
    let cumulative = 0;
    for (let k = 1; k < e.points.length; k++) {
      cumulative += Math.hypot(
        e.points[k][0] - e.points[k - 1][0],
        e.points[k][1] - e.points[k - 1][1],
      );
      if (k === e.points.length - 1) break;
      poly.x[p] = e.points[k][0];
      poly.y[p] = e.points[k][1];
      poly.cumLength[p] = cumulative;
      p++;
    }
    edgeArrays.polyCount[i] = p - edgeArrays.polyOffset[i];
  });

  const ringPoints = buildings.reduce((n, b) => n + b.ring.length, 0);
  const b = {
    ringOffset: new Uint32Array(buildings.length),
    ringCount: new Uint16Array(buildings.length),
    levels: new Int16Array(buildings.length),
    baseZ: new Float32Array(buildings.length),
    height: new Float32Array(buildings.length),
    type: new Uint8Array(buildings.length),
    flags: new Uint8Array(buildings.length),
    capacity: new Uint32Array(buildings.length),
    seed: new Uint32Array(buildings.length),
    osmIdLo: new Uint32Array(buildings.length),
    osmIdHi: new Uint32Array(buildings.length),
    ringX: new Float32Array(ringPoints),
    ringY: new Float32Array(ringPoints),
  };
  let r = 0;
  buildings.forEach((building, i) => {
    b.ringOffset[i] = r;
    b.ringCount[i] = building.ring.length;
    b.levels[i] = building.levels;
    b.baseZ[i] = building.baseZ;
    b.height[i] = building.height;
    b.type[i] = building.type;
    b.flags[i] = building.flags;
    b.capacity[i] = building.capacity;
    b.seed[i] = building.seed;
    b.osmIdLo[i] = building.osmId >>> 0;
    b.osmIdHi[i] =
      (Math.floor(building.osmId / 2 ** 32) | (building.isRelation ? 0x80000000 : 0)) >>> 0;
    for (const [x, y] of building.ring) {
      b.ringX[r] = x;
      b.ringY[r] = y;
      r++;
    }
  });

  return {
    tileX: 0,
    tileY: 0,
    tileSizeM,
    nodes: {
      x: Float32Array.from(nodes, (n) => n.x),
      y: Float32Array.from(nodes, (n) => n.y),
      // Stage 7 (vertical placement) is later: flat ground for M2, levels kept for filtering.
      z: new Float32Array(nodeCount),
      level: Int8Array.from(nodes, (n) => n.level),
      type: Uint8Array.from(nodes, (n, i) =>
        entrances.has(n.osmId)
          ? NodeType.Entrance
          : degree[i + 1] === 1
            ? NodeType.End
            : NodeType.Junction,
      ),
      flags: Uint16Array.from(nodes, (n) =>
        entrances.get(n.osmId)?.synthetic === true ? NodeFlag.SyntheticEntrance : 0,
      ),
      firstHalfEdge,
      buildingId: Uint32Array.from(nodes, (n) => entrances.get(n.osmId)?.building ?? NO_BUILDING),
    },
    edges: edgeArrays,
    adjacency,
    portals: noPortals(),
    polylines: poly,
    buildings: b,
  };
}

export interface RegionFiles {
  manifest: RegionManifest;
  binaries: Record<string, ArrayBuffer>;
}

/** Binary files for every tile, and the manifest listing them. */
export function packRegion(
  tiles: readonly NavTile[],
  buildingOffset: readonly number[],
  manifest: Omit<RegionManifest, 'tiles' | 'format' | 'version'>,
): RegionFiles {
  const binaries: Record<string, ArrayBuffer> = {};
  const entries = tiles.map((tile, t) => {
    const container = writeTileContainer(writeNavTile(tile));
    const file = `tile_${tile.tileX}_${tile.tileY}.nav`;
    binaries[file] = container;
    const bytes = container.byteLength;
    return {
      x: tile.tileX,
      y: tile.tileY,
      file,
      counts: {
        nodes: tile.nodes.x.length,
        edges: tile.edges.from.length,
        buildings: tile.buildings.ringOffset.length,
        portals: tile.portals.localNode.length,
      },
      buildingOffset: buildingOffset[t] ?? 0,
      bytes,
    };
  });
  return {
    manifest: { format: 'city-nav', version: 1, ...manifest, tiles: entries },
    binaries,
  };
}
