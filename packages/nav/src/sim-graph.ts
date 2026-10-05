import type { NavTile } from '@city/formats';
import type { NavGraph } from './nav-graph.ts';

/**
 * The navigation tile as straight segments, for the event-driven simulation and the GPU dead
 * reckoning, which both assume straight edges (x0, z0, heading, length).
 *
 * Every nav edge's polyline becomes consecutive segments; interior polyline points become sim
 * nodes appended after the nav nodes, so sim node n < navNodeCount is nav node n. A nav half-edge
 * maps to a run of sim half-edges: direction 0 walks its segments first → last, direction 1
 * last → first. Coordinates are Three's: X = tile x, Z = −tile y.
 */
export interface SimGraph extends NavGraph {
  navNodeCount: number;
  /** Height of each node (Three Y = tile z): roof walks at their roof's height, 0 on the ground. */
  nodeY: Float32Array;
  /** Segments of nav edge e are firstSegment[e] … firstSegment[e + 1] − 1, from → to. */
  firstSegment: Uint32Array;
  /** Nav edge each segment belongs to. */
  segmentEdge: Uint32Array;
}

/** Segments shorter than this are lengthened to it so no event is ever zero time away. */
const MIN_SEGMENT_M = 0.01;

export function simGraphFromTile(tile: NavTile): SimGraph {
  const { nodes, edges, polylines } = tile;
  const navNodeCount = nodes.x.length;
  const navEdgeCount = edges.from.length;
  let interior = 0;
  for (let e = 0; e < navEdgeCount; e++) interior += edges.polyCount[e];
  const nodeCount = navNodeCount + interior;
  const edgeCount = navEdgeCount + interior;

  const nodeX = new Float32Array(nodeCount);
  const nodeY = new Float32Array(nodeCount);
  const nodeZ = new Float32Array(nodeCount);
  for (let n = 0; n < navNodeCount; n++) {
    nodeX[n] = nodes.x[n];
    nodeY[n] = nodes.z[n];
    nodeZ[n] = -nodes.y[n];
  }
  const edgeFrom = new Uint32Array(edgeCount);
  const edgeTo = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount);
  const edgeHeading = new Float32Array(edgeCount);
  const firstSegment = new Uint32Array(navEdgeCount + 1);
  const segmentEdge = new Uint32Array(edgeCount);

  let nextNode = navNodeCount;
  let segment = 0;
  for (let e = 0; e < navEdgeCount; e++) {
    firstSegment[e] = segment;
    let previous = edges.from[e];
    const count = edges.polyCount[e];
    for (let k = 0; k <= count; k++) {
      let node: number;
      if (k < count) {
        const p = edges.polyOffset[e] + k;
        node = nextNode++;
        nodeX[node] = polylines.x[p];
        nodeY[node] = polylines.z[p];
        nodeZ[node] = -polylines.y[p];
      } else {
        node = edges.to[e];
      }
      const dx = nodeX[node] - nodeX[previous];
      const dz = nodeZ[node] - nodeZ[previous];
      edgeFrom[segment] = previous;
      edgeTo[segment] = node;
      edgeLength[segment] = Math.max(MIN_SEGMENT_M, Math.hypot(dx, dz));
      edgeHeading[segment] = Math.atan2(dx, dz);
      segmentEdge[segment] = e;
      segment++;
      previous = node;
    }
  }
  firstSegment[navEdgeCount] = segment;

  // CSR adjacency over segments (interior nodes have degree 2).
  const degree = new Uint32Array(nodeCount + 1);
  for (let s = 0; s < edgeCount; s++) {
    degree[edgeFrom[s] + 1]++;
    degree[edgeTo[s] + 1]++;
  }
  const firstHalfEdge = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) firstHalfEdge[n + 1] = firstHalfEdge[n] + degree[n + 1];
  const cursor = firstHalfEdge.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeCount * 2);
  for (let s = 0; s < edgeCount; s++) {
    adjacency[cursor[edgeFrom[s]]++] = s * 2;
    adjacency[cursor[edgeTo[s]]++] = s * 2 + 1;
  }

  return {
    nodeCount,
    edgeCount,
    nodeX,
    nodeZ,
    edgeFrom,
    edgeTo,
    edgeLength,
    edgeHeading,
    firstHalfEdge,
    adjacency,
    navNodeCount,
    nodeY,
    firstSegment,
    segmentEdge,
  };
}

/** Start and end height per edge (y0, y1), for the GPU's integrate kernel. */
export function packGpuEdgeHeights(graph: SimGraph): Float32Array {
  const out = new Float32Array(graph.edgeCount * 2);
  for (let e = 0; e < graph.edgeCount; e++) {
    out[e * 2] = graph.nodeY[graph.edgeFrom[e]];
    out[e * 2 + 1] = graph.nodeY[graph.edgeTo[e]];
  }
  return out;
}

/** First sim half-edge walked along nav half-edge `navHalf`. */
export function firstSimHalfEdge(graph: SimGraph, navHalf: number): number {
  const e = navHalf >>> 1;
  return (navHalf & 1) === 0 ? graph.firstSegment[e] * 2 : (graph.firstSegment[e + 1] - 1) * 2 + 1;
}

/** The sim half-edge after `simHalf` on the same nav edge, or −1 at the nav edge's end. */
export function nextSimHalfEdge(graph: SimGraph, simHalf: number): number {
  const segment = simHalf >>> 1;
  const e = graph.segmentEdge[segment];
  if ((simHalf & 1) === 0) return segment + 1 < graph.firstSegment[e + 1] ? (segment + 1) * 2 : -1;
  return segment > graph.firstSegment[e] ? (segment - 1) * 2 + 1 : -1;
}
