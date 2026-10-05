import { BuildingFlag, NodeType } from '@city/core-types';
import type { NavTile } from '@city/formats';
import type { RegionDefinition } from './regions.ts';

/**
 * Stage 10 (implementation plan §10): connectivity metrics over the finished tile, and the gates
 * that fail the build when they regress.
 */
export interface ConnectivityQa {
  /** Share of network length in the `landMasses` largest components. */
  connectedShare: number;
  entrances: number;
  /** Entrance nodes in those components. */
  entranceConnectedShare: number;
  /** Whole buildings of at least 25 m² (not parts) with an entrance in those components. */
  buildingsReachableShare: number;
  danglingShare: number;
}

export function connectivity(tile: NavTile, landMasses: number): ConnectivityQa {
  const { nodes, edges } = tile;
  const count = nodes.x.length;
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const length = new Float64Array(count);
  for (let e = 0; e < edges.from.length; e++) parent[find(edges.from[e])] = find(edges.to[e]);
  for (let e = 0; e < edges.from.length; e++) length[find(edges.from[e])] += edges.length[e];
  const roots = [...length.keys()].sort((a, b) => length[b] - length[a]).slice(0, landMasses);
  const main = new Set(roots);
  const total = length.reduce((s, l) => s + l, 0);
  const mainLength = roots.reduce((s, r) => s + length[r], 0);

  let entrances = 0;
  let connected = 0;
  let dangling = 0;
  const reachable = new Set<number>();
  for (let n = 0; n < count; n++) {
    if (nodes.type[n] === NodeType.End) dangling++;
    if (nodes.type[n] !== NodeType.Entrance) continue;
    entrances++;
    if (main.has(find(n))) {
      connected++;
      reachable.add(nodes.buildingId[n]);
    }
  }
  const { buildings } = tile;
  let whole = 0;
  let wholeReachable = 0;
  for (let b = 0; b < buildings.flags.length; b++) {
    if ((buildings.flags[b] & BuildingFlag.Part) !== 0 || ringArea(tile, b) < 25) continue;
    whole++;
    if (reachable.has(b)) wholeReachable++;
  }
  return {
    connectedShare: total > 0 ? mainLength / total : 0,
    entrances,
    entranceConnectedShare: entrances > 0 ? connected / entrances : 0,
    buildingsReachableShare: whole > 0 ? wholeReachable / whole : 0,
    danglingShare: count > 0 ? dangling / count : 0,
  };
}

function ringArea(tile: NavTile, b: number): number {
  const { ringOffset, ringCount, ringX, ringY } = tile.buildings;
  const o = ringOffset[b];
  const c = ringCount[b];
  let area = 0;
  for (let k = 0; k < c; k++) {
    const k2 = (k + 1) % c;
    area += ringX[o + k] * ringY[o + k2] - ringX[o + k2] * ringY[o + k];
  }
  return Math.abs(area) / 2;
}

export function gateFailures(
  qa: Partial<Record<string, number>>,
  gates: RegionDefinition['gates'],
): string[] {
  const failures: string[] = [];
  for (const [metric, bound] of Object.entries(gates)) {
    if (bound === undefined) continue;
    const value = qa[metric];
    if (value === undefined) failures.push(`${metric}: missing`);
    else if (bound.min !== undefined && value < bound.min)
      failures.push(`${metric} = ${value.toFixed(3)} < ${bound.min}`);
    else if (bound.max !== undefined && value > bound.max)
      failures.push(`${metric} = ${value.toFixed(3)} > ${bound.max}`);
  }
  return failures;
}
