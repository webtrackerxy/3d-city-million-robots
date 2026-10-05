import { EdgeFlag, EdgeType } from '@city/core-types';
import type { NavTile } from '@city/formats';

/** Line segments for every edge polyline, coloured by edge type, component, or data source. */
export type NetworkColouring = 'type' | 'component' | 'source';

export interface LineArrays {
  /** Segment endpoints, Three coordinates (X = x, Y = z + lift, Z = −y). */
  positions: Float32Array;
  colours: Float32Array;
  segments: number;
}

const EDGE_COLOURS: Record<number, [number, number, number]> = {
  [EdgeType.Pavement]: [0.85, 0.85, 0.8],
  [EdgeType.Crossing]: [1.0, 0.85, 0.1],
  [EdgeType.Steps]: [1.0, 0.35, 0.2],
  [EdgeType.Elevator]: [0.9, 0.3, 0.9],
  [EdgeType.Escalator]: [0.9, 0.3, 0.9],
  [EdgeType.Pedestrian]: [0.3, 0.85, 0.9],
  [EdgeType.SharedPath]: [0.4, 0.8, 0.4],
  [EdgeType.LivingStreet]: [0.5, 0.7, 1.0],
  [EdgeType.Corridor]: [0.7, 0.5, 1.0],
  [EdgeType.Entrance]: [0.95, 0.35, 0.95],
};
/** Source colouring: what OSM mapped vs. what the pipeline generated (plan §24 pipeline viewer). */
export const SOURCE_COLOURS = {
  mapped: [0.8, 0.8, 0.78],
  inferred: [0.2, 0.8, 1.0],
  crossing: [1.0, 0.85, 0.1],
  implicit: [1.0, 0.4, 0.1],
  connector: [0.95, 0.35, 0.95],
} as const satisfies Record<string, readonly [number, number, number]>;

function sourceColour(type: number, flags: number): readonly [number, number, number] {
  if ((flags & EdgeFlag.Implicit) !== 0) return SOURCE_COLOURS.implicit;
  if (type === EdgeType.Entrance) return SOURCE_COLOURS.connector;
  if (type === EdgeType.Crossing) return SOURCE_COLOURS.crossing;
  if ((flags & EdgeFlag.Inferred) !== 0) return SOURCE_COLOURS.inferred;
  return SOURCE_COLOURS.mapped;
}

/** Ways on other levels (underground, podium) are drawn dim. */
const OFF_LEVEL_DIM = 0.3;
/** Lines float slightly above the ground to avoid z-fighting. */
const LIFT_M = 0.3;

export interface NetworkOptions {
  colouring: NetworkColouring;
  /** Draw edges whose level is not 0. */
  showOtherLevels: boolean;
}

export function networkGeometry(tile: NavTile, options: NetworkOptions): LineArrays {
  const { nodes, edges, polylines } = tile;
  const component = options.colouring === 'component' ? components(tile) : null;
  const componentSize = new Map<number, number>();
  if (component !== null)
    for (const c of component.edgeComponent) componentSize.set(c, (componentSize.get(c) ?? 0) + 1);
  const largest =
    component === null ? -1 : ([...componentSize].sort((a, b) => b[1] - a[1])[0]?.[0] ?? -1);

  const segmentCount = (e: number) => edges.polyCount[e] + 1;
  let total = 0;
  const visible = (e: number) =>
    options.showOtherLevels || (nodes.level[edges.from[e]] === 0 && nodes.level[edges.to[e]] === 0);
  for (let e = 0; e < edges.from.length; e++) if (visible(e)) total += segmentCount(e);
  const positions = new Float32Array(total * 6);
  const colours = new Float32Array(total * 6);
  let s = 0;

  for (let e = 0; e < edges.from.length; e++) {
    if (!visible(e)) continue;
    let colour: [number, number, number];
    if (component !== null) {
      const c = component.edgeComponent[e];
      colour = c === largest ? [0.35, 0.85, 0.45] : hue(c);
    } else if (options.colouring === 'source') {
      colour = [...sourceColour(edges.type[e], edges.flags[e])];
    } else {
      colour = EDGE_COLOURS[edges.type[e]] ?? [1, 1, 1];
    }
    const offLevel = nodes.level[edges.from[e]] !== 0 || nodes.level[edges.to[e]] !== 0;
    if (offLevel) colour = colour.map((c) => c * OFF_LEVEL_DIM) as [number, number, number];

    const a = edges.from[e];
    const b = edges.to[e];
    const points: [number, number, number][] = [[nodes.x[a], nodes.y[a], nodes.z[a]]];
    for (let k = 0; k < edges.polyCount[e]; k++) {
      const p = edges.polyOffset[e] + k;
      points.push([polylines.x[p], polylines.y[p], polylines.z[p]]);
    }
    points.push([nodes.x[b], nodes.y[b], nodes.z[b]]);
    for (let k = 0; k + 1 < points.length; k++) {
      const [x1, y1, z1] = points[k];
      const [x2, y2, z2] = points[k + 1];
      positions.set([x1, z1 + LIFT_M, -y1, x2, z2 + LIFT_M, -y2], s * 6);
      colours.set([...colour, ...colour], s * 6);
      s++;
    }
  }
  return { positions, colours, segments: s };
}

/** Connected components over the tile's edges (union-find on nodes). */
export function components(tile: NavTile): { edgeComponent: Uint32Array; count: number } {
  const parent = Uint32Array.from({ length: tile.nodes.x.length }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let e = 0; e < tile.edges.from.length; e++)
    parent[find(tile.edges.from[e])] = find(tile.edges.to[e]);
  const ids = new Map<number, number>();
  const edgeComponent = new Uint32Array(tile.edges.from.length);
  for (let e = 0; e < edgeComponent.length; e++) {
    const root = find(tile.edges.from[e]);
    let id = ids.get(root);
    if (id === undefined) {
      id = ids.size;
      ids.set(root, id);
    }
    edgeComponent[e] = id;
  }
  return { edgeComponent, count: ids.size };
}

function hue(i: number): [number, number, number] {
  const h = (i * 0.618034) % 1;
  const k = (n: number) => (n + h * 6) % 6;
  const f = (n: number) => 0.9 - 0.7 * Math.max(0, Math.min(k(n), 4 - k(n), 1));
  return [f(5), f(3), f(1)];
}
