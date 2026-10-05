import type { NavTileFiles } from '@city/formats';

export type ProfileName = 'pedestrian' | 'robot';

export type RouteRequest =
  | { kind: 'init'; files: NavTileFiles }
  | { kind: 'route'; id: number; from: number; to: number; profile: ProfileName };

export interface RouteResult {
  id: number;
  found: boolean;
  halfEdges: Uint32Array;
  lengthM: number;
  cost: number;
  expanded: number;
  /** Search time inside the worker, 0 for a cache hit. */
  ms: number;
  cached: boolean;
}
