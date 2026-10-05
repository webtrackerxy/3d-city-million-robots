/**
 * Navigation graph views (implementation plan §11, Appendix A): structure-of-arrays over typed
 * arrays, so a tile fetched from disk can be wrapped without parsing.
 *
 * Half-edge `h = edge * 2 + direction`: direction 0 walks from → to, 1 walks to → from. The GPU
 * edge buffer (x0, z0, heading, length) describes direction 0; the kernels flip for direction 1.
 */
export interface NavGraph {
  nodeCount: number;
  edgeCount: number;
  nodeX: Float32Array;
  nodeZ: Float32Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  /** Metres. */
  edgeLength: Float32Array;
  /** Radians, 0 = +Z, from → to. */
  edgeHeading: Float32Array;
  /** CSR offsets into `adjacency`, nodeCount + 1 entries. */
  firstHalfEdge: Uint32Array;
  /** Half-edges leaving each node. */
  adjacency: Uint32Array;
}

export function halfEdgeStart(graph: NavGraph, halfEdge: number): number {
  const edge = halfEdge >>> 1;
  return (halfEdge & 1) === 0 ? graph.edgeFrom[edge] : graph.edgeTo[edge];
}

export function halfEdgeEnd(graph: NavGraph, halfEdge: number): number {
  const edge = halfEdge >>> 1;
  return (halfEdge & 1) === 0 ? graph.edgeTo[edge] : graph.edgeFrom[edge];
}

/** The same edge walked the other way. */
export function reverseHalfEdge(halfEdge: number): number {
  return halfEdge ^ 1;
}

/** Point `s` metres along a half-edge (straight edges). */
export function pointOnHalfEdge(
  graph: NavGraph,
  halfEdge: number,
  s: number,
  out: [number, number] = [0, 0],
): [number, number] {
  const edge = halfEdge >>> 1;
  const length = graph.edgeLength[edge];
  const along = (halfEdge & 1) === 0 ? s : length - s;
  const heading = graph.edgeHeading[edge];
  const from = graph.edgeFrom[edge];
  out[0] = graph.nodeX[from] + Math.sin(heading) * along;
  out[1] = graph.nodeZ[from] + Math.cos(heading) * along;
  return out;
}

/** Packs the GPU edge buffer: (x0, z0, heading, length) per edge, as Path B's kernels read it. */
export function packGpuEdges(graph: NavGraph): Float32Array {
  const out = new Float32Array(graph.edgeCount * 4);
  for (let e = 0; e < graph.edgeCount; e++) {
    const from = graph.edgeFrom[e];
    out[e * 4] = graph.nodeX[from];
    out[e * 4 + 1] = graph.nodeZ[from];
    out[e * 4 + 2] = graph.edgeHeading[e];
    out[e * 4 + 3] = graph.edgeLength[e];
  }
  return out;
}
