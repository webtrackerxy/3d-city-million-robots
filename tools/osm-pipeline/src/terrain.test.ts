import { EdgeFlag, EdgeType, NO_BUILDING } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';
import { stitchTiles } from '@city/nav';
import { describe, expect, it } from 'vitest';
import { applyTerrain, type Raster, readGeoTiff, sampleRaster, type Terrain } from './terrain.ts';
import { splitIntoTiles } from './tiling.ts';

/** A little-endian, stripped, float32 GeoTIFF with ModelPixelScale + ModelTiepoint. */
function geoTiff(width: number, height: number, values: number[], west: number, north: number) {
  const entries: [tag: number, type: number, values: number[]][] = [
    [256, 3, [width]],
    [257, 3, [height]],
    [258, 3, [32]],
    [259, 3, [1]],
    [273, 4, [0]], // strip offset, patched below
    [278, 3, [height]],
    [279, 4, [width * height * 4]],
    [339, 3, [3]],
    [33550, 12, [2, 2, 0]],
    [33922, 12, [0, 0, 0, west, north, 0]],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const extra = entries.reduce((s, [, type, v]) => s + (type === 12 ? v.length * 8 : 0), 0);
  const dataAt = 8 + ifdSize + extra;
  const buffer = new ArrayBuffer(dataAt + width * height * 4);
  const view = new DataView(buffer);
  view.setUint16(0, 0x4949);
  view.setUint16(2, 42, true);
  view.setUint32(4, 8, true);
  view.setUint16(8, entries.length, true);
  let extraAt = 8 + ifdSize;
  entries.forEach(([tag, type, v], i) => {
    const e = 10 + i * 12;
    view.setUint16(e, tag, true);
    view.setUint16(e + 2, type, true);
    view.setUint32(e + 4, v.length, true);
    if (tag === 273) view.setUint32(e + 8, dataAt, true);
    else if (type === 3) view.setUint16(e + 8, v[0] ?? 0, true);
    else if (type === 4) view.setUint32(e + 8, v[0] ?? 0, true);
    else {
      view.setUint32(e + 8, extraAt, true);
      for (const x of v) {
        view.setFloat64(extraAt, x, true);
        extraAt += 8;
      }
    }
  });
  values.forEach((x, i) => {
    view.setFloat32(dataAt + i * 4, x, true);
  });
  return buffer;
}

describe('readGeoTiff and sampleRaster', () => {
  it('reads a stripped float32 GeoTIFF and its georeference', () => {
    const r = readGeoTiff(geoTiff(3, 2, [1, 2, 3, 4, 5, 6], 1000, 2000));
    expect([r.width, r.height, r.west, r.north, r.pixelM]).toEqual([3, 2, 1000, 2000, 2]);
    expect(Array.from(r.data)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('interpolates bilinearly between pixel centres and skips no-data', () => {
    const r: Raster = {
      width: 2,
      height: 2,
      west: 0,
      north: 2,
      pixelM: 1,
      data: Float32Array.from([0, 10, 20, 30]),
      nodata: -9999,
    };
    // Pixel centres at (0.5, 1.5)=0, (1.5, 1.5)=10, (0.5, 0.5)=20, (1.5, 0.5)=30.
    expect(sampleRaster(r, 1, 1)).toBeCloseTo(15);
    expect(sampleRaster(r, 0.5, 1.5)).toBeCloseTo(0);
    r.data[3] = -9999;
    // Off the no-data pixel's centre: the three valid corners, renormalised (weights 1:3:3).
    expect(sampleRaster(r, 1.25, 0.75)).toBeCloseTo((0 * 1 + 10 * 3 + 20 * 3) / 7);
    // At its centre every other corner has zero weight: no height.
    expect(sampleRaster(r, 1.5, 0.5)).toBeNull();
    expect(sampleRaster(r, 50, 50)).toBeNull();
  });
});

/**
 * Nodes along x: A(0) — B(60) ground, B — M(100) — C(140) a bridge over a river (terrain 0
 * between x = 80 and 120), C — D(200) ground. The terrain elsewhere is 10 + x / 100.
 */
function riverRegion(): { tile: NavTile; terrain: Terrain } {
  const xs = [0, 60, 100, 140, 200];
  const edges: [number, number, number[], boolean][] = [
    [0, 1, [30], false],
    [1, 2, [80], true],
    [2, 3, [120], true],
    [3, 4, [170], false],
  ];
  const n = xs.length;
  const m = edges.length;
  const poly = edges.flatMap(([, , p]) => p);
  let offset = 0;
  const tile: NavTile = {
    tileX: 0,
    tileY: 0,
    tileSizeM: 512,
    nodes: {
      x: Float32Array.from(xs),
      y: new Float32Array(n),
      z: new Float32Array(n),
      level: new Int8Array(n),
      type: new Uint8Array(n),
      flags: new Uint16Array(n),
      firstHalfEdge: new Uint32Array(n + 1),
      buildingId: new Uint32Array(n).fill(NO_BUILDING),
    },
    edges: {
      from: Uint32Array.from(edges, (e) => e[0]),
      to: Uint32Array.from(edges, (e) => e[1]),
      length: Float32Array.from(edges, ([a, b]) => Math.abs((xs[b] ?? 0) - (xs[a] ?? 0))),
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
      flags: Uint8Array.from(edges, (e) => (e[3] ? EdgeFlag.Bridge : 0)),
      osmIdLo: new Uint32Array(m),
      osmIdHi: new Uint32Array(m),
    },
    adjacency: new Uint32Array(m * 2),
    portals: noPortals(),
    polylines: {
      x: Float32Array.from(poly),
      y: new Float32Array(poly.length),
      z: new Float32Array(poly.length),
      cumLength: Float32Array.from(edges.flatMap(([a, , p]) => p.map((x) => x - (xs[a] ?? 0)))),
    },
    buildings: {
      ringOffset: Uint32Array.from([0]),
      ringCount: Uint16Array.from([4]),
      levels: Int16Array.from([3]),
      baseZ: Float32Array.from([0]),
      height: Float32Array.from([12]),
      type: new Uint8Array(1),
      flags: new Uint8Array(1),
      capacity: new Uint32Array(1),
      seed: new Uint32Array(1),
      osmIdLo: new Uint32Array(1),
      osmIdHi: new Uint32Array(1),
      ringX: Float32Array.from([0, 20, 20, 0]),
      ringY: Float32Array.from([10, 10, 30, 30]),
    },
  };
  const terrain: Terrain = {
    sample: (e) => (e > 1080 && e < 1120 ? 0 : 10 + (e - 1000) / 100),
  };
  return { tile, terrain };
}

describe('applyTerrain', () => {
  it('puts ground nodes, points and buildings on the terrain, relative to the origin', () => {
    const { tile, terrain } = riverRegion();
    const qa = applyTerrain(tile, terrain, { easting: 1000, northing: 5000 }, 10);
    expect(tile.nodes.z[0]).toBeCloseTo(0); // the origin's ground is the zero
    expect(tile.nodes.z[1]).toBeCloseTo(0.6);
    expect(tile.nodes.z[4]).toBeCloseTo(2);
    expect(tile.polylines.z[0]).toBeCloseTo(0.3); // ground point at x = 30
    // The building stands on the lowest ground under it (x = 0: 10 m ODN → 0).
    expect(tile.buildings.baseZ[0]).toBeCloseTo(0);
    expect(tile.buildings.height[0]).toBeCloseTo(12);
    expect(qa.nodesWithoutData).toBe(0);
  });

  it('keeps bridges level with their ends instead of dipping to the river', () => {
    const { tile, terrain } = riverRegion();
    const qa = applyTerrain(tile, terrain, { easting: 1000, northing: 5000 }, 10);
    // M (x = 100) is on bridges only: its neighbours' mean, not the river's 0 − 10.
    expect(tile.nodes.z[2]).toBeCloseTo((0.6 + 1.4) / 2);
    expect(qa.nodesFilledFromNeighbours).toBe(1);
    // Bridge points run straight between the ends (x = 80 is half-way from B to M).
    expect(tile.polylines.z[1]).toBeCloseTo((0.6 + 1.0) / 2);
    expect(tile.polylines.z[2]).toBeCloseTo((1.0 + 1.4) / 2);
  });
});

describe('splitIntoTiles with heights', () => {
  it('carries node and point heights through tiling, cuts interpolated, and stitching', () => {
    const { tile, terrain } = riverRegion();
    applyTerrain(tile, terrain, { easting: 1000, northing: 5000 }, 10);
    const tiled = splitIntoTiles(tile, { originX: 0, originY: -50, sizeM: 50 });
    const stitched = stitchTiles({
      tiles: tiled.tiles,
      buildingOffset: tiled.buildingOffset,
      gridOrigin: { x: 0, y: -50 },
      tileSizeM: 50,
    });
    const heightAt = (x: number) => {
      for (let i = 0; i < stitched.nodes.x.length; i++)
        if (Math.abs(stitched.nodes.x[i] - x) < 1e-3) return stitched.nodes.z[i];
      return undefined;
    };
    expect(heightAt(200)).toBeCloseTo(2);
    expect(heightAt(100)).toBeCloseTo(1);
    // The cut at x = 50 (a tile boundary, on the A–B ground edge) lies between its neighbours.
    const cut = heightAt(50);
    expect(cut).toBeGreaterThan(0.3);
    expect(cut).toBeLessThan(0.6);
  });
});
