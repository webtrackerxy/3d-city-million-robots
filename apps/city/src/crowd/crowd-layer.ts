import type { NavTileFiles } from '@city/formats';
import { MetricsBus } from '@city/metrics';
import {
  AGENT_KIND_ROBOT_BIT,
  AGENT_KIND_VARIANT_MASK,
  AGENT_RECORD_BYTES,
  AgentFlag,
  AgentRecordOffset,
} from '@city/core-types';
import { packGpuEdgeHeights, packGpuEdges, type SimGraph } from '@city/nav';
import {
  applyLodControls,
  BUCKETS_PER_FAMILY,
  createHiZ,
  createGpuCrowd,
  type GpuCrowd,
  HUMAN_HEIGHT_VARIATION,
  type LoadedFamily,
  LOD_FADE_MS,
  loadFamily,
  type LodPreset,
  prepareCrowdFamilies,
  updateCrowdView,
} from '@city/render';
import type { FollowKind, KindAnimation } from '@city/sim';
import { type FollowState, type SimConfig, SimWorkerClient } from '@city/sim-worker';
import { type Matrix4, type PerspectiveCamera, type Scene, Vector3 } from 'three';
import type { WebGPURenderer } from 'three/webgpu';

export interface CrowdOptions {
  /** Contribution culling: agents under this projected height in pixels are not drawn. */
  minPx: number;
  /** LOD thresholds (plan §17): 'brief' or 'density' (coarser, cheaper at large crowds). */
  lodPreset: LodPreset;
  /** Everyone walking, nobody indoors (the million-robot showcase). */
  showcase: boolean;
  /** Simulation workers (partitions of the population). */
  workers: number;
  /** Rows (individually simulated at most at once); `population` may be larger. */
  agents: number;
  population: number;
  startHour: number;
  /** Roof walks appended to the graph from this edge on, and where they are (tile frame). */
  firstRoofEdge: number;
  roofZone?: SimConfig['roofZone'];
  /** Share of the people walking at the start who walk on roofs instead, 0–1. */
  roofShare: number;
  /** Debug: replaces the mesh LOD caps (0 = every agent an impostor). */
  lodCapOverride?: number;
  /** Hi-Z occlusion against buildings on this layer; undefined = off. */
  occluderLayer?: number;
  /** Character triangle budget per frame (plan §17: 10–12M on the desktop reference GPU). */
  triangleBudget?: number;
  robotShare: number;
  seed: number;
  /** Human base models (each a family; agents pick one by their variant). */
  humanModels: string[];
  /** Relative share of each human model; default equal. */
  humanShares?: number[];
  /** City-scale simulation settings (see SimConfig.scale), for large regions. */
  scale?: SimConfig['scale'];
  /** Each worker's strip of the region (see SimConfig.areas). */
  areas?: SimConfig['areas'];
  robotModel: string;
}

export interface CrowdStats {
  agents: number;
  walking: number;
  waiting: number;
  indoor: number;
  simSeconds: number;
  /** Worker CPU per simulated second (slowest worker, without barrier waits). */
  workerMsPerSimSecond: number;
  barrierMsPerSimSecond: number;
  /** Agents in the near tier (T0, full avoidance). */
  nearTier: number;
  tablesBuilt: number;
  recordsPerSecond: number;
  /** Records uploaded in the last frame. */
  uploaded: number;
  /** Characters' triangles drawn (GPU readback) and the budget controller's LOD bias. */
  visibleTriangles: number;
  visibleAgents: number;
  lodBias: number;
  /** Rows + building aggregates (constant). */
  population: number;
  /** On roof walks (rows, for good). */
  onRoof: number;
  /** In building aggregates (T3, no rows). */
  aggregated: number;
  /** Rows in use (individually simulated, event-driven). */
  rows: number;
  timeOfDayMs: number;
  blockedEmissions: number;
  follow: FollowState | null;
  /** Main-thread crowd work per frame (drain, pack, uniforms, dispatch), mean and max of 120. */
  frameCpuMs: number;
  frameCpuMaxMs: number;
}

export interface CrowdLayer {
  /** Advances the clock, uploads changed records and dispatches the crowd passes. */
  frame(camera: PerspectiveCamera, drawingBufferHeight: number, dtMs: number, focus: Vector3): void;
  setTimeScale(scale: number): void;
  /**
   * Roof walkers are drawn only inside this box (tile frame: where buildings are loaded); null
   * draws them everywhere.
   */
  setRoofArea(area: { minX: number; minY: number; maxX: number; maxY: number } | null): void;
  /** Report this agent's state in the stats (−1: none). */
  setFollow(agent: number): void;
  /** A person or a robot (if `kind` is set) on a roof near the focus, or −1. */
  pickFollow(kind?: FollowKind): Promise<number>;
  /** Where an agent is now (Three coordinates), from its record; null if aggregated. */
  agentPosition(agent: number): Vector3 | null;
  /**
   * The agent drawn nearest a screen point (normalised device coordinates), within `maxPx` of it
   * on a `width` × `height` canvas, or −1; with its distance in pixels.
   */
  pickAgent(
    viewProjection: Matrix4,
    ndcX: number,
    ndcY: number,
    width: number,
    height: number,
    maxPx: number,
  ): { agent: number; px: number } | null;
  /** What an agent is, from its record: robot or a human model's index, speed and heading. */
  agentInfo(agent: number): AgentInfo | null;
  /**
   * Steps the simulation as `frame` does, without drawing (Map XR on WebGL draws the crowd itself
   * from `agentPose`).
   */
  advance(dtMs: number, focus: Vector3): void;
  /** Where an agent stands, which way it faces, and which baked frame to show; false if hidden. */
  agentPose(agent: number, out: AgentPose): boolean;
  /** The loaded characters: the human models in order, then the robot. */
  families(): readonly LoadedFamily[];
  /** The number of agents (rows). */
  readonly agents: number;
  stats(): CrowdStats | null;
  dispose(): void;
}

export interface AgentPose {
  /** Three coordinates, the lane offset included. */
  x: number;
  y: number;
  z: number;
  /** Yaw about +Y (model forward +Z). */
  yaw: number;
  /** Index into `families()`. */
  family: number;
  /** Baked frame rows (into the family's matrices) to blend, and the blend. */
  frame0: number;
  frame1: number;
  alpha: number;
}

export interface AgentInfo {
  robot: boolean;
  /** The human model's index (in `humanModels`) when not a robot. */
  humanModel: number;
  /** Inside a building (aggregated): not drawn. */
  indoor: boolean;
  roof: boolean;
  speedMps: number;
  /** Walking direction, radians clockwise from north. */
  headingRad: number;
}

/** How far ahead of the drawn time the workers simulate (ms of sim time at 1×). */
const SIM_LEAD_MS = 250;

/** Camera height above which Hi-Z occlusion is switched off. */
const OCCLUSION_MAX_HEIGHT_M = 200;

/** Families are loaded (and their LODs built) once per page and reused across restarts. */
let familiesPromise: Promise<LoadedFamily[]> | null = null;

function loadFamilies(
  options: CrowdOptions,
  progress: (message: string) => void,
): Promise<LoadedFamily[]> {
  familiesPromise ??= (async () => {
    const bus = new MetricsBus();
    // Textured models keep their own look: no palette tint.
    const humans: LoadedFamily[] = [];
    for (const [i, model] of options.humanModels.entries())
      humans.push(
        await loadFamily(
          { key: `human${i}`, model, tintMask: false, targetHeight: 1.75, withLods: true },
          bus,
          progress,
        ),
      );
    const robot = await loadFamily(
      { key: 'robot', model: options.robotModel, targetHeight: 1.75, withLods: true },
      bus,
      progress,
    );
    return [...humans, robot];
  })();
  return familiesPromise;
}

/** Walk and idle clip ids and the walk stride of a family. */
function kindAnimation(family: LoadedFamily, heightVariation: number): KindAnimation {
  const clips = family.source.clips;
  const walk = family.source.clipIndex;
  const idle = clips.findIndex((clip) => /idle|standing/i.test(clip.name));
  return {
    walkClip: walk,
    idleClip: idle >= 0 ? idle : walk,
    strideM: family.baked.baked.clips[walk]?.strideLength ?? 1.4,
    heightVariation,
  };
}

/**
 * Humans and robots on the pedestrian graph: the city simulation runs in a worker (shared-memory
 * records + dirty ring), and the Stage 0 GPU crowd (Path B) dead-reckons them along the sim
 * graph's straight segments.
 */
export async function startCrowd(
  renderer: WebGPURenderer,
  scene: Scene,
  files: NavTileFiles,
  graph: SimGraph,
  options: CrowdOptions,
  progress: (message: string) => void,
): Promise<CrowdLayer> {
  const families = await loadFamilies(options, progress);
  const human = families[0];
  const robot = families[families.length - 1];
  progress('Baking impostors…');
  const crowdFamilies = prepareCrowdFamilies(renderer, families, true, new MetricsBus());
  const hiZ = options.occluderLayer === undefined ? undefined : createHiZ(options.occluderLayer);
  const crowd: GpuCrowd = createGpuCrowd({
    ...(hiZ === undefined ? {} : { occlusion: hiZ }),
    capacity: Math.max(1024, 2 ** Math.ceil(Math.log2(Math.max(1, options.agents)))),
    families: crowdFamilies,
    scene,
    edgeCapacity: graph.edgeCount,
    edgeEnd: 'clamp',
    // Plan §17: robots' LOD0 is expensive, so only a handful at once; humans get generous caps.
    lodCaps: (family) => {
      const override = options.lodCapOverride;
      if (override !== undefined) return [override, override, override, override, override];
      return family.robot ? [8, 64, 1024] : [96, 1024, 8192];
    },
  });
  crowd.setEdges(packGpuEdges(graph), packGpuEdgeHeights(graph));
  crowd.uniforms.minPx.value = options.minPx;
  applyLodControls(crowd, {
    forced: null,
    impostors: true,
    preset: options.lodPreset,
    debugColours: false,
    fade: true,
    fadeMs: LOD_FADE_MS,
  });

  progress(`Starting the simulation (${options.agents.toLocaleString()} agents)…`);
  let simMs = 0;
  let timeScale = 1;
  const sim = new SimWorkerClient(
    files,
    {
      agents: options.agents,
      robotShare: options.robotShare,
      seed: options.seed,
      human: kindAnimation(human, HUMAN_HEIGHT_VARIATION),
      robot: kindAnimation(robot, 0),
      humanVariants: families.length - 1,
      ...(options.humanShares === undefined ? {} : { humanShares: options.humanShares }),
      avoidance: true,
      firstRoofEdge: options.firstRoofEdge,
      roofShare: options.roofShare,
      ...(options.roofZone === undefined ? {} : { roofZone: options.roofZone }),
      population: options.population,
      startHour: options.startHour,
      showcase: options.showcase,
      ...(options.scale === undefined ? {} : { scale: options.scale }),
      ...(options.areas === undefined ? {} : { areas: options.areas }),
    },
    simMs,
    options.workers,
    // Occupancy is exchanged per nav edge.
    graph.firstSegment.length - 1,
  );
  await sim.ready;
  crowd.setCount(options.agents);
  let uploaded = 0;
  const held = new HeldRecords(options.agents);
  const position = new Vector3();
  /** Writes where an agent is now (Three coordinates) into `out`; false if aggregated or gone. */
  const positionInto = (agent: number, out: Vector3): boolean => {
    if (agent < 0 || agent >= options.agents) return false;
    const view = sim.records;
    const base = agent * AGENT_RECORD_BYTES;
    const flags = view.getUint8(base + AgentRecordOffset.Flags);
    const half = view.getUint32(base + AgentRecordOffset.HalfEdge, true);
    // Aggregated agents have no position.
    if ((flags & AgentFlag.Hidden) !== 0) return false;
    const e = half >>> 1;
    if (e >= graph.edgeCount) return false;
    const s0 = view.getFloat32(base + AgentRecordOffset.S0, true);
    const t0 = view.getUint32(base + AgentRecordOffset.T0, true);
    const speed = view.getUint16(base + AgentRecordOffset.Speed, true);
    const length = graph.edgeLength[e] ?? 1;
    const s = Math.min(length, s0 + (speed * Math.max(0, simMs - t0)) / 1_000_000);
    const along = (half & 1) === 1 ? length - s : s;
    const from = graph.edgeFrom[e] ?? 0;
    const to = graph.edgeTo[e] ?? 0;
    const heading = graph.edgeHeading[e] ?? 0;
    const y0 = graph.nodeY[from] ?? 0;
    const y1 = graph.nodeY[to] ?? 0;
    out.set(
      (graph.nodeX[from] ?? 0) + Math.sin(heading) * along,
      y0 + ((y1 - y0) * along) / Math.max(0.001, length),
      (graph.nodeZ[from] ?? 0) + Math.cos(heading) * along,
    );
    return true;
  };

  const cpu: number[] = [];

  // Budget control (§17): visible triangles from an asynchronous stats readback steer lodBias.
  const trianglesPerBucket = families.flatMap((family) => [
    ...(family.lodChain?.triangles ?? []),
    2, // impostor quad
  ]);
  const budget = options.triangleBudget ?? 10_000_000;
  let lodBias = 1;
  let visibleTriangles = 0;
  let visibleAgents = 0;
  let lastReadback = 0;
  let readbackPending = false;
  const readVisible = () => {
    const now = performance.now();
    if (readbackPending || now - lastReadback < 250) return;
    readbackPending = true;
    lastReadback = now;
    void renderer
      .getArrayBufferAsync(crowd.stats)
      .then((buffer) => {
        const counts = new Uint32Array(buffer);
        let triangles = 0;
        for (let b = 0; b < families.length * BUCKETS_PER_FAMILY; b++)
          triangles += (counts[b] ?? 0) * (trianglesPerBucket[b] ?? 0);
        visibleTriangles = triangles;
        visibleAgents = counts[families.length * BUCKETS_PER_FAMILY] ?? 0;
        // Over budget: coarser, quickly; well under: back towards 1, slowly.
        if (triangles > budget) lodBias = Math.max(0.25, lodBias * 0.85);
        else if (triangles < budget * 0.7) lodBias = Math.min(1, lodBias * 1.05);
        crowd.uniforms.lodBias.value = lodBias;
      })
      .catch(() => {
        // Device lost or crowd disposed mid-readback; the next readback recovers.
      })
      .finally(() => {
        readbackPending = false;
      });
  };

  return {
    frame(camera, drawingBufferHeight, dtMs, focus) {
      const begin = performance.now();
      // Drawn time follows real time but never passes what every worker has reached: agents
      // dead-reckon only to their next event, so drawing further would stall them at edge ends,
      // walking in place. The workers are asked to run a little ahead.
      simMs = Math.min(simMs + Math.min(dtMs, 100) * timeScale, sim.reachedMs());
      sim.setFocus(focus.x, focus.z);
      sim.setTime(simMs + SIM_LEAD_MS * Math.max(1, timeScale));
      // The workers run ahead of the drawn time; a record from ahead is held until the drawn time
      // reaches its t0, so the GPU never draws an agent's next segment before it starts.
      const { ids, count } = sim.drain();
      held.add(sim.records, ids, count);
      const ready = held.release(simMs);
      crowd.writeRecords(held.staged, ready.ids, ready.count);
      uploaded = ready.count;
      updateCrowdView(crowd, camera, drawingBufferHeight, simMs);
      // Occlusion pays among buildings at street level; from high above it hides little and its
      // depth prepass over every tile is the largest main-thread cost, so it switches off there.
      if (hiZ !== undefined) {
        hiZ.setActive(camera.position.y < OCCLUSION_MAX_HEIGHT_M);
        hiZ.update(renderer, scene, camera);
      }
      void renderer.compute(crowd.passes);
      readVisible();
      cpu.push(performance.now() - begin);
      if (cpu.length > 120) cpu.shift();
    },
    setRoofArea(area) {
      // Tile (x, y) → Three (x, −y): the box's z range is −maxY … −minY.
      if (area === null) crowd.uniforms.roofArea.value.set(-1e9, -1e9, 1e9, 1e9);
      else crowd.uniforms.roofArea.value.set(area.minX, -area.maxY, area.maxX, -area.minY);
    },
    setFollow(agent) {
      sim.setFollow(agent);
    },
    pickFollow: (kind) => sim.pickFollow(kind),
    agentPosition: (agent) => (positionInto(agent, position) ? position : null),
    pickAgent(viewProjection, ndcX, ndcY, width, height, maxPx) {
      const p = new Vector3();
      const e = viewProjection.elements;
      let best = -1;
      let bestPx = maxPx;
      let bestDepth = Infinity;
      for (let agent = 0; agent < options.agents; agent++) {
        if (!positionInto(agent, p)) continue;
        // The body's middle, a metre up.
        const x = p.x;
        const y = p.y + 0.9;
        const z = p.z;
        const w = e[3] * x + e[7] * y + e[11] * z + e[15];
        if (w <= 0) continue;
        const cx = (e[0] * x + e[4] * y + e[8] * z + e[12]) / w;
        const cy = (e[1] * x + e[5] * y + e[9] * z + e[13]) / w;
        const px = Math.hypot(((cx - ndcX) * width) / 2, ((cy - ndcY) * height) / 2);
        // The nearest on screen; among those within a few pixels of each other, the closest one.
        if (px < bestPx - 4 || (px < bestPx + 4 && px <= maxPx && w < bestDepth)) {
          best = agent;
          bestPx = Math.min(bestPx, px);
          bestDepth = w;
        }
      }
      return best < 0 ? null : { agent: best, px: bestPx };
    },
    agents: options.agents,
    families: () => families,
    advance(dtMs, focus) {
      simMs = Math.min(simMs + Math.min(dtMs, 100) * timeScale, sim.reachedMs());
      sim.setFocus(focus.x, focus.z);
      sim.setTime(simMs + SIM_LEAD_MS * Math.max(1, timeScale));
      const { ids, count } = sim.drain();
      held.add(sim.records, ids, count);
      const ready = held.release(simMs);
      // Kept current on the GPU too, so the WebGPU crowd is right when drawing resumes.
      crowd.writeRecords(held.staged, ready.ids, ready.count);
    },
    agentPose(agent, out) {
      if (!positionInto(agent, position)) return false;
      const view = sim.records;
      const base = agent * AGENT_RECORD_BYTES;
      const kind = view.getUint8(base + AgentRecordOffset.Kind);
      const half = view.getUint32(base + AgentRecordOffset.HalfEdge, true);
      const e = half >>> 1;
      const yaw = (graph.edgeHeading[e] ?? 0) + ((half & 1) === 1 ? Math.PI : 0);
      // Lane offset: 2 cm steps, positive to the right of the walking direction.
      const lateral = view.getInt8(base + AgentRecordOffset.Lateral) * 0.02;
      const robot = (kind & AGENT_KIND_ROBOT_BIT) !== 0;
      const family = robot
        ? families.length - 1
        : Math.min(families.length - 2, kind & AGENT_KIND_VARIANT_MASK);
      if (family < 0 || family >= families.length) return false;
      const clips = families[family].baked.baked.clips;
      if (clips.length === 0) return false;
      const anim = view.getUint8(base + AgentRecordOffset.Anim);
      const clip = clips[anim < clips.length ? anim : 0];
      const phase0 = view.getUint16(base + AgentRecordOffset.Phase0, true) / 65536;
      const speed = view.getUint16(base + AgentRecordOffset.Speed, true);
      // Walking: the cycle follows the distance walked; standing: the clip plays in time.
      let cycle: number;
      if (speed > 0 && clip.strideLength > 0) {
        const s0 = view.getFloat32(base + AgentRecordOffset.S0, true);
        const t0 = view.getUint32(base + AgentRecordOffset.T0, true);
        const s = s0 + (speed * Math.max(0, simMs - t0)) / 1_000_000;
        cycle = phase0 + s / clip.strideLength;
      } else cycle = phase0 + simMs / 1000 / Math.max(0.1, clip.duration);
      cycle -= Math.floor(cycle);
      const f = cycle * clip.frameCount;
      const i0 = Math.floor(f) % clip.frameCount;
      const looped = (clip.flags & 1) !== 0;
      const i1 = looped ? (i0 + 1) % clip.frameCount : Math.min(clip.frameCount - 1, i0 + 1);
      out.x = position.x - Math.cos(yaw) * lateral;
      out.y = position.y;
      out.z = position.z + Math.sin(yaw) * lateral;
      out.yaw = yaw;
      out.family = family;
      out.frame0 = clip.firstFrame + i0;
      out.frame1 = clip.firstFrame + i1;
      out.alpha = f - Math.floor(f);
      return true;
    },
    agentInfo(agent) {
      if (agent < 0 || agent >= options.agents) return null;
      const view = sim.records;
      const base = agent * AGENT_RECORD_BYTES;
      const kind = view.getUint8(base + AgentRecordOffset.Kind);
      const flags = view.getUint8(base + AgentRecordOffset.Flags);
      const half = view.getUint32(base + AgentRecordOffset.HalfEdge, true);
      const e = half >>> 1;
      // Edge heading is 0 along +Z (south); reversed when walked backwards.
      const heading = (graph.edgeHeading[e] ?? 0) + ((half & 1) === 1 ? Math.PI : 0);
      return {
        robot: (kind & AGENT_KIND_ROBOT_BIT) !== 0,
        humanModel: kind & AGENT_KIND_VARIANT_MASK,
        indoor: (flags & AgentFlag.Hidden) !== 0,
        roof: (flags & AgentFlag.Roof) !== 0,
        speedMps: view.getUint16(base + AgentRecordOffset.Speed, true) / 1000,
        headingRad: (((Math.PI - heading) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI),
      };
    },
    setTimeScale(scale) {
      timeScale = scale;
      sim.setRunning(scale > 0);
    },
    stats() {
      const latest = sim.latestStats;
      if (latest === null) return null;
      return {
        agents: options.agents,
        walking: latest.stats.walking,
        waiting: latest.stats.waiting,
        indoor: latest.stats.indoor,
        simSeconds: latest.simMs / 1000,
        nearTier: latest.stats.nearTier,
        tablesBuilt: latest.stats.tablesBuilt,
        workerMsPerSimSecond: latest.tickMsPerSimSecond,
        barrierMsPerSimSecond: latest.barrierMsPerSimSecond,
        recordsPerSecond: latest.recordsPerSecond,
        uploaded,
        visibleTriangles,
        visibleAgents,
        lodBias,
        population: latest.population,
        onRoof: latest.stats.onRoof,
        aggregated: latest.stats.indoor,
        rows: options.agents - latest.stats.freeRows,
        timeOfDayMs: latest.stats.timeOfDayMs,
        blockedEmissions: latest.stats.blockedEmissions,
        follow: latest.follow,
        frameCpuMs: cpu.reduce((a, b) => a + b, 0) / Math.max(1, cpu.length),
        frameCpuMaxMs: Math.max(0, ...cpu),
      };
    },
    dispose() {
      sim.dispose();
      crowd.dispose();
      hiZ?.dispose();
    },
  };
}

/**
 * Records the workers published for times the renderer has not drawn yet, in arrival order, and a
 * staged copy of every agent's record as the GPU should show it now. An agent may be held more
 * than once (several events inside the lead); they are released in order, oldest first.
 */
class HeldRecords {
  readonly staged: DataView;
  private readonly stagedWords: Uint32Array;
  private ids = new Uint32Array(1 << 16);
  private words = new Uint32Array((1 << 16) * RECORD_WORDS);
  private count = 0;
  private readyIds = new Uint32Array(1 << 16);

  constructor(agents: number) {
    const buffer = new ArrayBuffer(Math.max(1, agents) * AGENT_RECORD_BYTES);
    this.staged = new DataView(buffer);
    this.stagedWords = new Uint32Array(buffer);
  }

  add(records: DataView, ids: Uint32Array, count: number): void {
    const source = new Uint32Array(records.buffer, records.byteOffset, records.byteLength >>> 2);
    if (this.count + count > this.ids.length) {
      const size = 2 ** Math.ceil(Math.log2(this.count + count));
      const grownIds = new Uint32Array(size);
      grownIds.set(this.ids.subarray(0, this.count));
      const grownWords = new Uint32Array(size * RECORD_WORDS);
      grownWords.set(this.words.subarray(0, this.count * RECORD_WORDS));
      this.ids = grownIds;
      this.words = grownWords;
    }
    for (let i = 0; i < count; i++) {
      const id = ids[i];
      this.ids[this.count] = id;
      this.words.set(
        source.subarray(id * RECORD_WORDS, (id + 1) * RECORD_WORDS),
        this.count * RECORD_WORDS,
      );
      this.count++;
    }
  }

  /** Moves every held record whose t0 has been reached into `staged`; returns their agents. */
  release(drawnMs: number): { ids: Uint32Array; count: number } {
    if (this.readyIds.length < this.count) this.readyIds = new Uint32Array(this.ids.length);
    let ready = 0;
    let kept = 0;
    for (let k = 0; k < this.count; k++) {
      const at = k * RECORD_WORDS;
      const t0 = this.words[at + T0_WORD];
      const id = this.ids[k];
      if (t0 <= drawnMs) {
        this.stagedWords.set(this.words.subarray(at, at + RECORD_WORDS), id * RECORD_WORDS);
        this.readyIds[ready++] = id;
      } else {
        if (kept !== k) {
          this.ids[kept] = id;
          this.words.copyWithin(kept * RECORD_WORDS, at, at + RECORD_WORDS);
        }
        kept++;
      }
    }
    this.count = kept;
    return { ids: this.readyIds, count: ready };
  }
}

/** 32-bit words per agent record, and the word holding t0 (AGENT_RECORD layout). */
const RECORD_WORDS = AGENT_RECORD_BYTES / 4;
const T0_WORD = AgentRecordOffset.T0 / 4;
