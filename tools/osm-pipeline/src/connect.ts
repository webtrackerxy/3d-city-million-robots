import { EdgeType } from '@city/core-types';
import type { Point } from './geometry.ts';
import { type Barriers, inferredAttributes, type SegmentIndex, type WaySet } from './way-set.ts';

export interface GapQa {
  deadEnds: number;
  connected: number;
}

/**
 * Joins dead ends to the nearest other walkway within `maxM` (a footway that stops at the kerb,
 * an inferred sidewalk cut short by suppression). The connector must stay on the same level and
 * must not cross a road centreline or a building wall.
 */
export function closeGaps(
  set: WaySet,
  index: SegmentIndex,
  barriers: Barriers,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
  maxM = 5,
): GapQa {
  const qa: GapQa = { deadEnds: 0, connected: 0 };
  const degrees = set.degrees();
  const levelOf = new Map<number, number>();
  const wayOf = new Map<number, Set<object>>();
  for (const way of set.ways)
    for (const ref of way.refs) {
      levelOf.set(ref, way.attributes.level);
      const list = wayOf.get(ref) ?? new Set();
      list.add(way);
      wayOf.set(ref, list);
    }
  const inside = (p: Point) =>
    p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY;

  for (const [node, degree] of degrees) {
    if (degree !== 1) continue;
    const p = set.position(node);
    if (!inside(p)) continue;
    qa.deadEnds++;
    const level = levelOf.get(node) ?? 0;
    const own = wayOf.get(node) ?? new Set();
    const hit = index
      .nearest(
        p,
        maxM,
        (way, a, b) => !own.has(way) && a !== node && b !== node && way.attributes.level === level,
      )
      .find((candidate) => !barriers.crosses(p, candidate.point));
    if (hit === undefined) continue;
    const target = index.attach(hit);
    if (target === node) continue;
    const way = {
      id: 0,
      refs: [node, target],
      attributes: inferredAttributes(EdgeType.Pavement, 150, 0, level),
    };
    set.add(way);
    index.addWay(way);
    qa.connected++;
  }
  return qa;
}
