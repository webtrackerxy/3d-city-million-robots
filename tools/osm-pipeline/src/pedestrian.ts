import { EdgeFlag, EdgePermission, EdgeType } from '@city/core-types';
import type { OsmWay, Tags } from './opl.ts';

/**
 * Stage 3 (implementation plan §10): which ways people walk on, and what kind of edge each
 * becomes. Roads with sidewalks are M3 (sidewalk inference); only ways with explicit foot access
 * are taken here.
 */
export interface PedestrianAttributes {
  type: EdgeType;
  permissions: number;
  flags: number;
  widthCm: number;
  /** First value of the `level` tag (e.g. "-1;0" → -1); 0 when untagged. */
  level: number;
}

const FOOT_ALLOWED = new Set(['yes', 'designated', 'permissive']);
const DEFAULT_WIDTH_CM: Partial<Record<EdgeType, number>> = {
  [EdgeType.Pavement]: 200,
  [EdgeType.Crossing]: 300,
  [EdgeType.Steps]: 200,
  [EdgeType.Elevator]: 150,
  [EdgeType.Pedestrian]: 600,
  [EdgeType.SharedPath]: 250,
  [EdgeType.LivingStreet]: 500,
  [EdgeType.Corridor]: 300,
};

export function classifyWay(tags: Tags): PedestrianAttributes | null {
  const highway = tags.highway;
  if (highway === undefined) return null;
  const foot = tags.foot;
  if (foot === 'no' || foot === 'use_sidepath') return null;
  const access = tags.access;
  if ((access === 'no' || access === 'private') && !FOOT_ALLOWED.has(foot ?? '')) return null;

  let type: EdgeType | null = null;
  switch (highway) {
    case 'footway':
      type = tags.footway === 'crossing' ? EdgeType.Crossing : EdgeType.Pavement;
      break;
    case 'path':
      type = EdgeType.Pavement;
      break;
    case 'pedestrian':
      type = EdgeType.Pedestrian;
      break;
    case 'living_street':
      type = EdgeType.LivingStreet;
      break;
    case 'steps':
      type = EdgeType.Steps;
      break;
    case 'corridor':
      type = EdgeType.Corridor;
      break;
    case 'elevator':
      type = EdgeType.Elevator;
      break;
    case 'cycleway':
    case 'bridleway':
    case 'track':
      if (FOOT_ALLOWED.has(foot ?? '')) type = EdgeType.SharedPath;
      break;
  }
  if (type === null) return null;

  let flags = 0;
  if (tags.footway === 'sidewalk') flags |= EdgeFlag.Sidewalk;
  if (tags.bridge !== undefined && tags.bridge !== 'no') flags |= EdgeFlag.Bridge;
  if (tags.tunnel !== undefined && tags.tunnel !== 'no') flags |= EdgeFlag.Tunnel;
  if (tags.covered === 'yes') flags |= EdgeFlag.Covered;
  if (tags.indoor === 'yes' || highway === 'corridor') flags |= EdgeFlag.Indoor;
  if (type === EdgeType.Crossing && isSignalised(tags)) flags |= EdgeFlag.Signalised;

  // Robots and step-free routing avoid steps; everything here is open to people.
  let permissions = EdgePermission.Human;
  if (type !== EdgeType.Steps) permissions |= EdgePermission.Robot | EdgePermission.StepFree;

  return {
    type,
    permissions,
    flags,
    widthCm: parseWidthCm(tags.width) ?? DEFAULT_WIDTH_CM[type] ?? 200,
    level: parseLevel(tags.level),
  };
}

/** A crossing with pedestrian signals, in either tagging scheme. */
export function isSignalised(tags: Tags): boolean {
  return (
    tags.crossing === 'traffic_signals' ||
    tags['crossing:signals'] === 'yes' ||
    tags.crossing_ref === 'pelican' ||
    tags.crossing_ref === 'puffin' ||
    tags.crossing_ref === 'toucan'
  );
}

/** "2.5", "2.5 m", "250 cm" → centimetres; unparseable → undefined. */
export function parseWidthCm(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const match = /^\s*([\d.]+)\s*(m|cm)?\s*$/.exec(value);
  if (match === null) return undefined;
  const number = Number(match[1]);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  return Math.min(65535, Math.round(match[2] === 'cm' ? number : number * 100));
}

/** First level of a `level` value ("0", "-1;0", "1.5") rounded down; 0 when absent. */
export function parseLevel(value: string | undefined): number {
  if (value === undefined) return 0;
  const first = Number(value.split(';')[0]);
  return Number.isFinite(first) ? Math.max(-128, Math.min(127, Math.floor(first))) : 0;
}

export function pedestrianWays(
  ways: Iterable<OsmWay>,
): { way: OsmWay; attributes: PedestrianAttributes }[] {
  const out: { way: OsmWay; attributes: PedestrianAttributes }[] = [];
  for (const way of ways) {
    const attributes = classifyWay(way.tags);
    if (attributes !== null && way.refs.length >= 2) out.push({ way, attributes });
  }
  return out;
}
