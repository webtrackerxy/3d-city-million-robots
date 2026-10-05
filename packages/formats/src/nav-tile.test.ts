import { describe, expect, it } from 'vitest';
import {
  type NavTile,
  readNavTile,
  readTileContainer,
  writeNavTile,
  writeTileContainer,
} from './nav-tile.ts';

function sampleTile(): NavTile {
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 2048,
    nodes: {
      x: new Float32Array([0, 10, 10]),
      y: new Float32Array([0, 0, 5]),
      z: new Float32Array(3),
      level: new Int8Array([0, 0, -1]),
      type: new Uint8Array([1, 0, 1]),
      flags: new Uint16Array(3),
      firstHalfEdge: new Uint32Array([0, 1, 3, 4]),
      buildingId: new Uint32Array([0xffffffff, 0, 0xffffffff]),
    },
    edges: {
      from: new Uint32Array([0, 1]),
      to: new Uint32Array([1, 2]),
      length: new Float32Array([10, 5.5]),
      polyOffset: new Uint32Array([0, 1]),
      polyCount: new Uint16Array([1, 0]),
      widthCm: new Uint16Array([200, 150]),
      type: new Uint8Array([0, 2]),
      permissions: new Uint8Array([7, 1]),
      levelDelta: new Int8Array([0, -1]),
      flags: new Uint8Array([16, 0]),
      osmIdLo: new Uint32Array([4287457, 1]),
      osmIdHi: new Uint32Array([0, 0]),
    },
    portals: {
      localNode: new Uint32Array([2]),
      otherTileX: new Int32Array([-1]),
      otherTileY: new Int32Array([3]),
      otherNode: new Uint32Array([17]),
    },
    adjacency: new Uint32Array([0, 1, 2, 3]),
    polylines: {
      x: new Float32Array([5]),
      y: new Float32Array([0.1]),
      z: new Float32Array([0]),
      cumLength: new Float32Array([5]),
    },
    buildings: {
      ringOffset: new Uint32Array([0]),
      ringCount: new Uint16Array([4]),
      levels: new Int16Array([12]),
      baseZ: new Float32Array([0]),
      height: new Float32Array([46.8]),
      type: new Uint8Array([2]),
      flags: new Uint8Array([8]),
      capacity: new Uint32Array([1200]),
      seed: new Uint32Array([0xdeadbeef]),
      osmIdLo: new Uint32Array([123]),
      osmIdHi: new Uint32Array([1]),
      ringX: new Float32Array([0, 20, 20, 0]),
      ringY: new Float32Array([0, 0, 10, 10]),
    },
  };
}

describe('nav tiles', () => {
  it('round-trip every field through the binary files', () => {
    const tile = sampleTile();
    const read = readNavTile(writeNavTile(tile));
    expect(read.tileSizeM).toBe(2048);
    const plain = (t: NavTile) =>
      JSON.parse(
        JSON.stringify(t, (_, v: unknown) =>
          ArrayBuffer.isView(v) ? Array.from(v as Float32Array) : v,
        ),
      ) as unknown;
    expect(plain(read)).toEqual(plain(tile));
  });

  it('round-trips through a single-file tile container, zero-copy', () => {
    const tile = sampleTile();
    const container = writeTileContainer(writeNavTile(tile));
    const read = readTileContainer(container);
    expect(read).toEqual(tile);
    expect(read.nodes.x.buffer).toBe(container);
    expect(read.portals.otherTileY.buffer).toBe(container);
    expect(() => readTileContainer(new ArrayBuffer(64))).toThrow(/container/);
  });

  it('reads zero-copy views over the file buffers', () => {
    const files = writeNavTile(sampleTile());
    const read = readNavTile(files);
    expect(read.nodes.x.buffer).toBe(files.nodes);
    expect(read.buildings.ringX.buffer).toBe(files.buildingRings);
  });

  it('rejects a file of the wrong kind in a slot', () => {
    const files = writeNavTile(sampleTile());
    expect(() => readNavTile({ ...files, nodes: files.edges })).toThrow(/kind/);
  });
});
