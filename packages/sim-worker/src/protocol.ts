import type { NavTileFiles } from '@city/formats';
import type { AgentState, CityStats, FollowKind, KindAnimation } from '@city/sim';
import type { ExchangeLayout } from './partition.ts';
import type { SharedBuffers } from './shared.ts';

export interface SimConfig {
  agents: number;
  robotShare: number;
  seed: number;
  human: KindAnimation;
  robot: KindAnimation;
  humanVariants: number;
  /** Relative share of each human base mesh; default equal. */
  humanShares?: number[];
  avoidance: boolean;
  /** Roof walks appended to the graph (from this edge on), and where they are (tile frame). */
  firstRoofEdge: number;
  roofZone?: { minX: number; minY: number; maxX: number; maxY: number };
  /** Share of the people walking at the start who walk on roofs instead, 0–1. */
  roofShare: number;
  /** People in the region (rows + building aggregates) and the time of day at sim time 0. */
  population: number;
  startHour: number;
  /** Showcase: everyone walking from the start, and nobody goes indoors. */
  showcase: boolean;
  /**
   * City scale (London): local trips, larger destination clusters and a byte budget for each
   * worker's next-hop tables, so the tables stay bounded on a graph of a million nodes.
   */
  scale?: { tripRadiusM: number; clusterM: number; tableBytes: number };
  /**
   * Each worker's strip of the region (tile x, metres), by worker index: its agents' destinations
   * and streets stay inside it, so it only builds tables for its own area.
   */
  areas?: { minX: number; maxX: number }[];
}

/** The followed agent, as the inspector shows it. */
export interface FollowState {
  agent: number;
  state: AgentState;
  /** The building whose roof it is on, or −1. */
  building: number;
  roof: boolean;
  robot: boolean;
  seed: number;
}

export type ToWorker =
  | {
      kind: 'start';
      files: NavTileFiles;
      config: SimConfig;
      shared: SharedBuffers;
      /** This worker's partition: `index` of `workers`, exchanging through `exchange`. */
      partition: { index: number; workers: number; layout: ExchangeLayout };
    }
  /** Asks for a roof walker (of `agentKind`, if set) near the focus. */
  | { kind: 'pickFollow'; agentKind?: FollowKind };

export type FromWorker =
  | { kind: 'ready'; setupMs: number }
  | {
      kind: 'stats';
      stats: CityStats;
      simMs: number;
      /** Worker CPU per simulated second (all ticks in the report window), without barrier waits. */
      tickMsPerSimSecond: number;
      /** Time blocked at the tick barrier per simulated second. */
      barrierMsPerSimSecond: number;
      recordsPerSecond: number;
      follow: FollowState | null;
      population: number;
    }
  | { kind: 'followCandidate'; agent: number }
  | { kind: 'error'; message: string };
