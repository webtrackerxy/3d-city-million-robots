import type { RoadNetworkData } from '@city/formats';
import type { Point } from './geometry.ts';
import type { OsmData, Tags } from './opl.ts';

/**
 * The drivable network for traffic, from the same extract as the pedestrian graph: OSM car roads
 * with a default speed per class (as the 3d-city-million-cars project's build-roads script), one
 * directed edge per way segment and direction. One-way: `oneway=yes|1|true`, `-1` (reversed),
 * roundabouts and motorways. Segments are kept when either end is inside `bounds`.
 */
const CLASSES: Record<string, number> = {
  motorway: 80,
  motorway_link: 50,
  trunk: 60,
  trunk_link: 40,
  primary: 50,
  primary_link: 35,
  secondary: 45,
  secondary_link: 30,
  tertiary: 40,
  tertiary_link: 30,
  unclassified: 30,
  residential: 30,
  living_street: 15,
};
const CLASS_NAMES = Object.keys(CLASSES);

function isDrivable(tags: Tags): boolean {
  const highway = tags.highway;
  if (highway === undefined || !(highway in CLASSES)) return false;
  if (tags.area === 'yes') return false;
  const access = tags.motor_vehicle ?? tags.access;
  return access !== 'no' && access !== 'private';
}

/** Direction of travel: 1 along the way, −1 against it, 0 both. */
function onewayOf(tags: Tags): 1 | -1 | 0 {
  const oneway = tags.oneway;
  if (oneway === '-1' || oneway === 'reverse') return -1;
  if (oneway === 'yes' || oneway === '1' || oneway === 'true') return 1;
  if (oneway === 'no') return 0;
  if (tags.junction === 'roundabout' || tags.junction === 'circular') return 1;
  if (tags.highway === 'motorway' || tags.highway === 'motorway_link') return 1;
  return 0;
}

export function extractRoadNetwork(
  data: OsmData,
  positions: Map<number, Point>,
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): {
  roads: RoadNetworkData;
  km: number;
  /** Per node: 1 if any road at it is on the ground (not a bridge or tunnel), for terrain. */
  onGround: Uint8Array;
} {
  const inside = (p: Point) =>
    p[0] >= bounds.minX && p[0] <= bounds.maxX && p[1] >= bounds.minY && p[1] <= bounds.maxY;
  const nodeOf = new Map<number, number>();
  const nodeX: number[] = [];
  const nodeY: number[] = [];
  const from: number[] = [];
  const to: number[] = [];
  const speed: number[] = [];
  const cls: number[] = [];
  const ground: number[] = [];
  const node = (id: number, p: Point): number => {
    let n = nodeOf.get(id);
    if (n === undefined) {
      n = nodeX.length;
      nodeOf.set(id, n);
      nodeX.push(p[0]);
      nodeY.push(p[1]);
      ground.push(0);
    }
    return n;
  };
  let metres = 0;
  for (const way of data.ways.values()) {
    if (!isDrivable(way.tags)) continue;
    const highway = way.tags.highway ?? '';
    const speedMps = ((CLASSES[highway] ?? 30) * 1000) / 3600;
    const classIndex = CLASS_NAMES.indexOf(highway);
    const oneway = onewayOf(way.tags);
    const raised = (value: string | undefined) => value !== undefined && value !== 'no';
    const elevated = raised(way.tags.bridge) || raised(way.tags.tunnel);
    for (let k = 0; k + 1 < way.refs.length; k++) {
      const aId = way.refs[k] ?? 0;
      const bId = way.refs[k + 1] ?? 0;
      const a = positions.get(aId);
      const b = positions.get(bId);
      if (a === undefined || b === undefined || (!inside(a) && !inside(b))) continue;
      const na = node(aId, a);
      const nb = node(bId, b);
      if (!elevated) {
        ground[na] = 1;
        ground[nb] = 1;
      }
      metres += Math.hypot(b[0] - a[0], b[1] - a[1]);
      const add = (p: number, q: number) => {
        from.push(p);
        to.push(q);
        speed.push(speedMps);
        cls.push(classIndex);
      };
      if (oneway >= 0) add(na, nb);
      if (oneway <= 0) add(nb, na);
    }
  }
  return {
    onGround: Uint8Array.from(ground),
    roads: {
      nodeX: Float32Array.from(nodeX),
      nodeY: Float32Array.from(nodeY),
      edgeFrom: Uint32Array.from(from),
      edgeTo: Uint32Array.from(to),
      speedMps: Float32Array.from(speed),
      classIndex: Uint8Array.from(cls),
      classes: CLASS_NAMES,
    },
    km: metres / 1000,
  };
}
