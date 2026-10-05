import { NO_BUILDING, NodeType } from '@city/core-types';
import type { NavPortals, NavTile } from '@city/formats';

/**
 * Stage 11 (implementation plan §10, §16, Appendix A): the region graph cut into a fixed grid of
 * tiles. Every edge crossing a tile boundary is split there; the two boundary nodes (one in each
 * tile, same position) are joined by a portal in both tiles. A node whose edge's piece lies in a
 * neighbouring tile (a node exactly on a boundary) gets a copy there, joined the same way.
 * Coordinates become tile-local (relative to each tile's south-west corner); building ids stay
 * region-wide, numbered tile by tile.
 */
export interface Grid {
  /** South-west corner of tile (0, 0), region frame. */
  originX: number;
  originY: number;
  sizeM: number;
}

export interface TiledRegion {
  tiles: NavTile[];
  /** Region-wide id of each tile's first building (same order as `tiles`). */
  buildingOffset: number[];
  qa: { tiles: number; portals: number; splitEdges: number; boundaryNodes: number };
}

interface NodeRow {
  x: number;
  y: number;
  z: number;
  level: number;
  type: number;
  flags: number;
  buildingId: number;
}

interface EdgeRow {
  from: number;
  to: number;
  /** x, y, z (height, carried through cuts by interpolation). */
  points: [number, number, number][];
  source: number;
}

class TileBuilder {
  readonly nodes: NodeRow[] = [];
  readonly edges: EdgeRow[] = [];
  readonly portals: { local: number; tx: number; ty: number; other: number }[] = [];
  readonly buildings: number[] = [];
  /** Node key (original node or cut point) → local node id. */
  readonly byKey = new Map<string, number>();

  readonly tx: number;
  readonly ty: number;

  constructor(tx: number, ty: number) {
    this.tx = tx;
    this.ty = ty;
  }

  node(key: string, row: NodeRow): number {
    let id = this.byKey.get(key);
    if (id === undefined) {
      id = this.nodes.length;
      this.nodes.push(row);
      this.byKey.set(key, id);
    }
    return id;
  }
}

export function splitIntoTiles(region: NavTile, grid: Grid): TiledRegion {
  const { nodes, edges, polylines, buildings } = region;
  const tiles = new Map<string, TileBuilder>();
  const tileAt = (tx: number, ty: number): TileBuilder => {
    const key = `${tx},${ty}`;
    let tile = tiles.get(key);
    if (tile === undefined) tiles.set(key, (tile = new TileBuilder(tx, ty)));
    return tile;
  };
  const tileOf = (x: number, y: number): [number, number] => [
    Math.floor((x - grid.originX) / grid.sizeM),
    Math.floor((y - grid.originY) / grid.sizeM),
  ];
  const nodeRow = (n: number): NodeRow => ({
    x: nodes.x[n],
    y: nodes.y[n],
    z: nodes.z[n],
    level: nodes.level[n],
    type: nodes.type[n],
    flags: nodes.flags[n],
    buildingId: nodes.buildingId[n],
  });
  const link = (a: TileBuilder, aNode: number, b: TileBuilder, bNode: number) => {
    a.portals.push({ local: aNode, tx: b.tx, ty: b.ty, other: bNode });
    b.portals.push({ local: bNode, tx: a.tx, ty: a.ty, other: aNode });
  };
  // Every original node lives in its home tile, even if all its edges' pieces lie elsewhere.
  const home = (n: number): { tile: TileBuilder; id: number } => {
    const [tx, ty] = tileOf(nodes.x[n], nodes.y[n]);
    const tile = tileAt(tx, ty);
    return { tile, id: tile.node(`n${n}`, nodeRow(n)) };
  };
  /** The node for original node n in `tile`: its home copy, or a portal-linked copy. */
  const copies = new Set<string>();
  const originalIn = (n: number, tile: TileBuilder): number => {
    const h = home(n);
    if (h.tile === tile) return h.id;
    const id = tile.node(`n${n}`, { ...nodeRow(n), type: NodeType.Junction });
    const key = `${tile.tx},${tile.ty}:${n}`;
    if (!copies.has(key)) {
      copies.add(key);
      link(h.tile, h.id, tile, id);
    }
    return id;
  };
  for (let n = 0; n < nodes.x.length; n++) home(n);

  let splitEdges = 0;
  let boundaryNodes = 0;
  for (let e = 0; e < edges.from.length; e++) {
    const from0 = edges.from[e];
    const to0 = edges.to[e];
    const points: [number, number, number][] = [[nodes.x[from0], nodes.y[from0], nodes.z[from0]]];
    for (let k = 0; k < edges.polyCount[e]; k++) {
      const p = edges.polyOffset[e] + k;
      points.push([polylines.x[p], polylines.y[p], polylines.z[p]]);
    }
    points.push([nodes.x[to0], nodes.y[to0], nodes.z[to0]]);

    // Walk the polyline, cutting at every grid line it crosses.
    const pieces: [number, number, number][][] = [[points[0]]];
    for (let k = 1; k < points.length; k++) {
      const [ax, ay, az] = points[k - 1];
      const [bx, by, bz] = points[k];
      const cuts: number[] = [];
      const lines = (a: number, b: number, origin: number) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        for (let i = Math.ceil((lo - origin) / grid.sizeM); origin + i * grid.sizeM <= hi; i++) {
          const t = (origin + i * grid.sizeM - a) / (b - a);
          if (t > 1e-6 && t < 1 - 1e-6) cuts.push(t);
        }
      };
      if (ax !== bx) lines(ax, bx, grid.originX);
      if (ay !== by) lines(ay, by, grid.originY);
      cuts.sort((p, q) => p - q);
      for (const t of cuts) {
        const cut: [number, number, number] = [
          ax + (bx - ax) * t,
          ay + (by - ay) * t,
          az + (bz - az) * t,
        ];
        pieces[pieces.length - 1].push(cut);
        pieces.push([cut]);
      }
      pieces[pieces.length - 1].push([bx, by, bz]);
    }
    if (pieces.length > 1) splitEdges++;

    // Each piece belongs to the tile of its first segment's midpoint.
    const pieceTile = pieces.map((piece) => {
      const [a, b] = [piece[0], piece[1]];
      return tileAt(...tileOf((a[0] + b[0]) / 2, (a[1] + b[1]) / 2));
    });
    const level = nodes.level[edges.from[e]];
    let previousEnd = -1;
    pieces.forEach((piece, i) => {
      const tile = pieceTile[i];
      const cutRow = (p: [number, number, number]): NodeRow => ({
        x: p[0],
        y: p[1],
        z: p[2],
        level,
        type: NodeType.Junction,
        flags: 0,
        buildingId: NO_BUILDING,
      });
      let from: number;
      if (i === 0) from = originalIn(edges.from[e], tile);
      else {
        from = tile.node(`c${e}:${i}`, cutRow(piece[0]));
        const before = pieceTile[i - 1];
        if (before !== tile) {
          link(before, previousEnd, tile, from);
          boundaryNodes += 2;
        }
      }
      let to: number;
      if (i === pieces.length - 1) to = originalIn(edges.to[e], tile);
      else {
        const next = pieceTile[i + 1];
        // Same tile on both sides of the cut (a grazing cut): one shared node.
        to = tile.node(
          next === tile ? `c${e}:${i + 1}` : `c${e}:${i + 1}:end`,
          cutRow(piece[piece.length - 1]),
        );
      }
      previousEnd = to;
      tile.edges.push({ from, to, points: piece, source: e });
    });
  }

  // Buildings: tile of the ring centroid, numbered tile by tile.
  for (let b = 0; b < buildings.ringOffset.length; b++) {
    let cx = 0;
    let cy = 0;
    const o = buildings.ringOffset[b];
    const c = buildings.ringCount[b];
    for (let k = 0; k < c; k++) {
      cx += buildings.ringX[o + k];
      cy += buildings.ringY[o + k];
    }
    tileAt(...tileOf(cx / c, cy / c)).buildings.push(b);
  }
  const ordered = [...tiles.values()].sort((a, b) => a.ty - b.ty || a.tx - b.tx);
  const newBuildingId = new Uint32Array(buildings.ringOffset.length);
  const buildingOffset: number[] = [];
  let next = 0;
  for (const tile of ordered) {
    buildingOffset.push(next);
    for (const b of tile.buildings) newBuildingId[b] = next++;
  }

  const out = ordered.map((tile) => pack(tile, region, grid, newBuildingId));
  return {
    tiles: out,
    buildingOffset,
    qa: {
      tiles: out.length,
      portals: out.reduce((n, t) => n + t.portals.localNode.length, 0),
      splitEdges,
      boundaryNodes,
    },
  };
}

function pack(tile: TileBuilder, region: NavTile, grid: Grid, newBuildingId: Uint32Array): NavTile {
  const ox = grid.originX + tile.tx * grid.sizeM;
  const oy = grid.originY + tile.ty * grid.sizeM;
  const n = tile.nodes.length;
  const m = tile.edges.length;
  const degree = new Uint32Array(n + 1);
  for (const e of tile.edges) {
    degree[e.from + 1]++;
    degree[e.to + 1]++;
  }
  const firstHalfEdge = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) firstHalfEdge[i + 1] = firstHalfEdge[i] + degree[i + 1];
  const cursor = firstHalfEdge.slice(0, n);
  const adjacency = new Uint32Array(m * 2);
  tile.edges.forEach((e, i) => {
    adjacency[cursor[e.from]++] = i * 2;
    adjacency[cursor[e.to]++] = i * 2 + 1;
  });

  const interior = tile.edges.reduce((s, e) => s + e.points.length - 2, 0);
  const px = new Float32Array(interior);
  const py = new Float32Array(interior);
  const pz = new Float32Array(interior);
  const cum = new Float32Array(interior);
  const re = region.edges;
  const edges = {
    from: new Uint32Array(m),
    to: new Uint32Array(m),
    length: new Float32Array(m),
    polyOffset: new Uint32Array(m),
    polyCount: new Uint16Array(m),
    widthCm: new Uint16Array(m),
    type: new Uint8Array(m),
    permissions: new Uint8Array(m),
    levelDelta: new Int8Array(m),
    flags: new Uint8Array(m),
    osmIdLo: new Uint32Array(m),
    osmIdHi: new Uint32Array(m),
  };
  let p = 0;
  tile.edges.forEach((e, i) => {
    const s = e.source;
    edges.from[i] = e.from;
    edges.to[i] = e.to;
    edges.polyOffset[i] = p;
    edges.polyCount[i] = e.points.length - 2;
    edges.widthCm[i] = re.widthCm[s];
    edges.type[i] = re.type[s];
    edges.permissions[i] = re.permissions[s];
    edges.levelDelta[i] = re.levelDelta[s];
    edges.flags[i] = re.flags[s];
    edges.osmIdLo[i] = re.osmIdLo[s];
    edges.osmIdHi[i] = re.osmIdHi[s];
    let length = 0;
    for (let k = 1; k < e.points.length; k++) {
      length += Math.hypot(
        e.points[k][0] - e.points[k - 1][0],
        e.points[k][1] - e.points[k - 1][1],
      );
      if (k < e.points.length - 1) {
        px[p] = e.points[k][0] - ox;
        py[p] = e.points[k][1] - oy;
        pz[p] = e.points[k][2];
        cum[p] = length;
        p++;
      }
    }
    edges.length[i] = length;
  });

  const rb = region.buildings;
  const count = tile.buildings.length;
  const ringPoints = tile.buildings.reduce((s, b) => s + rb.ringCount[b], 0);
  const buildings = {
    ringOffset: new Uint32Array(count),
    ringCount: new Uint16Array(count),
    levels: new Int16Array(count),
    baseZ: new Float32Array(count),
    height: new Float32Array(count),
    type: new Uint8Array(count),
    flags: new Uint8Array(count),
    capacity: new Uint32Array(count),
    seed: new Uint32Array(count),
    osmIdLo: new Uint32Array(count),
    osmIdHi: new Uint32Array(count),
    ringX: new Float32Array(ringPoints),
    ringY: new Float32Array(ringPoints),
  };
  let r = 0;
  tile.buildings.forEach((b, i) => {
    buildings.ringOffset[i] = r;
    buildings.ringCount[i] = rb.ringCount[b];
    buildings.levels[i] = rb.levels[b];
    buildings.baseZ[i] = rb.baseZ[b];
    buildings.height[i] = rb.height[b];
    buildings.type[i] = rb.type[b];
    buildings.flags[i] = rb.flags[b];
    buildings.capacity[i] = rb.capacity[b];
    buildings.seed[i] = rb.seed[b];
    buildings.osmIdLo[i] = rb.osmIdLo[b];
    buildings.osmIdHi[i] = rb.osmIdHi[b];
    for (let k = 0; k < rb.ringCount[b]; k++) {
      buildings.ringX[r] = rb.ringX[rb.ringOffset[b] + k] - ox;
      buildings.ringY[r] = rb.ringY[rb.ringOffset[b] + k] - oy;
      r++;
    }
  });

  const portals: NavPortals = {
    localNode: Uint32Array.from(tile.portals, (q) => q.local),
    otherTileX: Int32Array.from(tile.portals, (q) => q.tx),
    otherTileY: Int32Array.from(tile.portals, (q) => q.ty),
    otherNode: Uint32Array.from(tile.portals, (q) => q.other),
  };
  return {
    tileX: tile.tx,
    tileY: tile.ty,
    tileSizeM: grid.sizeM,
    nodes: {
      x: Float32Array.from(tile.nodes, (q) => q.x - ox),
      y: Float32Array.from(tile.nodes, (q) => q.y - oy),
      z: Float32Array.from(tile.nodes, (q) => q.z),
      level: Int8Array.from(tile.nodes, (q) => q.level),
      type: Uint8Array.from(tile.nodes, (q) => q.type),
      flags: Uint16Array.from(tile.nodes, (q) => q.flags),
      firstHalfEdge,
      buildingId: Uint32Array.from(tile.nodes, (q) =>
        q.buildingId === NO_BUILDING ? NO_BUILDING : newBuildingId[q.buildingId],
      ),
    },
    edges,
    adjacency,
    portals,
    polylines: { x: px, y: py, z: pz, cumLength: cum },
    buildings,
  };
}
