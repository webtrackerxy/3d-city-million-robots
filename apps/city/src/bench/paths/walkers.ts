import { type BakedClip, ClipFlag, mulberry32 } from '@city/assets-runtime';
import {
  AGENT_RECORD_BYTES,
  type AgentRecord,
  GPU_EDGE_FLOATS,
  packAgentKind,
  writeAgentRecord,
} from '@city/core-types';

/**
 * Step 0.4 test crowd: each agent walks its own straight edge on a plane and wraps back to the
 * start at the end. Stands in for the navigation graph until Stage 1; the agent records use the
 * real 24-byte layout, so the GPU path is the production one.
 */

/** Floats per edge: startX, startZ, heading (radians, 0 = +Z), length. */
export const EDGE_FLOATS = GPU_EDGE_FLOATS;

/** Ground area per agent, m². Pedestrian-comfortable density with room to see the gait. */
const AREA_PER_AGENT_M2 = 6;
/** Walking speed used when the clip does not travel (idles, the test rig). */
const FALLBACK_SPEED = 1.3;

export interface WalkerLayout {
  records: DataView<ArrayBuffer>;
  edges: Float32Array<ArrayBuffer>;
  /** Side of the square the edges start in, metres. */
  areaSize: number;
}

export function walkerAreaSize(count: number): number {
  return Math.max(4, Math.sqrt(count * AREA_PER_AGENT_M2));
}

/** What the layout needs to know about each loaded skeleton family. */
export interface WalkerFamily {
  robot: boolean;
  /** Clip index within the family's own clip list. */
  clipIndex: number;
  /** Natural speed of that clip, m/s; 0 for clips that do not travel. */
  clipSpeed: number;
}

/**
 * Writes `count` agents into buffers sized for `capacity`. Half the agents walk their edge in
 * reverse (odd half-edge ids) so both directions of the GPU maths are exercised. With a human
 * and a robot family loaded, each agent is a robot with probability `robotShare`.
 */
export function layoutWalkers(
  count: number,
  capacity: number,
  seed: number,
  families: readonly WalkerFamily[],
  robotShare: number,
  simTimeMs: number,
): WalkerLayout {
  const random = mulberry32(seed);
  const records = new DataView(new ArrayBuffer(capacity * AGENT_RECORD_BYTES));
  const edges = new Float32Array(capacity * EDGE_FLOATS);
  const areaSize = walkerAreaSize(count);
  const pick = familyPicker(families, robotShare, random);

  for (let i = 0; i < count; i++) {
    const length = areaSize * (0.5 + random() * 0.5);
    edges.set(
      [(random() - 0.5) * areaSize, (random() - 0.5) * areaSize, random() * Math.PI * 2, length],
      i * EDGE_FLOATS,
    );
    const { family, variant } = pick();
    const baseSpeed = family.clipSpeed > 0 ? family.clipSpeed : FALLBACK_SPEED;
    const record: AgentRecord = {
      halfEdge: i * 2 + (random() < 0.5 ? 1 : 0),
      s0: random() * length,
      t0: simTimeMs >>> 0,
      speed: Math.round(baseSpeed * (0.85 + random() * 0.3) * 1000),
      lateral: 0,
      anim: family.clipIndex,
      kind: packAgentKind(family.robot, variant),
      flags: 0,
      phase0: Math.floor(random() * 0x10000),
      seed: Math.floor(random() * 0x100000000),
    };
    writeAgentRecord(records, i, record);
  }
  return { records, edges, areaSize };
}

/**
 * Agents standing in rows facing the camera (+Z), for comparing appearances side by side. Bases
 * alternate so every loaded base shows up in the first row.
 */
export function layoutLineup(
  count: number,
  capacity: number,
  seed: number,
  families: readonly WalkerFamily[],
  robotShare: number,
  simTimeMs: number,
): WalkerLayout {
  const random = mulberry32(seed);
  const records = new DataView(new ArrayBuffer(capacity * AGENT_RECORD_BYTES));
  const edges = new Float32Array(capacity * EDGE_FLOATS);
  const perRow = Math.max(1, Math.min(count, Math.max(8, Math.ceil(Math.sqrt(count * 2)))));
  const spacing = 1.1;
  const humans = families.filter((family) => !family.robot);
  const robot = families.find((family) => family.robot);
  for (let i = 0; i < count; i++) {
    const row = Math.floor(i / perRow);
    const column = i % perRow;
    const isRobot = robot !== undefined && (humans.length === 0 || random() < robotShare);
    const variant = isRobot ? 0 : i % Math.max(1, humans.length);
    const family = isRobot ? robot : humans[variant];
    if (family === undefined) throw new Error('No character family loaded');
    edges.set([(column - (perRow - 1) / 2) * spacing, -row * spacing * 1.5, 0, 1], i * EDGE_FLOATS);
    writeAgentRecord(records, i, {
      halfEdge: i * 2,
      s0: 0,
      t0: simTimeMs >>> 0,
      speed: 0,
      lateral: 0,
      anim: family.clipIndex,
      kind: packAgentKind(family.robot, variant),
      flags: 0,
      phase0: Math.floor(random() * 0x10000),
      seed: Math.floor(random() * 0x100000000),
    });
  }
  return { records, edges, areaSize: perRow * spacing };
}

/**
 * Chooses each agent's family: a robot with probability `robotShare` when robots are loaded,
 * otherwise one of the human bases uniformly. `variant` is the base index stored in the record.
 */
function familyPicker(
  families: readonly WalkerFamily[],
  robotShare: number,
  random: () => number,
): () => { family: WalkerFamily; variant: number } {
  const humans = families.filter((family) => !family.robot);
  const robot = families.find((family) => family.robot);
  if (humans.length === 0 && robot === undefined) throw new Error('No character family loaded');
  return () => {
    if (robot !== undefined && (humans.length === 0 || random() < robotShare)) {
      return { family: robot, variant: 0 };
    }
    const variant = humans.length > 1 ? Math.floor(random() * humans.length) : 0;
    const family = humans[variant];
    if (family === undefined) throw new Error('unreachable: no human base');
    return { family, variant };
  };
}

export interface AgentPose {
  x: number;
  z: number;
  /** Heading of travel, radians, 0 = +Z. */
  heading: number;
  /** Stored frame pair and blend, as matrix-row bases (frame × boneCount). */
  base0: number;
  base1: number;
  alpha: number;
}

/**
 * CPU reference for the GPU `integrate` kernel in path-b.ts. Both must implement exactly this:
 *
 *   distance = speed · (t − t0)            s = (s0 + distance) mod length
 *   along    = reverse ? length − s : s    heading = edgeHeading + (reverse ? π : 0)
 *   phase    = phase0 + distance / stride   (or elapsed / duration for clips that do not travel)
 */
export function agentPoseAt(
  record: AgentRecord,
  edges: Float32Array,
  clip: BakedClip,
  boneCount: number,
  simTimeMs: number,
): AgentPose {
  const edge = record.halfEdge >>> 1;
  const reverse = (record.halfEdge & 1) === 1;
  const x0 = edges[edge * EDGE_FLOATS] ?? 0;
  const z0 = edges[edge * EDGE_FLOATS + 1] ?? 0;
  const edgeHeading = edges[edge * EDGE_FLOATS + 2] ?? 0;
  const length = edges[edge * EDGE_FLOATS + 3] ?? 1;

  const elapsed = ((simTimeMs - record.t0) >>> 0) / 1000;
  const distance = (record.speed / 1000) * elapsed;
  const s = positiveModulo(record.s0 + distance, length);
  const along = reverse ? length - s : s;

  const phase =
    record.phase0 / 0x10000 +
    (clip.strideLength > 0
      ? distance / clip.strideLength
      : elapsed / Math.max(clip.duration, 1e-3));
  let u: number;
  if ((clip.flags & ClipFlag.Loop) !== 0) {
    u = (phase - Math.floor(phase)) * clip.frameCount;
  } else {
    u = Math.min(elapsed * clip.fps, clip.frameCount - 1);
  }
  const f0 = Math.min(Math.floor(u), clip.frameCount - 1);
  const alpha = u - Math.floor(u);
  const f1 =
    (clip.flags & ClipFlag.Loop) !== 0
      ? (f0 + 1) % clip.frameCount
      : Math.min(f0 + 1, clip.frameCount - 1);

  return {
    x: x0 + Math.sin(edgeHeading) * along,
    z: z0 + Math.cos(edgeHeading) * along,
    heading: edgeHeading + (reverse ? Math.PI : 0),
    base0: (clip.firstFrame + f0) * boneCount,
    base1: (clip.firstFrame + f1) * boneCount,
    alpha,
  };
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}
