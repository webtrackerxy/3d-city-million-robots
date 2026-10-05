import { EdgeType, NO_BUILDING } from '@city/core-types';
import {
  type NavTile,
  noPortals,
  readTileContainer,
  writeNavTile,
  writeTileContainer,
} from '@city/formats';
import { describe, expect, it } from 'vitest';
import { buildingsOnly, withoutOutlines } from './slim.ts';

/** Two nodes, one edge, two buildings (a square and a triangle). */
function tile(): NavTile {
  return {
    tileX: 3,
    tileY: 4,
    tileSizeM: 256,
    nodes: {
      x: Float32Array.from([0, 50]),
      y: new Float32Array(2),
      z: new Float32Array(2),
      level: new Int8Array(2),
      type: new Uint8Array(2),
      flags: new Uint16Array(2),
      firstHalfEdge: Uint32Array.from([0, 1, 2]),
      buildingId: new Uint32Array(2).fill(NO_BUILDING),
    },
    edges: {
      from: Uint32Array.from([0]),
      to: Uint32Array.from([1]),
      length: Float32Array.from([50]),
      polyOffset: new Uint32Array(1),
      polyCount: new Uint16Array(1),
      widthCm: Uint16Array.from([200]),
      type: Uint8Array.from([EdgeType.Pavement]),
      permissions: Uint8Array.from([7]),
      levelDelta: new Int8Array(1),
      flags: new Uint8Array(1),
      osmIdLo: Uint32Array.from([42]),
      osmIdHi: new Uint32Array(1),
    },
    portals: noPortals(),
    adjacency: Uint32Array.from([0, 1]),
    polylines: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      cumLength: new Float32Array(0),
    },
    buildings: {
      ringOffset: Uint32Array.from([0, 4]),
      ringCount: Uint16Array.from([4, 3]),
      levels: Int16Array.from([3, 10]),
      baseZ: new Float32Array(2),
      height: Float32Array.from([12, 40]),
      type: new Uint8Array(2),
      flags: new Uint8Array(2),
      capacity: Uint32Array.from([30, 400]),
      seed: Uint32Array.from([1, 2]),
      osmIdLo: Uint32Array.from([7, 8]),
      osmIdHi: new Uint32Array(2),
      ringX: Float32Array.from([0, 20, 20, 0, 30, 40, 35]),
      ringY: Float32Array.from([10, 10, 30, 30, 0, 0, 9]),
    },
  };
}

const roundTrip = (t: NavTile) => readTileContainer(writeTileContainer(writeNavTile(t)));

describe('slim region files', () => {
  it('buildingsOnly keeps every building and drops the walking graph', () => {
    const read = roundTrip(buildingsOnly(tile()));
    expect(read.nodes.x.length).toBe(0);
    expect(read.edges.from.length).toBe(0);
    expect(read.adjacency.length).toBe(0);
    expect([read.tileX, read.tileY]).toEqual([3, 4]);
    expect(read.buildings).toEqual(tile().buildings);
  });

  it('withoutOutlines keeps the graph and each building, but no rings', () => {
    const read = roundTrip(withoutOutlines(tile()));
    expect(read.edges).toEqual(tile().edges);
    expect(read.nodes).toEqual(tile().nodes);
    expect(Array.from(read.buildings.capacity)).toEqual([30, 400]);
    expect(Array.from(read.buildings.height)).toEqual([12, 40]);
    expect(Array.from(read.buildings.ringCount)).toEqual([0, 0]);
    expect(read.buildings.ringOffset.length).toBe(2);
    expect(read.buildings.ringX.length).toBe(0);
  });
});
