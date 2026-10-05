import { NO_BUILDING } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';

/**
 * Joins loaded tiles into one region graph (region frame: metres from the manifest origin), the
 * inverse of the pipeline's tiling: coordinates are offset by each tile's corner, and nodes linked
 * by portals are merged (boundary nodes become ordinary degree-2 nodes). Portals to tiles that are
 * not loaded are dropped. Buildings are placed at their region-wide ids.
 *
 * Node and edge ids follow the order of `tiles`, so pass tiles in manifest order for identical
 * results however they arrived.
 */
export interface StitchInput {
  tiles: readonly NavTile[];
  /** Region-wide id of each tile's first building. */
  buildingOffset: readonly number[];
  gridOrigin: { x: number; y: number };
  tileSizeM: number;
}

export function stitchTiles(input: StitchInput): NavTile {
  const { tiles, gridOrigin, tileSizeM } = input;
  const nodeBase: number[] = [];
  const index = new Map<string, number>();
  let nodeTotal = 0;
  tiles.forEach((tile, t) => {
    nodeBase.push(nodeTotal);
    index.set(`${tile.tileX},${tile.tileY}`, t);
    nodeTotal += tile.nodes.x.length;
  });

  // Merge portal-linked nodes: each keeps the smallest global id of its group.
  const parent = Int32Array.from({ length: nodeTotal }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  tiles.forEach((tile, t) => {
    const p = tile.portals;
    for (let k = 0; k < p.localNode.length; k++) {
      const other = index.get(`${p.otherTileX[k]},${p.otherTileY[k]}`);
      if (other === undefined) continue;
      const a = find(nodeBase[t] + p.localNode[k]);
      const b = find(nodeBase[other] + p.otherNode[k]);
      if (a < b) parent[b] = a;
      else if (b < a) parent[a] = b;
    }
  });
  const compact = new Int32Array(nodeTotal).fill(-1);
  let nodeCount = 0;
  for (let i = 0; i < nodeTotal; i++) if (find(i) === i) compact[i] = nodeCount++;
  const nodeId = (t: number, local: number) => compact[find(nodeBase[t] + local)];

  const x = new Float32Array(nodeCount);
  const y = new Float32Array(nodeCount);
  const z = new Float32Array(nodeCount);
  const level = new Int8Array(nodeCount);
  const type = new Uint8Array(nodeCount);
  const flags = new Uint16Array(nodeCount);
  const buildingId = new Uint32Array(nodeCount).fill(NO_BUILDING);
  const written = new Uint8Array(nodeCount);
  tiles.forEach((tile, t) => {
    const ox = gridOrigin.x + tile.tileX * tileSizeM;
    const oy = gridOrigin.y + tile.tileY * tileSizeM;
    const n = tile.nodes;
    for (let i = 0; i < n.x.length; i++) {
      const id = nodeId(t, i);
      // Every copy has the same position; the first one seen supplies the attributes.
      if (written[id] === 1) {
        if (n.buildingId[i] !== NO_BUILDING) buildingId[id] = n.buildingId[i];
        continue;
      }
      written[id] = 1;
      x[id] = n.x[i] + ox;
      y[id] = n.y[i] + oy;
      z[id] = n.z[i];
      level[id] = n.level[i];
      type[id] = n.type[i];
      flags[id] = n.flags[i];
      if (n.buildingId[i] !== NO_BUILDING) buildingId[id] = n.buildingId[i];
    }
  });
  // Copies of an original node carry Junction; the merged node keeps the most specific type in
  // its group (Junction < End < Entrance), which is the home copy's.
  tiles.forEach((tile, t) => {
    for (let i = 0; i < tile.nodes.x.length; i++) {
      const id = nodeId(t, i);
      if (tile.nodes.type[i] > type[id]) type[id] = tile.nodes.type[i];
    }
  });

  const edgeCount = tiles.reduce((s, tile) => s + tile.edges.from.length, 0);
  const pointCount = tiles.reduce((s, tile) => s + tile.polylines.x.length, 0);
  const edges = {
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
  const polylines = {
    x: new Float32Array(pointCount),
    y: new Float32Array(pointCount),
    z: new Float32Array(pointCount),
    cumLength: new Float32Array(pointCount),
  };
  let e0 = 0;
  let p0 = 0;
  tiles.forEach((tile, t) => {
    const ox = gridOrigin.x + tile.tileX * tileSizeM;
    const oy = gridOrigin.y + tile.tileY * tileSizeM;
    const te = tile.edges;
    for (let i = 0; i < te.from.length; i++) {
      const e = e0 + i;
      edges.from[e] = nodeId(t, te.from[i]);
      edges.to[e] = nodeId(t, te.to[i]);
      edges.length[e] = te.length[i];
      edges.polyOffset[e] = p0 + te.polyOffset[i];
      edges.polyCount[e] = te.polyCount[i];
      edges.widthCm[e] = te.widthCm[i];
      edges.type[e] = te.type[i];
      edges.permissions[e] = te.permissions[i];
      edges.levelDelta[e] = te.levelDelta[i];
      edges.flags[e] = te.flags[i];
      edges.osmIdLo[e] = te.osmIdLo[i];
      edges.osmIdHi[e] = te.osmIdHi[i];
    }
    const tp = tile.polylines;
    for (let k = 0; k < tp.x.length; k++) {
      polylines.x[p0 + k] = tp.x[k] + ox;
      polylines.y[p0 + k] = tp.y[k] + oy;
      polylines.z[p0 + k] = tp.z[k];
      polylines.cumLength[p0 + k] = tp.cumLength[k];
    }
    e0 += te.from.length;
    p0 += tp.x.length;
  });

  const degree = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeCount; e++) {
    degree[edges.from[e] + 1]++;
    degree[edges.to[e] + 1]++;
  }
  const firstHalfEdge = new Uint32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) firstHalfEdge[i + 1] = firstHalfEdge[i] + degree[i + 1];
  const cursor = firstHalfEdge.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeCount * 2);
  for (let e = 0; e < edgeCount; e++) {
    adjacency[cursor[edges.from[e]]++] = e * 2;
    adjacency[cursor[edges.to[e]]++] = e * 2 + 1;
  }

  // Buildings at their region-wide ids (tiles not loaded leave empty rows).
  let buildingTotal = 0;
  tiles.forEach((tile, t) => {
    buildingTotal = Math.max(
      buildingTotal,
      input.buildingOffset[t] + tile.buildings.ringOffset.length,
    );
  });
  const ringTotal = tiles.reduce((s, tile) => s + tile.buildings.ringX.length, 0);
  const b = {
    ringOffset: new Uint32Array(buildingTotal),
    ringCount: new Uint16Array(buildingTotal),
    levels: new Int16Array(buildingTotal),
    baseZ: new Float32Array(buildingTotal),
    height: new Float32Array(buildingTotal),
    type: new Uint8Array(buildingTotal),
    flags: new Uint8Array(buildingTotal),
    capacity: new Uint32Array(buildingTotal),
    seed: new Uint32Array(buildingTotal),
    osmIdLo: new Uint32Array(buildingTotal),
    osmIdHi: new Uint32Array(buildingTotal),
    ringX: new Float32Array(ringTotal),
    ringY: new Float32Array(ringTotal),
  };
  let r0 = 0;
  tiles.forEach((tile, t) => {
    const ox = gridOrigin.x + tile.tileX * tileSizeM;
    const oy = gridOrigin.y + tile.tileY * tileSizeM;
    const tb = tile.buildings;
    const base = input.buildingOffset[t];
    for (let i = 0; i < tb.ringOffset.length; i++) {
      const id = base + i;
      b.ringOffset[id] = r0 + tb.ringOffset[i];
      b.ringCount[id] = tb.ringCount[i];
      b.levels[id] = tb.levels[i];
      b.baseZ[id] = tb.baseZ[i];
      b.height[id] = tb.height[i];
      b.type[id] = tb.type[i];
      b.flags[id] = tb.flags[i];
      b.capacity[id] = tb.capacity[i];
      b.seed[id] = tb.seed[i];
      b.osmIdLo[id] = tb.osmIdLo[i];
      b.osmIdHi[id] = tb.osmIdHi[i];
    }
    for (let k = 0; k < tb.ringX.length; k++) {
      b.ringX[r0 + k] = tb.ringX[k] + ox;
      b.ringY[r0 + k] = tb.ringY[k] + oy;
    }
    r0 += tb.ringX.length;
  });

  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: tileSizeM * Math.max(1, Math.ceil(Math.sqrt(tiles.length))),
    nodes: { x, y, z, level, type, flags, firstHalfEdge, buildingId },
    edges,
    adjacency,
    portals: noPortals(),
    polylines,
    buildings: b,
  };
}
