import type { NavGraph } from './nav-graph.ts';

/**
 * Synthetic street grid for simulation benchmarks (step 0.10): `columns × rows` junctions
 * `spacing` metres apart, each joined to its right and lower neighbour. Stands in for OSM tiles
 * until the pipeline of §10 exists.
 */
export function createGridGraph(columns: number, rows: number, spacing: number): NavGraph {
  const nodeCount = columns * rows;
  const nodeX = new Float32Array(nodeCount);
  const nodeZ = new Float32Array(nodeCount);
  const originX = ((columns - 1) * spacing) / 2;
  const originZ = ((rows - 1) * spacing) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      nodeX[r * columns + c] = c * spacing - originX;
      nodeZ[r * columns + c] = r * spacing - originZ;
    }
  }

  const edgeCount = (columns - 1) * rows + columns * (rows - 1);
  const edgeFrom = new Uint32Array(edgeCount);
  const edgeTo = new Uint32Array(edgeCount);
  const edgeLength = new Float32Array(edgeCount).fill(spacing);
  const edgeHeading = new Float32Array(edgeCount);
  let e = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const node = r * columns + c;
      if (c + 1 < columns) {
        edgeFrom[e] = node;
        edgeTo[e] = node + 1;
        edgeHeading[e] = Math.PI / 2; // +X
        e++;
      }
      if (r + 1 < rows) {
        edgeFrom[e] = node;
        edgeTo[e] = node + columns;
        edgeHeading[e] = 0; // +Z
        e++;
      }
    }
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
    ...buildAdjacency(nodeCount, edgeFrom, edgeTo),
  };
}

/** CSR adjacency of outgoing half-edges per node. */
export function buildAdjacency(
  nodeCount: number,
  edgeFrom: Uint32Array,
  edgeTo: Uint32Array,
): { firstHalfEdge: Uint32Array; adjacency: Uint32Array } {
  const degree = new Uint32Array(nodeCount + 1);
  for (let e = 0; e < edgeFrom.length; e++) {
    degree[edgeFrom[e] + 1]++;
    degree[edgeTo[e] + 1]++;
  }
  const firstHalfEdge = new Uint32Array(nodeCount + 1);
  for (let n = 0; n < nodeCount; n++) firstHalfEdge[n + 1] = firstHalfEdge[n] + degree[n + 1];
  const cursor = firstHalfEdge.slice(0, nodeCount);
  const adjacency = new Uint32Array(edgeFrom.length * 2);
  for (let e = 0; e < edgeFrom.length; e++) {
    adjacency[cursor[edgeFrom[e]]++] = e * 2; // from → to leaves `from`
    adjacency[cursor[edgeTo[e]]++] = e * 2 + 1; // to → from leaves `to`
  }
  return { firstHalfEdge, adjacency };
}

/** Grid size for `agents` at `agentsPerEdge` on 30 m blocks, roughly square. */
export function gridForAgents(
  agents: number,
  agentsPerEdge: number,
): { columns: number; rows: number } {
  const edges = Math.max(4, agents / agentsPerEdge);
  const side = Math.max(2, Math.ceil(Math.sqrt(edges / 2)) + 1);
  return { columns: side, rows: side };
}
