import {
  type ColumnArray,
  FORMAT_VERSION,
  FormatError,
  readColumnFile,
  writeColumnFile,
} from './column-file.ts';

/**
 * Navigation tile v1 (implementation plan Appendix A): one file per kind. Coordinates are
 * tile-local metres — x east, y north, z up — relative to the region origin in the manifest.
 */
export const FileKind = {
  Nodes: 1,
  Edges: 2,
  Adjacency: 3,
  Polylines: 4,
  Buildings: 5,
  BuildingRings: 6,
  Portals: 7,
} as const;
export type FileKind = (typeof FileKind)[keyof typeof FileKind];

const Col = {
  // nodes
  X: 1,
  Y: 2,
  Z: 3,
  Level: 4,
  NodeType: 5,
  NodeFlags: 6,
  FirstHalfEdge: 7,
  BuildingId: 8,
  // edges
  From: 20,
  To: 21,
  Length: 22,
  PolyOffset: 23,
  PolyCount: 24,
  WidthCm: 25,
  EdgeType: 26,
  Permissions: 27,
  LevelDelta: 28,
  EdgeFlags: 29,
  OsmIdLo: 30,
  OsmIdHi: 31,
  // adjacency
  HalfEdge: 40,
  // polylines
  PX: 50,
  PY: 51,
  PZ: 52,
  CumLength: 53,
  // buildings
  RingOffset: 60,
  RingCount: 61,
  Levels: 62,
  BaseZ: 63,
  Height: 64,
  BuildingType: 65,
  BuildingFlags: 66,
  Capacity: 67,
  Seed: 68,
  BOsmIdLo: 69,
  BOsmIdHi: 70,
  // building rings
  RX: 80,
  RY: 81,
  // portals
  PortalNode: 90,
  PortalTileX: 91,
  PortalTileY: 92,
  PortalOtherNode: 93,
} as const;

export interface NavNodes {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  level: Int8Array;
  type: Uint8Array;
  flags: Uint16Array;
  /** CSR offsets into `adjacency`, count + 1 entries. */
  firstHalfEdge: Uint32Array;
  /** Building index for entrance nodes, NO_BUILDING (0xffffffff) otherwise. */
  buildingId: Uint32Array;
}

export interface NavEdges {
  from: Uint32Array;
  to: Uint32Array;
  length: Float32Array;
  /** First interior polyline point; interior points exclude the two end nodes. */
  polyOffset: Uint32Array;
  polyCount: Uint16Array;
  widthCm: Uint16Array;
  type: Uint8Array;
  permissions: Uint8Array;
  levelDelta: Int8Array;
  flags: Uint8Array;
  osmIdLo: Uint32Array;
  osmIdHi: Uint32Array;
}

export interface NavPolylines {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  /** Distance from the edge's from-node to this point. */
  cumLength: Float32Array;
}

export interface NavBuildings {
  ringOffset: Uint32Array;
  ringCount: Uint16Array;
  levels: Int16Array;
  baseZ: Float32Array;
  height: Float32Array;
  type: Uint8Array;
  flags: Uint8Array;
  capacity: Uint32Array;
  seed: Uint32Array;
  osmIdLo: Uint32Array;
  osmIdHi: Uint32Array;
  /** Outer ring points (x, y), counter-clockwise. */
  ringX: Float32Array;
  ringY: Float32Array;
}

export interface NavTile {
  tileX: number;
  tileY: number;
  tileSizeM: number;
  nodes: NavNodes;
  edges: NavEdges;
  /** Links from boundary nodes of this tile to their twins in neighbouring tiles. */
  portals: NavPortals;
  /** Half-edges (edge · 2 + direction) leaving each node, indexed by nodes.firstHalfEdge. */
  adjacency: Uint32Array;
  polylines: NavPolylines;
  buildings: NavBuildings;
}

/**
 * Cross-tile links (Appendix A `portals.bin`): an edge crossing a tile boundary is split there, and
 * the two boundary nodes — one per tile, same position — are joined by a portal in each tile.
 */
export interface NavPortals {
  localNode: Uint32Array;
  otherTileX: Int32Array;
  otherTileY: Int32Array;
  otherNode: Uint32Array;
}

/** A tile with no neighbours (single-tile regions, tests). */
export function noPortals(): NavPortals {
  return {
    localNode: new Uint32Array(0),
    otherTileX: new Int32Array(0),
    otherTileY: new Int32Array(0),
    otherNode: new Uint32Array(0),
  };
}

export type NavTileFiles = Record<
  'nodes' | 'edges' | 'adjacency' | 'polylines' | 'buildings' | 'buildingRings' | 'portals',
  ArrayBuffer
>;

export function writeNavTile(tile: NavTile): NavTileFiles {
  const base = { tileX: tile.tileX, tileY: tile.tileY, tileSizeM: tile.tileSizeM };
  const file = (kind: FileKind, count: number, columns: [number, ColumnArray][]) =>
    writeColumnFile(
      { ...base, kind, count },
      columns.map(([id, data]) => ({ id, data })),
    );
  const { nodes, edges, polylines, buildings, portals } = tile;
  return {
    nodes: file(FileKind.Nodes, nodes.x.length, [
      [Col.X, nodes.x],
      [Col.Y, nodes.y],
      [Col.Z, nodes.z],
      [Col.Level, nodes.level],
      [Col.NodeType, nodes.type],
      [Col.NodeFlags, nodes.flags],
      [Col.FirstHalfEdge, nodes.firstHalfEdge],
      [Col.BuildingId, nodes.buildingId],
    ]),
    edges: file(FileKind.Edges, edges.from.length, [
      [Col.From, edges.from],
      [Col.To, edges.to],
      [Col.Length, edges.length],
      [Col.PolyOffset, edges.polyOffset],
      [Col.PolyCount, edges.polyCount],
      [Col.WidthCm, edges.widthCm],
      [Col.EdgeType, edges.type],
      [Col.Permissions, edges.permissions],
      [Col.LevelDelta, edges.levelDelta],
      [Col.EdgeFlags, edges.flags],
      [Col.OsmIdLo, edges.osmIdLo],
      [Col.OsmIdHi, edges.osmIdHi],
    ]),
    adjacency: file(FileKind.Adjacency, tile.adjacency.length, [[Col.HalfEdge, tile.adjacency]]),
    polylines: file(FileKind.Polylines, polylines.x.length, [
      [Col.PX, polylines.x],
      [Col.PY, polylines.y],
      [Col.PZ, polylines.z],
      [Col.CumLength, polylines.cumLength],
    ]),
    buildings: file(FileKind.Buildings, buildings.ringOffset.length, [
      [Col.RingOffset, buildings.ringOffset],
      [Col.RingCount, buildings.ringCount],
      [Col.Levels, buildings.levels],
      [Col.BaseZ, buildings.baseZ],
      [Col.Height, buildings.height],
      [Col.BuildingType, buildings.type],
      [Col.BuildingFlags, buildings.flags],
      [Col.Capacity, buildings.capacity],
      [Col.Seed, buildings.seed],
      [Col.BOsmIdLo, buildings.osmIdLo],
      [Col.BOsmIdHi, buildings.osmIdHi],
    ]),
    buildingRings: file(FileKind.BuildingRings, buildings.ringX.length, [
      [Col.RX, buildings.ringX],
      [Col.RY, buildings.ringY],
    ]),
    portals: file(FileKind.Portals, portals.localNode.length, [
      [Col.PortalNode, portals.localNode],
      [Col.PortalTileX, portals.otherTileX],
      [Col.PortalTileY, portals.otherTileY],
      [Col.PortalOtherNode, portals.otherNode],
    ]),
  };
}

/** Zero-copy: every array is a view over the corresponding file buffer. */
export function readNavTile(files: NavTileFiles): NavTile {
  const section = (buffer: ArrayBuffer) => ({
    buffer,
    byteOffset: 0,
    byteLength: buffer.byteLength,
  });
  return readNavTileSections({
    nodes: section(files.nodes),
    edges: section(files.edges),
    adjacency: section(files.adjacency),
    polylines: section(files.polylines),
    buildings: section(files.buildings),
    buildingRings: section(files.buildingRings),
    portals: section(files.portals),
  });
}

/** A file's bytes inside a larger buffer (a tile container). */
export interface Section {
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}

const CONTAINER_MAGIC = 0x43564e43; // 'CNVC'
const KIND_ORDER: readonly (keyof NavTileFiles)[] = [
  'nodes',
  'edges',
  'adjacency',
  'polylines',
  'buildings',
  'buildingRings',
  'portals',
];

/**
 * One tile as one file (Appendix A `tile_x_y.nav`): a 16-byte header (magic 'CNVC', version,
 * section count) and a table of (offset u32, length u32) per kind in a fixed order, then the
 * kinds' column files, each 8-byte aligned. One request per tile instead of seven.
 */
export function writeTileContainer(files: NavTileFiles): ArrayBuffer {
  const tableBytes = 16 + KIND_ORDER.length * 8;
  let offset = align8(tableBytes);
  const placed = KIND_ORDER.map((kind) => {
    const at = offset;
    offset = align8(offset + files[kind].byteLength);
    return at;
  });
  const out = new ArrayBuffer(offset);
  const dv = new DataView(out);
  dv.setUint32(0, CONTAINER_MAGIC, true);
  dv.setUint16(4, FORMAT_VERSION, true);
  dv.setUint16(6, KIND_ORDER.length, true);
  KIND_ORDER.forEach((kind, i) => {
    dv.setUint32(16 + i * 8, placed[i], true);
    dv.setUint32(20 + i * 8, files[kind].byteLength, true);
    new Uint8Array(out, placed[i], files[kind].byteLength).set(new Uint8Array(files[kind]));
  });
  return out;
}

/** Zero-copy read of a tile container. */
export function readTileContainer(buffer: ArrayBuffer): NavTile {
  const dv = new DataView(buffer);
  if (buffer.byteLength < 16 || dv.getUint32(0, true) !== CONTAINER_MAGIC)
    throw new FormatError('Not a tile container (bad magic)');
  if (dv.getUint16(4, true) > FORMAT_VERSION) throw new FormatError('Container version too new');
  const sections = {} as Record<keyof NavTileFiles, Section>;
  KIND_ORDER.forEach((kind, i) => {
    sections[kind] = {
      buffer,
      byteOffset: dv.getUint32(16 + i * 8, true),
      byteLength: dv.getUint32(20 + i * 8, true),
    };
  });
  return readNavTileSections(sections);
}

function align8(n: number): number {
  return Math.ceil(n / 8) * 8;
}

function readNavTileSections(files: Record<keyof NavTileFiles, Section>): NavTile {
  const read = (s: Section, kind: number) =>
    readColumnFile(s.buffer, kind, s.byteOffset, s.byteLength);
  const nodes = read(files.nodes, FileKind.Nodes);
  const edges = read(files.edges, FileKind.Edges);
  const adjacency = read(files.adjacency, FileKind.Adjacency);
  const polylines = read(files.polylines, FileKind.Polylines);
  const buildings = read(files.buildings, FileKind.Buildings);
  const rings = read(files.buildingRings, FileKind.BuildingRings);
  const portals = read(files.portals, FileKind.Portals);
  const get = <T extends ColumnArray>(
    file: typeof nodes,
    id: number,
    type: new (...args: never[]) => T,
  ): T => {
    const column = file.columns.get(id);
    if (!(column instanceof type))
      throw new FormatError(`Missing or mistyped column ${id} in kind ${file.header.kind}`);
    return column;
  };
  return {
    tileX: nodes.header.tileX,
    tileY: nodes.header.tileY,
    tileSizeM: nodes.header.tileSizeM,
    nodes: {
      x: get(nodes, Col.X, Float32Array),
      y: get(nodes, Col.Y, Float32Array),
      z: get(nodes, Col.Z, Float32Array),
      level: get(nodes, Col.Level, Int8Array),
      type: get(nodes, Col.NodeType, Uint8Array),
      flags: get(nodes, Col.NodeFlags, Uint16Array),
      firstHalfEdge: get(nodes, Col.FirstHalfEdge, Uint32Array),
      buildingId: get(nodes, Col.BuildingId, Uint32Array),
    },
    edges: {
      from: get(edges, Col.From, Uint32Array),
      to: get(edges, Col.To, Uint32Array),
      length: get(edges, Col.Length, Float32Array),
      polyOffset: get(edges, Col.PolyOffset, Uint32Array),
      polyCount: get(edges, Col.PolyCount, Uint16Array),
      widthCm: get(edges, Col.WidthCm, Uint16Array),
      type: get(edges, Col.EdgeType, Uint8Array),
      permissions: get(edges, Col.Permissions, Uint8Array),
      levelDelta: get(edges, Col.LevelDelta, Int8Array),
      flags: get(edges, Col.EdgeFlags, Uint8Array),
      osmIdLo: get(edges, Col.OsmIdLo, Uint32Array),
      osmIdHi: get(edges, Col.OsmIdHi, Uint32Array),
    },
    adjacency: get(adjacency, Col.HalfEdge, Uint32Array),
    portals: {
      localNode: get(portals, Col.PortalNode, Uint32Array),
      otherTileX: get(portals, Col.PortalTileX, Int32Array),
      otherTileY: get(portals, Col.PortalTileY, Int32Array),
      otherNode: get(portals, Col.PortalOtherNode, Uint32Array),
    },
    polylines: {
      x: get(polylines, Col.PX, Float32Array),
      y: get(polylines, Col.PY, Float32Array),
      z: get(polylines, Col.PZ, Float32Array),
      cumLength: get(polylines, Col.CumLength, Float32Array),
    },
    buildings: {
      ringOffset: get(buildings, Col.RingOffset, Uint32Array),
      ringCount: get(buildings, Col.RingCount, Uint16Array),
      levels: get(buildings, Col.Levels, Int16Array),
      baseZ: get(buildings, Col.BaseZ, Float32Array),
      height: get(buildings, Col.Height, Float32Array),
      type: get(buildings, Col.BuildingType, Uint8Array),
      flags: get(buildings, Col.BuildingFlags, Uint8Array),
      capacity: get(buildings, Col.Capacity, Uint32Array),
      seed: get(buildings, Col.Seed, Uint32Array),
      osmIdLo: get(buildings, Col.BOsmIdLo, Uint32Array),
      osmIdHi: get(buildings, Col.BOsmIdHi, Uint32Array),
      ringX: get(rings, Col.RX, Float32Array),
      ringY: get(rings, Col.RY, Float32Array),
    },
  };
}

/** Region manifest (JSON), one per processed area. */
export interface RegionManifest {
  format: 'city-nav';
  version: 1;
  region: string;
  /** British National Grid origin of the tile-local frame, metres. */
  origin: { crs: 'EPSG:27700'; easting: number; northing: number };
  bboxWgs84: [west: number, south: number, east: number, north: number];
  tileSizeM: number;
  /**
   * South-west corner of tile (0, 0) in the region frame (metres from `origin`). Tile (x, y)
   * covers gridOrigin + [x, x + 1) × tileSizeM, and its coordinates are relative to its own
   * south-west corner.
   */
  gridOrigin: { x: number; y: number };
  /** The drivable road network for traffic (`roads.bin`, see road-network.ts), if built. */
  roads?: {
    file: string;
    nodes: number;
    edges: number;
    km: number;
    /** Area covered when larger than the region (`--roads-bbox`); else the region's. */
    bboxWgs84?: [west: number, south: number, east: number, north: number];
  };
  /**
   * The whole region graph stitched into one container (large chunked regions): the simulation
   * and routing load it instead of stitching every tile.
   */
  graph?: {
    file: string;
    bytes: number;
    /**
     * `tiles`: the building outlines are in the tiles only (region.nav keeps every building without
     * its ring) and the tiles hold no walking graph. Absent: older builds with both everywhere.
     */
    buildingOutlines?: 'tiles';
  };
  /**
   * Ground heights: node, polyline and building heights are metres above `zeroM` (the ground at
   * the origin, metres above Ordnance Datum Newlyn), sampled from `source` at `pixelM` metres.
   * Absent: the region is flat (every height relative to 0).
   */
  terrain?: { source: string; datum: 'ODN'; zeroM: number; pixelM: number };
  tiles: {
    x: number;
    y: number;
    /** The tile's container file (`tile_x_y.nav`, see writeTileContainer). */
    file: string;
    counts: { nodes: number; edges: number; buildings: number; portals: number };
    /** Region-wide id of this tile's first building (nodes.buildingId is region-wide). */
    buildingOffset: number;
    bytes: number;
  }[];
  qa: Partial<Record<string, number>>;
  build: {
    source: string;
    sourceMd5?: string;
    tool: string;
    createdAt: string;
    attribution: string;
  };
}
