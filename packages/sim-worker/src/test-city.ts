import { EdgePermission, EdgeType, NO_BUILDING, NodeType } from '@city/core-types';
import { type NavTile, noPortals } from '@city/formats';

const ALL = EdgePermission.Human | EdgePermission.Robot | EdgePermission.StepFree;

/**
 * A 4 × 4 street grid (50 m blocks) with six buildings in the blocks, each with one entrance on a
 * short connector: building 0 is a 12-storey tower, building 1 has 2 storeys, the rest 3.
 */
export function city(): NavTile {
  const nodes: [number, number, number][] = [];
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) nodes.push([i * 50, j * 50, -1]);
  const at = (i: number, j: number) => j * 4 + i;
  const edges: [number, number, number, number, number][] = [];
  for (let j = 0; j < 4; j++)
    for (let i = 0; i < 3; i++) edges.push([at(i, j), at(i + 1, j), EdgeType.Pavement, 3, ALL]);
  for (let i = 0; i < 4; i++)
    for (let j = 0; j < 3; j++) edges.push([at(i, j), at(i, j + 1), EdgeType.Pavement, 3, ALL]);
  const blocks: [number, number][] = [
    [0, 0],
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 2],
  ];
  const rings: [number, number][][] = [];
  blocks.forEach(([i, j], b) => {
    const x0 = i * 50 + 10;
    const y0 = j * 50 + 10;
    rings.push([
      [x0, y0],
      [x0 + 30, y0],
      [x0 + 30, y0 + 30],
      [x0, y0 + 30],
    ]);
    // Entrance on the south wall, joined to the block's south-west street corner.
    nodes.push([x0 + 15, y0, b]);
    edges.push([at(i, j), nodes.length - 1, EdgeType.Entrance, 1.5, ALL]);
  });
  const n = nodes.length;
  const m = edges.length;
  const degree = new Uint32Array(n + 1);
  for (const [a, b] of edges) {
    degree[a + 1]++;
    degree[b + 1]++;
  }
  const first = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) first[i + 1] = first[i] + degree[i + 1];
  const cursor = first.slice(0, n);
  const adjacency = new Uint32Array(m * 2);
  edges.forEach(([a, b], e) => {
    adjacency[cursor[a]++] = e * 2;
    adjacency[cursor[b]++] = e * 2 + 1;
  });
  const levels = [12, 2, 3, 3, 3, 3];
  return {
    tileX: 0,
    tileY: 0,
    tileSizeM: 256,
    nodes: {
      x: Float32Array.from(nodes, (p) => p[0]),
      y: Float32Array.from(nodes, (p) => p[1]),
      z: new Float32Array(n),
      level: new Int8Array(n),
      type: Uint8Array.from(nodes, (p) => (p[2] >= 0 ? NodeType.Entrance : NodeType.Junction)),
      flags: new Uint16Array(n),
      firstHalfEdge: first,
      buildingId: Uint32Array.from(nodes, (p) => (p[2] >= 0 ? p[2] : NO_BUILDING)),
    },
    edges: {
      from: Uint32Array.from(edges, (e) => e[0]),
      to: Uint32Array.from(edges, (e) => e[1]),
      length: Float32Array.from(edges, ([a, b]) =>
        Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]),
      ),
      polyOffset: new Uint32Array(m),
      polyCount: new Uint16Array(m),
      widthCm: Uint16Array.from(edges, (e) => e[3] * 100),
      type: Uint8Array.from(edges, (e) => e[2]),
      permissions: Uint8Array.from(edges, (e) => e[4]),
      levelDelta: new Int8Array(m),
      flags: new Uint8Array(m),
      osmIdLo: new Uint32Array(m),
      osmIdHi: new Uint32Array(m),
    },
    adjacency,
    portals: noPortals(),
    polylines: {
      x: new Float32Array(0),
      y: new Float32Array(0),
      z: new Float32Array(0),
      cumLength: new Float32Array(0),
    },
    buildings: {
      ringOffset: Uint32Array.from(rings, (_, b) => b * 4),
      ringCount: new Uint16Array(rings.length).fill(4),
      levels: Int16Array.from(levels),
      baseZ: new Float32Array(rings.length),
      height: Float32Array.from(levels, (l) => l * 3.5),
      type: new Uint8Array(rings.length).fill(2), // office
      flags: new Uint8Array(rings.length),
      capacity: Uint32Array.from(levels, (l) => l * 90),
      seed: Uint32Array.from(rings, (_, b) => 1000 + b),
      osmIdLo: new Uint32Array(rings.length),
      osmIdHi: new Uint32Array(rings.length),
      ringX: Float32Array.from(rings.flat(), (p) => p[0]),
      ringY: Float32Array.from(rings.flat(), (p) => p[1]),
    },
  };
}
