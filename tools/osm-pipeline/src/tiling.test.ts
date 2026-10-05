import { EdgeType, NO_BUILDING, NodeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import { stitchTiles } from '@city/nav';
import { describe, expect, it } from 'vitest';
import { splitIntoTiles } from './tiling.ts';

/**
 * Region fixture on a 100 m grid: a diagonal edge through a tile corner, an edge with a bent
 * polyline crossing two boundaries, a node exactly on a boundary, and two buildings in different
 * tiles with an entrance each.
 */
function region(): NavTile {
  const nx = [10, 190, 50, 250, 100, 20, 180];
  const ny = [10, 190, 50, 30, 60, 150, 20];
  const edges: [number, number, [number, number][]][] = [
    [0, 1, []], // diagonal through (100, 100): a corner
    [2, 3, [[120, 80]]], // bends, crosses x = 100 and x = 200
    [4, 2, []], // node 4 sits on x = 100
    [2, 5, []],
    [3, 6, []],
  ];
  const n = nx.length;
  const m = edges.length;
  const degree = new Uint32Array(n + 1);
  for (const [a, b] of edges) {
    degree[a + 1]++;
    degree[b + 1]++;
  }
  const first = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) first[i + 1] = first[i] + degree[i + 1];
  const cursor = first.slice(0, n);
  const adjacency = new Uint32Array(m * 2);
  edges.forEach(([a, b], e) => {
    adjacency[cursor[a]++] = e * 2;
    adjacency[cursor[b]++] = e * 2 + 1;
  });
  const poly = edges.flatMap(([, , points]) => points);
  let offset = 0;
  const lengthOf = ([a, b, points]: (typeof edges)[number]) => {
    const all: [number, number][] = [[nx[a], ny[a]], ...points, [nx[b], ny[b]]];
    let l = 0;
    for (let k = 1; k < all.length; k++)
      l += Math.hypot(all[k][0] - all[k - 1][0], all[k][1] - all[k - 1][1]);
    return l;
  };
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 512,
    nodes: {
      x: Float32Array.from(nx),
      y: Float32Array.from(ny),
      z: new Float32Array(n),
      level: new Int8Array(n),
      type: Uint8Array.from([0, 0, 0, 0, 0, NodeType.Entrance, NodeType.Entrance]),
      flags: new Uint16Array(n),
      firstHalfEdge: first,
      buildingId: Uint32Array.from([
        NO_BUILDING,
        NO_BUILDING,
        NO_BUILDING,
        NO_BUILDING,
        NO_BUILDING,
        1,
        0,
      ]),
    },
    edges: {
      from: Uint32Array.from(edges, (e) => e[0]),
      to: Uint32Array.from(edges, (e) => e[1]),
      length: Float32Array.from(edges, lengthOf),
      polyOffset: Uint32Array.from(edges, (e) => {
        const o = offset;
        offset += e[2].length;
        return o;
      }),
      polyCount: Uint16Array.from(edges, (e) => e[2].length),
      widthCm: new Uint16Array(m).fill(200),
      type: new Uint8Array(m).fill(EdgeType.Pavement),
      permissions: new Uint8Array(m).fill(7),
      levelDelta: new Int8Array(m),
      flags: new Uint8Array(m),
      osmIdLo: Uint32Array.from(edges, (_, e) => 100 + e),
      osmIdHi: new Uint32Array(m),
    },
    adjacency,
    portals: noPortals(),
    polylines: {
      x: Float32Array.from(poly, (p) => p[0]),
      y: Float32Array.from(poly, (p) => p[1]),
      z: new Float32Array(poly.length),
      cumLength: new Float32Array(poly.length),
    },
    buildings: {
      // Building 0 near (180, 20) → tile (1, 0); building 1 near (20, 150) → tile (0, 1).
      ringOffset: Uint32Array.from([0, 4]),
      ringCount: Uint16Array.from([4, 4]),
      levels: Int16Array.from([3, 5]),
      baseZ: new Float32Array(2),
      height: Float32Array.from([10, 17]),
      type: new Uint8Array(2),
      flags: new Uint8Array(2),
      capacity: Uint32Array.from([30, 50]),
      seed: new Uint32Array(2),
      osmIdLo: Uint32Array.from([7, 8]),
      osmIdHi: new Uint32Array(2),
      ringX: Float32Array.from([170, 190, 190, 170, 10, 30, 30, 10]),
      ringY: Float32Array.from([10, 10, 30, 30, 140, 140, 160, 160]),
    },
  };
}

const grid = { originX: 0, originY: 0, sizeM: 100 };

describe('splitIntoTiles', () => {
  const source = region();
  const tiled = splitIntoTiles(source, grid);

  it('keeps every edge piece inside its tile, in tile-local coordinates', () => {
    for (const tile of tiled.tiles) {
      for (const [xs, ys] of [
        [tile.nodes.x, tile.nodes.y],
        [tile.polylines.x, tile.polylines.y],
      ]) {
        for (let i = 0; i < xs.length; i++) {
          expect(xs[i]).toBeGreaterThanOrEqual(-1e-3);
          expect(xs[i]).toBeLessThanOrEqual(100 + 1e-3);
          expect(ys[i]).toBeGreaterThanOrEqual(-1e-3);
          expect(ys[i]).toBeLessThanOrEqual(100 + 1e-3);
        }
      }
    }
    expect(tiled.qa.splitEdges).toBeGreaterThanOrEqual(2);
  });

  it('links every portal both ways', () => {
    const byKey = new Map(tiled.tiles.map((t) => [`${t.tileX},${t.tileY}`, t]));
    for (const tile of tiled.tiles) {
      const p = tile.portals;
      for (let k = 0; k < p.localNode.length; k++) {
        const other = byKey.get(`${p.otherTileX[k]},${p.otherTileY[k]}`);
        expect(other).toBeDefined();
        if (other === undefined) continue;
        let back = false;
        for (let j = 0; j < other.portals.localNode.length; j++) {
          if (
            other.portals.localNode[j] === p.otherNode[k] &&
            other.portals.otherNode[j] === p.localNode[k] &&
            other.portals.otherTileX[j] === tile.tileX &&
            other.portals.otherTileY[j] === tile.tileY
          )
            back = true;
        }
        expect(back).toBe(true);
        // Twins sit at the same region position.
        const ax = tile.nodes.x[p.localNode[k]] + tile.tileX * 100;
        const bx = other.nodes.x[p.otherNode[k]] + other.tileX * 100;
        expect(ax).toBeCloseTo(bx, 3);
      }
    }
  });

  it('stitches back to the same graph: lengths per way, entrances and buildings', () => {
    const joined = stitchTiles({
      tiles: tiled.tiles,
      buildingOffset: tiled.buildingOffset,
      gridOrigin: { x: 0, y: 0 },
      tileSizeM: 100,
    });
    const perWay = (t: NavTile) => {
      const map = new Map<number, number>();
      for (let e = 0; e < t.edges.from.length; e++)
        map.set(t.edges.osmIdLo[e], (map.get(t.edges.osmIdLo[e]) ?? 0) + t.edges.length[e]);
      return map;
    };
    const before = perWay(source);
    const after = perWay(joined);
    for (const [way, length] of before) expect(after.get(way)).toBeCloseTo(length, 3);

    // The same connected components as before (the diagonal stands alone in both).
    const componentCount = (t: NavTile) => {
      const count = t.nodes.x.length;
      const parent = Int32Array.from({ length: count }, (_, i) => i);
      const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
      for (let e = 0; e < t.edges.from.length; e++)
        parent[find(t.edges.from[e])] = find(t.edges.to[e]);
      return new Set(Array.from({ length: count }, (_, i) => find(i))).size;
    };
    expect(componentCount(joined)).toBe(componentCount(source));
    const n = joined.nodes.x.length;

    // Entrances survive with their buildings (ids renumbered tile by tile, rows moved with them).
    const entrances: [number, number][] = [];
    for (let i = 0; i < n; i++)
      if (joined.nodes.type[i] === NodeType.Entrance)
        entrances.push([joined.nodes.x[i], joined.buildings.osmIdLo[joined.nodes.buildingId[i]]]);
    entrances.sort((a, b) => a[0] - b[0]);
    expect(entrances).toEqual([
      [20, 8],
      [180, 7],
    ]);
    // Positions return to the region frame.
    const xs = Array.from(joined.nodes.x).sort((a, b) => a - b);
    for (const x of source.nodes.x) expect(xs.some((v) => Math.abs(v - x) < 1e-3)).toBe(true);
  });
});
