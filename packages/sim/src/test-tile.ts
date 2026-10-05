import { EdgePermission, EdgeType, NO_BUILDING, NodeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';

/** Compact description of a test tile (tile coordinates, metres). */
export interface TileSpec {
  /** [x, y, entrance building index or −1]. */
  nodes: [number, number, number][];
  /** [from, to, type, flags, widthM, permissions, interior polyline points]. */
  edges: [number, number, number, number, number, number, [number, number][]][];
  /** Capacity per building. */
  buildings: number[];
}

const ALL = EdgePermission.Human | EdgePermission.Robot | EdgePermission.StepFree;
export const PERMISSIONS = { all: ALL, humansOnly: EdgePermission.Human } as const;

export function makeTile(spec: TileSpec): NavTile {
  const n = spec.nodes.length;
  const m = spec.edges.length;
  const degree = new Uint32Array(n + 1);
  for (const [from, to] of spec.edges) {
    degree[from + 1]++;
    degree[to + 1]++;
  }
  const firstHalfEdge = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) firstHalfEdge[i + 1] = firstHalfEdge[i] + degree[i + 1];
  const cursor = firstHalfEdge.slice(0, n);
  const adjacency = new Uint32Array(m * 2);
  spec.edges.forEach(([from, to], e) => {
    adjacency[cursor[from]++] = e * 2;
    adjacency[cursor[to]++] = e * 2 + 1;
  });
  const polyX: number[] = [];
  const polyY: number[] = [];
  const polyOffset = new Uint32Array(m);
  const polyCount = new Uint16Array(m);
  const length = new Float32Array(m);
  spec.edges.forEach(([from, to, , , , , interior], e) => {
    polyOffset[e] = polyX.length;
    polyCount[e] = interior.length;
    const points = [spec.nodes[from], ...interior, spec.nodes[to]];
    let l = 0;
    for (let k = 1; k < points.length; k++)
      l += Math.hypot(points[k][0] - points[k - 1][0], points[k][1] - points[k - 1][1]);
    length[e] = l;
    for (const [x, y] of interior) {
      polyX.push(x);
      polyY.push(y);
    }
  });
  const b = spec.buildings.length;
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 1024,
    nodes: {
      x: Float32Array.from(spec.nodes, (p) => p[0]),
      y: Float32Array.from(spec.nodes, (p) => p[1]),
      z: new Float32Array(n),
      level: new Int8Array(n),
      type: Uint8Array.from(spec.nodes, (p) => (p[2] >= 0 ? NodeType.Entrance : NodeType.Junction)),
      flags: new Uint16Array(n),
      firstHalfEdge,
      buildingId: Uint32Array.from(spec.nodes, (p) => (p[2] >= 0 ? p[2] : NO_BUILDING)),
    },
    edges: {
      from: Uint32Array.from(spec.edges, (e) => e[0]),
      to: Uint32Array.from(spec.edges, (e) => e[1]),
      length,
      polyOffset,
      polyCount,
      widthCm: Uint16Array.from(spec.edges, (e) => Math.round(e[4] * 100)),
      type: Uint8Array.from(spec.edges, (e) => e[2]),
      permissions: Uint8Array.from(spec.edges, (e) => e[5]),
      levelDelta: new Int8Array(m),
      flags: Uint8Array.from(spec.edges, (e) => e[3]),
      osmIdLo: new Uint32Array(m),
      osmIdHi: new Uint32Array(m),
    },
    adjacency,
    portals: noPortals(),
    polylines: {
      x: Float32Array.from(polyX),
      y: Float32Array.from(polyY),
      z: new Float32Array(polyX.length),
      cumLength: new Float32Array(polyX.length),
    },
    buildings: {
      ringOffset: new Uint32Array(b),
      ringCount: new Uint16Array(b),
      levels: new Int16Array(b).fill(3),
      baseZ: new Float32Array(b),
      height: new Float32Array(b).fill(10),
      type: new Uint8Array(b),
      flags: new Uint8Array(b),
      capacity: Uint32Array.from(spec.buildings),
      seed: new Uint32Array(b),
      osmIdLo: new Uint32Array(b),
      osmIdHi: new Uint32Array(b),
      ringX: new Float32Array(0),
      ringY: new Float32Array(0),
    },
  };
}

/**
 * A 4 × 4 street grid (50 m blocks) of 2 m pavements, with one 6 m pedestrian street, a bent
 * footway, a flight of steps (humans only), a signalised crossing and an implicit one, and six
 * entrances on short connectors.
 */
export function gridTile(): NavTile {
  const nodes: TileSpec['nodes'] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) nodes.push([i * 50, j * 50, -1]);
  const edges: TileSpec['edges'] = [];
  const at = (i: number, j: number) => j * 4 + i;
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 3; i++)
      edges.push([at(i, j), at(i + 1, j), EdgeType.Pavement, 0, 2, ALL, []]);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++)
      edges.push([at(i, j), at(i, j + 1), EdgeType.Pavement, 0, 2, ALL, []]);
  edges[0] = [at(0, 0), at(1, 0), EdgeType.Pedestrian, 0, 6, ALL, []];
  edges[4] = [at(1, 1), at(2, 1), EdgeType.Steps, 0, 2, EdgePermission.Human, []];
  edges[7] = [at(1, 2), at(2, 2), EdgeType.Crossing, 1 << 7, 3, ALL, []];
  edges[13] = [at(0, 1), at(0, 2), EdgeType.Crossing, 1 << 6, 3, ALL, []];
  edges[2] = [
    at(2, 0),
    at(3, 0),
    EdgeType.Pavement,
    0,
    2,
    ALL,
    [
      [165, 12],
      [180, 8],
    ],
  ];
  const entrances = [at(0, 0), at(3, 0), at(0, 3), at(3, 3), at(1, 1), at(2, 2)];
  entrances.forEach((node, building) => {
    const [x, y] = nodes[node];
    nodes.push([x + 5, y + 5, building]);
    edges.push([node, nodes.length - 1, EdgeType.Entrance, 0, 1.5, ALL, []]);
  });
  return makeTile({ nodes, edges, buildings: [100, 50, 200, 80, 40, 120] });
}
