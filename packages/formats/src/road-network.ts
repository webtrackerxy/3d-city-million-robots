/**
 * Drivable road network of a region (`roads.bin`), for the traffic simulation: OSM road nodes in
 * the region frame (metres east / north of the manifest origin) and directed edges — a one-way
 * street has one direction, others both. Same data and projection as the pedestrian tiles, so
 * cars and robots share the streets exactly.
 *
 * Layout (little-endian, 4-byte aligned):
 *   u32 magic 'RDS1' (flat) or 'RDS2' (with heights), u32 nodeCount, u32 edgeCount, u32 classCount
 *   f32 nodes[nodeCount × 2]            x, y        (RDS1)
 *   f32 nodes[nodeCount × 3]            x, y, height (RDS2: metres above the region's terrain zero)
 *   u32 edgeNodes[edgeCount × 2]        from, to
 *   f32 speedMps[edgeCount]
 *   u8  classIndex[edgeCount], padded to 4
 *   then the class names as ASCII JSON (the rest of the file)
 */
export interface RoadNetworkData {
  nodeX: Float32Array;
  nodeY: Float32Array;
  /** Height of each node above the region's terrain zero (manifest `terrain`); absent = flat. */
  nodeHeight?: Float32Array | undefined;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  speedMps: Float32Array;
  classIndex: Uint8Array;
  /** Highway class names, indexed by `classIndex`. */
  classes: string[];
}

const MAGIC = 0x31534452; // 'RDS1'
const MAGIC_HEIGHTS = 0x32534452; // 'RDS2'

export function writeRoadNetwork(roads: RoadNetworkData): ArrayBuffer {
  const nodes = roads.nodeX.length;
  const edges = roads.edgeFrom.length;
  const classes = asciiBytes(JSON.stringify(roads.classes));
  const classBytes = Math.ceil(edges / 4) * 4;
  const heights = roads.nodeHeight;
  const stride = heights === undefined ? 2 : 3;
  const bytes = 16 + nodes * stride * 4 + edges * 8 + edges * 4 + classBytes + classes.byteLength;
  const buffer = new ArrayBuffer(bytes);
  const header = new Uint32Array(buffer, 0, 4);
  header.set([heights === undefined ? MAGIC : MAGIC_HEIGHTS, nodes, edges, roads.classes.length]);
  let offset = 16;
  const xy = new Float32Array(buffer, offset, nodes * stride);
  for (let n = 0; n < nodes; n++) {
    xy[n * stride] = roads.nodeX[n] ?? 0;
    xy[n * stride + 1] = roads.nodeY[n] ?? 0;
    if (heights !== undefined) xy[n * stride + 2] = heights[n] ?? 0;
  }
  offset += nodes * stride * 4;
  const ends = new Uint32Array(buffer, offset, edges * 2);
  for (let e = 0; e < edges; e++) {
    ends[e * 2] = roads.edgeFrom[e] ?? 0;
    ends[e * 2 + 1] = roads.edgeTo[e] ?? 0;
  }
  offset += edges * 8;
  new Float32Array(buffer, offset, edges).set(roads.speedMps);
  offset += edges * 4;
  new Uint8Array(buffer, offset, edges).set(roads.classIndex);
  offset += classBytes;
  new Uint8Array(buffer, offset).set(classes);
  return buffer;
}

export function readRoadNetwork(buffer: ArrayBuffer): RoadNetworkData {
  const [magic = 0, nodes = 0, edges = 0] = new Uint32Array(buffer, 0, 4);
  if (magic !== MAGIC && magic !== MAGIC_HEIGHTS)
    throw new Error('Not a road network file (RDS1/RDS2)');
  const stride = magic === MAGIC_HEIGHTS ? 3 : 2;
  let offset = 16;
  const xy = new Float32Array(buffer, offset, nodes * stride);
  offset += nodes * stride * 4;
  const ends = new Uint32Array(buffer, offset, edges * 2);
  offset += edges * 8;
  const speedMps = new Float32Array(buffer.slice(offset, offset + edges * 4));
  offset += edges * 4;
  const classIndex = new Uint8Array(buffer.slice(offset, offset + edges));
  offset += Math.ceil(edges / 4) * 4;
  const classes = JSON.parse(String.fromCharCode(...new Uint8Array(buffer, offset))) as string[];
  const nodeX = new Float32Array(nodes);
  const nodeY = new Float32Array(nodes);
  const nodeHeight = stride === 3 ? new Float32Array(nodes) : undefined;
  for (let n = 0; n < nodes; n++) {
    nodeX[n] = xy[n * stride] ?? 0;
    nodeY[n] = xy[n * stride + 1] ?? 0;
    if (nodeHeight !== undefined) nodeHeight[n] = xy[n * stride + 2] ?? 0;
  }
  const edgeFrom = new Uint32Array(edges);
  const edgeTo = new Uint32Array(edges);
  for (let e = 0; e < edges; e++) {
    edgeFrom[e] = ends[e * 2] ?? 0;
    edgeTo[e] = ends[e * 2 + 1] ?? 0;
  }
  return { nodeX, nodeY, nodeHeight, edgeFrom, edgeTo, speedMps, classIndex, classes };
}

/** OSM highway class names are ASCII; this package has no DOM text codecs. */
function asciiBytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0x7f);
}
