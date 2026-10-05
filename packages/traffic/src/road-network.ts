/*
 * Ported from the 3d-city-million-cars project (src/simulation, src/data), same author: the
 * road graph, traffic model and vehicle buffer, reading this project's road network file.
 */
/**
 * Directed road graph in local metres, built once from a region's road network. Typed arrays
 * only, so it can be built inside a worker and shared by the simulation and (later)
 * routing. Each edge is a straight segment between two OSM nodes.
 */

import type { RoadNetworkData } from '@city/formats';

export class RoadNetwork {
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** node positions, local metres */
  readonly nodeX: Float32Array;
  readonly nodeZ: Float32Array;
  /** node elevation above sea level, metres (0 until applyElevation) */
  readonly nodeY: Float32Array;
  /** per edge */
  readonly edgeFrom: Int32Array;
  readonly edgeTo: Int32Array;
  readonly edgeLength: Float32Array;
  readonly edgeSpeed: Float32Array;
  readonly edgeClass: Uint8Array;
  /** compass heading of the edge in radians (clockwise from north) */
  readonly edgeHeading: Float32Array;
  /** unit direction of the edge in local metres */
  readonly edgeDirX: Float32Array;
  readonly edgeDirZ: Float32Array;
  /** 1 when the opposite direction exists as its own edge (two-way road) */
  readonly edgeTwoWay: Uint8Array;
  /** CSR adjacency: outgoing edges of node n are outEdges[outStart[n] .. outStart[n+1]) */
  readonly outStart: Int32Array;
  readonly outEdges: Int32Array;
  readonly totalLength: number;
  /** cumulative edge length, for uniform spawning along the network */
  readonly cumulativeLength: Float64Array;

  /** From a region's road network: region frame (x east, y north) → Three (x, z = −y). */
  constructor(file: RoadNetworkData) {
    this.nodeCount = file.nodeX.length;
    this.nodeX = new Float32Array(this.nodeCount);
    this.nodeZ = new Float32Array(this.nodeCount);
    this.nodeY = new Float32Array(this.nodeCount);
    for (let i = 0; i < this.nodeCount; i++) {
      this.nodeX[i] = file.nodeX[i];
      this.nodeZ[i] = -file.nodeY[i];
      this.nodeY[i] = file.nodeHeight?.[i] ?? 0;
    }
    this.edgeCount = file.edgeFrom.length;
    const n = this.edgeCount;
    this.edgeFrom = new Int32Array(n);
    this.edgeTo = new Int32Array(n);
    this.edgeLength = new Float32Array(n);
    this.edgeSpeed = new Float32Array(n);
    this.edgeClass = new Uint8Array(n);
    this.edgeHeading = new Float32Array(n);
    this.edgeDirX = new Float32Array(n);
    this.edgeDirZ = new Float32Array(n);
    this.cumulativeLength = new Float64Array(n + 1);
    const outCount = new Int32Array(this.nodeCount + 1);
    let total = 0;
    for (let e = 0; e < n; e++) {
      const from = file.edgeFrom[e];
      const to = file.edgeTo[e];
      this.edgeFrom[e] = from;
      this.edgeTo[e] = to;
      this.edgeSpeed[e] = file.speedMps[e];
      this.edgeClass[e] = file.classIndex[e];
      const dx = this.nodeX[to] - this.nodeX[from];
      const dz = this.nodeZ[to] - this.nodeZ[from];
      const len = Math.hypot(dx, dz) || 1e-3;
      this.edgeLength[e] = len;
      this.edgeDirX[e] = dx / len;
      this.edgeDirZ[e] = dz / len;
      // heading clockwise from north: north is -z, east is +x
      this.edgeHeading[e] = Math.atan2(dx, -dz);
      outCount[from + 1] = outCount[from + 1] + 1;
      this.cumulativeLength[e] = total;
      total += len;
    }
    this.cumulativeLength[n] = total;
    this.totalLength = total;
    // CSR
    this.outStart = new Int32Array(this.nodeCount + 1);
    for (let i = 0; i < this.nodeCount; i++) {
      this.outStart[i + 1] = this.outStart[i] + outCount[i + 1];
    }
    this.outEdges = new Int32Array(n);
    const fill = new Int32Array(this.nodeCount);
    for (let e = 0; e < n; e++) {
      const from = this.edgeFrom[e];
      const slot = this.outStart[from] + fill[from];
      this.outEdges[slot] = e;
      fill[from] = fill[from] + 1;
    }
    // two-way roads are emitted as one edge per direction over the same geometry; flag
    // them so traffic can be pushed into the lane on its side of the centreline
    this.edgeTwoWay = new Uint8Array(n);
    for (let e = 0; e < n; e++) {
      const from = this.edgeFrom[e];
      const to = this.edgeTo[e];
      const degree = this.outDegree(to);
      for (let k = 0; k < degree; k++) {
        if (this.edgeTo[this.outEdge(to, k)] === from) {
          this.edgeTwoWay[e] = 1;
          break;
        }
      }
    }
  }

  outDegree(node: number): number {
    return this.outStart[node + 1] - this.outStart[node];
  }

  /** k-th outgoing edge of a node (0 ≤ k < outDegree). */
  outEdge(node: number, k: number): number {
    return this.outEdges[this.outStart[node] + k];
  }

  /** Edge containing the network-length position `d` in [0, totalLength), by binary search. */
  edgeAtDistance(d: number): { edge: number; offset: number } {
    let lo = 0;
    let hi = this.edgeCount - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.cumulativeLength[mid] <= d) lo = mid;
      else hi = mid - 1;
    }
    return { edge: lo, offset: d - this.cumulativeLength[lo] };
  }
}
