import { type NavTile, noPortals } from '@city/formats';

/**
 * A large region keeps each thing once: the walking graph in `region.nav` (the simulation and
 * routing load it whole) and the building outlines in the tiles (streamed around the view for
 * drawing). These two strip the other copy.
 */

/** The tile's buildings only: an empty walking graph (the app reads the graph from region.nav). */
export function buildingsOnly(tile: NavTile): NavTile {
  return {
    tileX: tile.tileX,
    tileY: tile.tileY,
    tileSizeM: tile.tileSizeM,
    nodes: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      level: new Int8Array(0),
      type: new Uint8Array(0),
      flags: new Uint16Array(0),
      firstHalfEdge: new Uint32Array(1),
      buildingId: new Uint32Array(0),
    },
    edges: {
      from: new Uint32Array(0),
      to: new Uint32Array(0),
      length: new Float32Array(0),
      polyOffset: new Uint32Array(0),
      polyCount: new Uint16Array(0),
      widthCm: new Uint16Array(0),
      type: new Uint8Array(0),
      permissions: new Uint8Array(0),
      levelDelta: new Int8Array(0),
      flags: new Uint8Array(0),
      osmIdLo: new Uint32Array(0),
      osmIdHi: new Uint32Array(0),
    },
    portals: noPortals(),
    adjacency: new Uint32Array(0),
    polylines: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      cumLength: new Float32Array(0),
    },
    buildings: tile.buildings,
  };
}

/**
 * The graph without building outlines: every building keeps its id, height, type, capacity and
 * OSM id, but no ring (the tiles hold them; the app fills in the ones its roof walks need).
 */
export function withoutOutlines(graph: NavTile): NavTile {
  const count = graph.buildings.ringOffset.length;
  return {
    ...graph,
    buildings: {
      ...graph.buildings,
      ringOffset: new Uint32Array(count),
      ringCount: new Uint16Array(count),
      ringX: new Float32Array(0),
      ringY: new Float32Array(0),
    },
  };
}
