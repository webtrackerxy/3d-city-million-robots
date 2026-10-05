import {
  AGENT_RECORD_BYTES,
  AgentFlag,
  AgentRecordOffset,
  type BuildingType,
  EdgeFlag,
  EdgeType,
  hash32,
  heightScaleFromSeed,
  NO_BUILDING,
  NodeType,
  packAgentKind,
} from '@city/core-types';
import type { NavTile } from '@city/formats';
import {
  edgeCosts,
  firstSimHalfEdge,
  NextHopTables,
  nextSimHalfEdge,
  PEDESTRIAN,
  ROBOT,
  type RouteProfile,
  Router,
  type RoutingGraph,
  routingGraphFromTile,
  type SimGraph,
} from '@city/nav';
import {
  DESTINATION_WEIGHT,
  type Period,
  PERIODS,
  periodOf,
  START_WALKING,
  STAY_MINUTES,
} from './demand.ts';
import { TimingWheel } from './timing-wheel.ts';

/**
 * Stage 1 crowd on the real pedestrian graph (implementation plan §15, milestone M4).
 *
 * Agents walk between building entrances, go indoors for a while, and set off again. Routing is
 * by next-hop tables (one per destination and profile, built lazily): an agent carries only its
 * destination and looks up its next edge at each junction.
 * Everything is event-driven on the straight segments of the sim graph: an agent costs nothing
 * between segment ends, where its 24-byte record changes (valid from the exact event time, so the
 * GPU dead reckoning stays continuous). On top of that:
 *
 * - lanes: `clamp(floor(width / 0.75), 1, 4)` per edge, chosen at edge entry with a keep-left
 *   bias and ±0.15 m jitter;
 * - crossings: WALK → WAIT → CROSS; signalised ones run a fixed cycle with a per-crossing phase
 *   offset, others a short gap-acceptance wait (longer for implicit crossings);
 * - tiers (§19): agents within 150 m of the focus (leaving at 200 m) are T0 and run avoidance —
 *   walking agents closer than 0.7 m nudge each other sideways within their pavement, and drift
 *   to their lane when clear. Everyone else is T2: purely event-driven, lane changes instant;
 * - density speed (the plan's T1 behaviour, event-driven): each nav edge counts its agents, and
 *   an agent's speed on entering an edge follows Weidmann's fundamental diagram.
 *
 * Buildings (§19):
 *
 * - every building is a T3 aggregate: an agent reaching its entrance collapses into the
 *   building's count (its row is freed; its seed joins the building's cold list, so it keeps its
 *   identity), and buildings emit agents back out at a rate proportional to their count. Rows +
 *   aggregates always add up to the population;
 * - roofs: a share of the people walking at the start walk on roof walks instead (appendRoofs),
 *   for good. A roof walk is an island: its walkers wander it, turning at random at each corner
 *   and now and then standing for a few seconds, and never come down; nobody else goes up.
 *
 * Determinism: integer ms, a fixed tick, per-agent xorshift streams (no Math.random, no wall
 * clock), and avoidance that reads a snapshot of all positions before writing any.
 */
export const AgentState = {
  Walk: 0,
  /** At the kerb of a crossing, waiting for the signal or a gap. */
  Wait: 1,
  /** Collapsed into an unobserved building's aggregate: the row is free. */
  Indoor: 2,
  /** Standing still for a moment at a corner of a roof walk. */
  Pause: 3,
} as const;
export type AgentState = (typeof AgentState)[keyof typeof AgentState];

/** What the simulation needs to know about one kind of agent's animation. */
export interface KindAnimation {
  /** Clip ids in the renderer's clip table for the kind's family. */
  walkClip: number;
  idleClip: number;
  /** Stride of the walk clip at scale 1, metres per cycle (keeps the cycle continuous). */
  strideM: number;
  /** Height variation the renderer applies (0 for robots). */
  heightVariation: number;
}

export interface CitySimulationOptions {
  tile: NavTile;
  graph: SimGraph;
  agents: number;
  /** Share of agents that are robots, 0–1. */
  robotShare: number;
  seed: number;
  human: KindAnimation;
  robot: KindAnimation;
  /** Human base meshes the renderer has (record variant bits). */
  humanVariants: number;
  /** Relative share of each human base mesh (length humanVariants); default equal. */
  humanShares?: number[];
  /** Record output, indexed by agent id (capacity ≥ agents). */
  records: DataView;
  startMs?: number;
  /** Fixed simulation tick: events are processed and T0 avoidance runs once per tick. */
  tickMs?: number;
  avoidance?: boolean;
  /** Initial T0 focus (Three coordinates); none = no T0 until setFocus. */
  focus?: { x: number; z: number } | undefined;
  /** Called whenever an agent starts along a nav half-edge (instrumentation, benchmarks). */
  onEnterEdge?: (agent: number, navHalf: number) => void;
  /** Edges from this id on are roof walks (buildings package); outdoor routing never uses them. */
  firstRoofEdge?: number;
  /**
   * Share of the people walking at the start who walk on roofs instead, 0–1 (default 0). Taken
   * of the street walkers expected within `roofZone`, so the share holds where the roofs are.
   */
  roofShare?: number;
  /** Where the roof walks are (tile frame, as given to appendRoofs); default the whole region. */
  roofZone?: { minX: number; minY: number; maxX: number; maxY: number };
  /**
   * People in the region, at least `agents` (the rows). Everyone without a row is inside a
   * building's aggregate — stations' aggregates are the people beyond the region.
   */
  population?: number;
  /** Time of day at sim time 0, hours (default 8). */
  startHour?: number;
  /** Share of the population walking at the start; default by time of day (demand model). */
  startWalkingShare?: number;
  /**
   * Showcase: nobody goes indoors — on reaching a destination an agent sets off for the next.
   * Everyone stays on the streets (the demand model still picks destinations).
   */
  stayOutdoors?: boolean;
  /**
   * Trips go to entrances within this straight-line distance of where they start (default: the
   * whole region). Next-hop tables then only cover a walk around their destination, which is what
   * lets a 20 km city fit: see NextHopTables' `maxCost`.
   */
  tripRadiusM?: number;
  /** Size of a destination cluster (default 200 m); larger clusters mean fewer tables. */
  clusterM?: number;
  /** Byte budget of each profile's next-hop table cache (default: count-capped only). */
  tableBytes?: number;
  /**
   * The strip of the region (tile x, metres) whose entrances and streets this simulation uses —
   * a partition's own area, so each worker caches tables for its area only. Default: all.
   */
  area?: { minX: number; maxX: number };
}

/** Which agents the follow camera may pick. */
export type FollowKind = 'human' | 'robot';

export interface CityStats {
  walking: number;
  waiting: number;
  /** In buildings (aggregates, no rows). */
  indoor: number;
  /** On roof walks (walking or standing); not counted in `walking`. */
  onRoof: number;
  /** Rows free for emission (equals `indoor`: every aggregate agent freed one). */
  freeRows: number;
  /** Emissions that waited for a free row. */
  blockedEmissions: number;
  timeOfDayMs: number;
  collapses: number;
  emissions: number;
  events: number;
  /** Next-hop tables built so far (both profiles). */
  tablesBuilt: number;
  lateralChanges: number;
  /** Agents in the near tier (T0) at the last tick. */
  nearTier: number;
}

/** 30 Hz: the T0 rate (§19); events are handled at this granularity too. */
const TICK_MS = 33;
/** T0 radius around the focus, and the larger radius at which agents leave it (hysteresis). */
const NEAR_ENTER_M = 150;
const NEAR_LEAVE_M = 200;
/** Weidmann's fundamental diagram: jam density (p/m²) and shape constant. */
const JAM_DENSITY = 5.4;
const WEIDMANN_GAMMA = 1.913;
/** Speed never drops below this share of free speed (the crowd creeps, it does not freeze). */
const MIN_SPEED_SHARE = 0.15;
const LANE_M = 0.75;
const LANE_JITTER_M = 0.15;
/** Keep-left weights for lane 0 (leftmost) … 3. */
const LANE_WEIGHTS = [0.45, 0.3, 0.17, 0.08];
const SIGNAL_CYCLE_MS = 60_000;
const SIGNAL_GREEN_MS = 12_000;
/** A pedestrian does not start crossing with less green left than this. */
const SIGNAL_MIN_GREEN_MS = 4_000;
/** Share of roof-walk corners where a roof walker stands for a moment, and for how long. */
const ROOF_PAUSE_SHARE = 0.2;
const ROOF_PAUSE_MS: readonly [number, number] = [2_000, 10_000];
/** Crossing queues: first row this far back from the kerb, rows this far apart (m). */
const QUEUE_KERB_M = 0.3;
const QUEUE_ROW_M = 0.65;
/** Deeper rows stand in the last one (a crowd bigger than this spills over, rarely seen). */
const QUEUE_MAX_ROWS = 12;
/** Each row starts this much later than the one in front when the crossing clears. */
const QUEUE_ROW_DELAY_MS = 400;
/** Speed on steps relative to the flat. */
const STEPS_SPEED = 0.55;
/** Destination clusters: entrances grouped in cells this size share a next-hop table. */
const CLUSTER_M = 200;
/** Cells of the local destination picker (`tripRadiusM`). */
const TRIP_CELL_M = 250;
/**
 * Bounded next-hop tables reach this multiple of the trip radius in routing cost (detours,
 * crossing penalties), plus a cluster's diagonal.
 */
const TABLE_REACH = 1.8;
/** Within this straight-line distance of the destination, a last-mile A* takes over. */
const LAST_MILE_M = 200;
/** A last-mile route costing more than this is given up (routing cost, metres-equivalent). */
const LAST_MILE_MAX_COST = 3000;
const AVOID_RADIUS = 0.7;
const HASH_CELL = 2;
/** Lateral step per tick while avoiding, 2 cm units (0.2 m/s sideways at 10 Hz). */
const LATERAL_STEP = 1;
/** Agents stay this far inside the pavement edge. */
const KERB_MARGIN_M = 0.3;

export class CitySimulation {
  readonly agents: number;
  readonly graph: SimGraph;
  readonly tile: NavTile;
  private readonly records: DataView;
  private readonly tickMs: number;
  private readonly avoidance: boolean;
  private readonly wheel: TimingWheel;
  /** Next-hop tables per destination cluster, and A* for the last stretch. */
  private readonly hops: { human: NextHopTables; robot: NextHopTables };
  private readonly lastMile: { human: Router; robot: Router };
  private readonly clusterOf: Int32Array;
  /** Connected component of every node, per profile (robots avoid steps). */
  private readonly component: { human: Int32Array; robot: Int32Array };
  /** Agents queued for each crossing (nav half-edge): the next arrival's queue slot. */
  private readonly queues = new Map<number, number>();
  /** Per agent: the crossing it queues for (−1 none), where it stops, when its row may go. */
  private readonly queuedFor: Int32Array;
  private readonly queueStop: Float32Array;
  private readonly queueRelease: Float64Array;
  /** Per agent: a crossing it has queued for, walked onto without waiting again (−1 none). */
  private readonly cleared: Int32Array;
  /** Guards the re-plan in continueOutdoor against recursing without end. */
  private replanning = 0;
  private readonly clusterM: number;
  private readonly tripRadiusM: number;
  /** Local picker: entrance-index range of each trip cell (entrances are sorted by cell). */
  private readonly tripCells = new Map<number, { start: number; end: number }>();
  private cellScratch = {
    start: new Int32Array(0),
    end: new Int32Array(0),
    cum: new Float64Array(0),
  };
  /** Edges agents may be placed on mid-trip, per kind (within `area`). */
  private readonly humanEdges: Uint32Array;
  private readonly clusterSources = new Map<number, Uint32Array>();
  /** Robots may not use every edge (steps): robot-usable outdoor nav edges, for spawning. */
  private readonly robotEdges: Uint32Array;
  private readonly outdoorEdges: number;
  /** Agents on each nav edge (walking or waiting), for density speed. */
  private readonly occupancy: Uint16Array;
  private focusX = 0;
  private focusZ = 0;
  private hasFocus = false;
  private readonly entrances: Uint32Array;
  /** Cumulative entrance weights per period (capacity × demand weight), for destination choice. */
  private readonly entranceWeights: Float64Array[];
  private readonly dayOffsetMs: number;
  private period: Period;
  private readonly entrancesOf = new Map<number, number[]>();
  private readonly kinds: { human: KindAnimation; robot: KindAnimation };
  private readonly robotShare: number;
  private readonly humanVariants: number;
  /** Cumulative human variant shares, normalised to end at 1; null = equal (h % variants). */
  private readonly humanCumulative: Float64Array | null;
  private tickTime: number;
  /** True while the wheel is draining: events then chain in place instead of being filed. */
  private draining = false;
  private readonly onEnterEdge: ((agent: number, navHalf: number) => void) | undefined;

  // Buildings.
  private readonly aggregate: Uint32Array;
  private readonly cold = new Map<number, number[]>();
  private readonly buildingRng: Uint32Array;
  private readonly emissionPending: Uint8Array;
  private heapTime: Float64Array = new Float64Array(64);
  private heapBuilding: Uint32Array = new Uint32Array(64);
  private heapSize = 0;
  private readonly freeRows: Int32Array;
  private freeCount = 0;
  private readonly stayOutdoors: boolean;
  // Roofs.
  /** Roof-walk nav edges within `area`, and their running total length (for spawning). */
  private readonly roofEdges: Uint32Array;
  private readonly roofLength: Float64Array;
  /** Rows that walk on roofs: the share of the walkers expected in the roof zone. */
  private readonly roofShare: number;
  /** Share of this simulation's street length (by edge) that lies in the roof zone. */
  private readonly roofZoneShare: number;
  private externalOccupancy: Uint16Array | null = null;

  // Per-agent state (worker-private; the renderer sees only the records).
  private readonly navHalf: Int32Array;
  private readonly simHalf: Uint32Array;
  private readonly s0: Float32Array;
  private readonly t0: Uint32Array;
  private readonly speed: Uint16Array;
  private readonly walkSpeed: Uint16Array;
  /** Speed on the current nav edge (free speed × density factor at entry). */
  private readonly edgeSpeed: Uint16Array;
  private readonly near: Uint8Array;
  private readonly nextEvent: Uint32Array;
  private readonly inWheel: Uint8Array;
  private readonly state: Uint8Array;
  private readonly lateral: Int8Array;
  private readonly laneTarget: Int8Array;
  private readonly laneLimit: Uint8Array;
  private readonly robot: Uint8Array;
  private readonly variant: Uint8Array;
  private readonly seedOf: Uint32Array;
  private readonly rng: Uint32Array;
  private readonly anim: Uint8Array;
  private readonly phase0: Uint16Array;
  private readonly scale: Float32Array;
  /** Outdoor target: an entrance node. On a roof: the corner a pausing walker stands at. */
  private readonly dest: Uint32Array;
  /** Last-mile route (region half-edges) being followed, and the position in it. */
  private readonly route: (Uint32Array | null)[];
  private readonly routePos: Uint32Array;
  /** 1 for a roof walker (for good). */
  private readonly roof: Uint8Array;
  private readonly dirtyFlag: Uint8Array;
  private readonly dirty: Uint32Array;
  private dirtyCount = 0;
  private readonly stats: CityStats = {
    walking: 0,
    waiting: 0,
    indoor: 0,
    onRoof: 0,
    freeRows: 0,
    blockedEmissions: 0,
    timeOfDayMs: 0,
    collapses: 0,
    emissions: 0,
    events: 0,
    tablesBuilt: 0,
    lateralChanges: 0,
    nearTier: 0,
  };
  // Avoidance scratch.
  private px: Float32Array;
  private pz: Float32Array;
  private fx: Float32Array;
  private fz: Float32Array;
  private readonly walkers: Uint32Array;
  private next: Int32Array;
  private readonly heads: Int32Array;

  constructor(options: CitySimulationOptions) {
    const { tile, graph, agents } = options;
    this.agents = agents;
    this.graph = graph;
    this.tile = tile;
    this.records = options.records;
    if (this.records.byteLength < agents * AGENT_RECORD_BYTES)
      throw new RangeError('Record buffer smaller than the population');
    this.tickMs = options.tickMs ?? TICK_MS;
    this.stayOutdoors = options.stayOutdoors ?? false;
    this.onEnterEdge = options.onEnterEdge;
    this.avoidance = options.avoidance ?? true;
    this.tickTime = options.startMs ?? 0;
    this.wheel = new TimingWheel(this.tickTime);
    this.kinds = { human: options.human, robot: options.robot };
    this.robotShare = options.robotShare;
    this.humanVariants = Math.max(1, options.humanVariants);
    this.humanCumulative = cumulativeShares(options.humanShares, this.humanVariants);
    const edgeCount = tile.edges.from.length;
    this.outdoorEdges = Math.min(edgeCount, options.firstRoofEdge ?? edgeCount);

    // Outdoor routing never goes over a roof.
    const outdoor = (profile: RouteProfile) => {
      const costs = edgeCosts(tile, profile);
      costs.fill(Infinity, this.outdoorEdges);
      return costs;
    };
    const routing = routingGraphFromTile(tile);
    const humanCosts = outdoor(PEDESTRIAN);
    const robotCosts = outdoor(ROBOT);
    this.component = {
      human: connectedComponents(routing, humanCosts),
      robot: connectedComponents(routing, robotCosts),
    };
    this.clusterM = options.clusterM ?? CLUSTER_M;
    this.tripRadiusM = options.tripRadiusM ?? Infinity;
    const reach =
      this.tripRadiusM === Infinity
        ? Infinity
        : this.tripRadiusM * TABLE_REACH + this.clusterM * Math.SQRT2;
    const tableBytes = options.tableBytes ?? Infinity;
    this.hops = {
      human: new NextHopTables(routing, humanCosts, 4096, reach, tableBytes),
      robot: new NextHopTables(routing, robotCosts, 4096, reach, tableBytes),
    };
    this.lastMile = {
      human: new Router(routing, humanCosts),
      robot: new Router(routing, robotCosts),
    };
    const area = options.area ?? { minX: -Infinity, maxX: Infinity };
    const inArea = (n: number) => tile.nodes.x[n] >= area.minX && tile.nodes.x[n] < area.maxX;
    const robotEdges: number[] = [];
    const humanEdges: number[] = [];
    for (let e = 0; e < this.outdoorEdges; e++) {
      if (!inArea(tile.edges.from[e])) continue;
      humanEdges.push(e);
      if (robotCosts[e] !== Infinity) robotEdges.push(e);
    }
    this.robotEdges = Uint32Array.from(robotEdges);
    this.humanEdges = Uint32Array.from(humanEdges);
    const roofEdges: number[] = [];
    for (let e = this.outdoorEdges; e < edgeCount; e++)
      if (tile.edges.type[e] === EdgeType.Roof && inArea(tile.edges.from[e])) roofEdges.push(e);
    this.roofEdges = Uint32Array.from(roofEdges);
    let roofTotal = 0;
    this.roofLength = Float64Array.from(roofEdges, (e) => (roofTotal += tile.edges.length[e]));
    this.roofShare = roofEdges.length === 0 ? 0 : Math.min(1, Math.max(0, options.roofShare ?? 0));
    const zone = options.roofZone;
    let street = 0;
    let streetInZone = 0;
    for (const e of humanEdges) {
      const n = tile.edges.from[e];
      street += tile.edges.length[e];
      if (
        zone === undefined ||
        (tile.nodes.x[n] >= zone.minX &&
          tile.nodes.x[n] < zone.maxX &&
          tile.nodes.y[n] >= zone.minY &&
          tile.nodes.y[n] < zone.maxY)
      )
        streetInZone += tile.edges.length[e];
    }
    this.roofZoneShare = street > 0 ? streetInZone / street : 0;
    this.occupancy = new Uint16Array(edgeCount);
    if (options.focus !== undefined) this.setFocus(options.focus.x, options.focus.z);

    let entrances: number[] = [];
    for (let n = 0; n < tile.nodes.type.length; n++)
      if (tile.nodes.type[n] === NodeType.Entrance) {
        if (inArea(n)) entrances.push(n);
        const b = tile.nodes.buildingId[n];
        if (b !== NO_BUILDING) {
          const list = this.entrancesOf.get(b) ?? [];
          list.push(n);
          this.entrancesOf.set(b, list);
        }
      }
    if (entrances.length < 2) throw new Error('The tile needs at least two entrances');
    const cellOf = (n: number) =>
      (Math.floor(tile.nodes.x[n] / TRIP_CELL_M) + 2048) * 4096 +
      (Math.floor(tile.nodes.y[n] / TRIP_CELL_M) + 2048);
    if (this.tripRadiusM !== Infinity) {
      // Grouped by trip cell (stable, so the order within a cell is the graph's).
      entrances = entrances
        .map((n, i) => ({ n, i, cell: cellOf(n) }))
        .sort((a, b) => a.cell - b.cell || a.i - b.i)
        .map((e) => e.n);
      entrances.forEach((n, i) => {
        const cell = cellOf(n);
        const range = this.tripCells.get(cell);
        if (range === undefined) this.tripCells.set(cell, { start: i, end: i + 1 });
        else range.end = i + 1;
      });
      const side = 2 * Math.ceil(this.tripRadiusM / TRIP_CELL_M) + 1;
      this.cellScratch = {
        start: new Int32Array(side * side),
        end: new Int32Array(side * side),
        cum: new Float64Array(side * side),
      };
    }
    this.clusterOf = new Int32Array(tile.nodes.x.length).fill(-1);
    const members = new Map<number, number[]>();
    for (const n of entrances) {
      // Fits an i32 for regions up to ±400 km (2,048 cells of 200 m either way).
      const key =
        (Math.floor(tile.nodes.x[n] / this.clusterM) + 2048) * 4096 +
        (Math.floor(tile.nodes.y[n] / this.clusterM) + 2048);
      this.clusterOf[n] = key;
      const list = members.get(key) ?? [];
      list.push(n);
      members.set(key, list);
    }
    for (const [key, list] of members) this.clusterSources.set(key, Uint32Array.from(list));
    this.entrances = Uint32Array.from(entrances);
    this.entranceWeights = Array.from({ length: PERIODS }, (_, period) => {
      const weights = new Float64Array(entrances.length);
      let total = 0;
      entrances.forEach((node, i) => {
        const building = tile.nodes.buildingId[node];
        total +=
          building === NO_BUILDING
            ? 1
            : Math.max(1, tile.buildings.capacity[building]) *
              DESTINATION_WEIGHT[period][tile.buildings.type[building] as BuildingType];
        weights[i] = total;
      });
      return weights;
    });
    this.dayOffsetMs = Math.round((options.startHour ?? 8) * 3_600_000);
    this.period = periodOf(this.dayOffsetMs + this.tickTime);

    const buildingCount = tile.buildings.ringOffset.length;
    this.aggregate = new Uint32Array(buildingCount);
    this.buildingRng = Uint32Array.from(
      { length: buildingCount },
      (_, b) => hash32(b ^ options.seed) || 1,
    );
    this.emissionPending = new Uint8Array(buildingCount);

    this.navHalf = new Int32Array(agents).fill(-1);
    this.simHalf = new Uint32Array(agents);
    this.s0 = new Float32Array(agents);
    this.t0 = new Uint32Array(agents);
    this.speed = new Uint16Array(agents);
    this.walkSpeed = new Uint16Array(agents);
    this.edgeSpeed = new Uint16Array(agents);
    this.near = new Uint8Array(agents);
    this.nextEvent = new Uint32Array(agents);
    this.inWheel = new Uint8Array(agents);
    this.state = new Uint8Array(agents);
    this.lateral = new Int8Array(agents);
    this.laneTarget = new Int8Array(agents);
    this.laneLimit = new Uint8Array(agents);
    this.queuedFor = new Int32Array(agents).fill(-1);
    this.queueStop = new Float32Array(agents).fill(-1);
    this.queueRelease = new Float64Array(agents);
    this.cleared = new Int32Array(agents).fill(-1);
    this.robot = new Uint8Array(agents);
    this.variant = new Uint8Array(agents);
    this.seedOf = new Uint32Array(agents);
    this.rng = new Uint32Array(agents);
    this.anim = new Uint8Array(agents);
    this.phase0 = new Uint16Array(agents);
    this.scale = new Float32Array(agents);
    this.dest = new Uint32Array(agents);
    this.route = new Array<Uint32Array | null>(agents).fill(null);
    this.routePos = new Uint32Array(agents);
    this.roof = new Uint8Array(agents);
    this.freeRows = new Int32Array(agents);
    this.dirtyFlag = new Uint8Array(agents);
    this.dirty = new Uint32Array(agents);
    this.px = new Float32Array(agents);
    this.pz = new Float32Array(agents);
    this.fx = new Float32Array(agents);
    this.fz = new Float32Array(agents);
    this.walkers = new Uint32Array(agents);
    this.next = new Int32Array(agents);
    this.heads = new Int32Array(2 ** Math.ceil(Math.log2(Math.max(64, agents))));

    const population = Math.max(agents, options.population ?? agents);
    this.spawn(options.seed, population, options.startWalkingShare);
    if (this.population !== population)
      throw new Error(`Spawned ${this.population} people, expected ${population}`);
    this.classifyTiers();
  }

  get now(): number {
    return this.tickTime;
  }

  /** Total population: agents with rows plus agents aggregated in buildings. Constant. */
  get population(): number {
    let aggregated = 0;
    for (const count of this.aggregate) aggregated += count;
    return this.agents - this.freeCount + aggregated;
  }

  /**
   * Memory held by the simulation, bytes (plan §21 audit): per-row state, the timing wheel's
   * links, the cold identity store of aggregated people, and the routing tables.
   */
  memoryReport(): {
    rowBytes: number;
    perRow: number;
    coldBytes: number;
    routingBytes: number;
    routeBytes: number;
  } {
    const perRow =
      4 * 6 + // navHalf, simHalf, s0, t0, nextEvent, dest
      2 * 5 + // speed, walkSpeed, edgeSpeed, phase0, routePos (as u16-equivalent)
      4 * 2 + // seed, rng
      1 * 11 + // near, inWheel, state, lateral, laneTarget, laneLimit, robot, variant, anim, roof, dirtyFlag
      4 + // scale
      4 * 2 + // dirty list, free rows
      4 * 5 + // avoidance scratch (px, pz, fx, fz, next)
      8; // route reference
    let cold = 0;
    for (const seeds of this.cold.values()) cold += seeds.length;
    let routeBytes = 0;
    for (const route of this.route) if (route !== null) routeBytes += route.byteLength;
    return {
      rowBytes: perRow * this.agents,
      perRow,
      coldBytes: cold * 8,
      routingBytes: this.hops.human.bytes + this.hops.robot.bytes,
      routeBytes,
    };
  }

  /** People inside building `b`'s aggregate. */
  aggregateOf(b: number): number {
    return this.aggregate[b];
  }

  /** The T0 focus, in Three coordinates (X = tile x, Z = −tile y). */
  setFocus(x: number, z: number): void {
    this.focusX = x;
    this.focusZ = z;
    this.hasFocus = true;
  }

  /** Runs whole ticks up to `nowMs`. Calling pattern does not change results. */
  advanceTo(nowMs: number): void {
    while (this.tickTime + this.tickMs <= nowMs) {
      const t = this.stepEvents();
      if (this.avoidance) this.avoid(t, null);
    }
  }

  /** Time the next tick will run at. */
  get nextTickMs(): number {
    return this.tickTime + this.tickMs;
  }

  /**
   * Runs the event half of one tick: period change, tiers, due events, building emissions.
   * Returns the tick's time. `advanceTo` = stepEvents + avoid; a partitioned (multi-worker) run
   * calls them separately to exchange occupancy and near-tier positions in between.
   */
  stepEvents(): number {
    {
      this.tickTime += this.tickMs;
      const t = this.tickTime;
      const period = periodOf(this.dayOffsetMs + t);
      if (period !== this.period) {
        // New period: every building's emission rate changes now, not at its next emission.
        this.period = period;
        this.heapSize = 0;
        this.emissionPending.fill(0);
        for (let b = 0; b < this.aggregate.length; b++) this.scheduleEmission(b, t);
      }
      this.classifyTiers();
      this.draining = true;
      this.wheel.advanceTo(t + 1, (agent) => {
        this.inWheel[agent] = 0;
        // Every event already due is handled now (short segments chain within one tick), so each
        // agent has at most one entry in the wheel; collapsed agents leave it.
        while (this.state[agent] !== AgentState.Indoor && this.nextEvent[agent] <= t) {
          this.stats.events++;
          this.onEvent(agent);
        }
        if (this.state[agent] !== AgentState.Indoor) {
          this.wheel.schedule(agent, this.nextEvent[agent]);
          this.inWheel[agent] = 1;
        }
      });
      this.draining = false;
      this.emit(t);
      return t;
    }
  }

  /** This simulation's agents per nav edge (for other partitions' density). */
  get occupancyCounts(): Uint16Array {
    return this.occupancy;
  }

  /** Other partitions' agents per nav edge (last tick), added to density; null = none. */
  setExternalOccupancy(counts: Uint16Array | null): void {
    this.externalOccupancy = counts;
  }

  /**
   * Writes the near tier's walking agents as (x, z, forward x, forward z) at time `t` into `out`
   * (at most `max`), for other partitions' avoidance. Returns how many.
   */
  nearPositions(t: number, out: Float32Array, max: number): number {
    const count = this.collectNear(t);
    const n = Math.min(count, max);
    for (let k = 0; k < n; k++) out.set([this.px[k], this.pz[k], this.fx[k], this.fz[k]], k * 4);
    return n;
  }

  /**
   * Writes the record of every agent that changed since the last flush and hands its id to
   * `consume` (for the upload ring). Returns how many.
   */
  flush(consume: (agent: number) => void): number {
    const count = this.dirtyCount;
    for (let i = 0; i < count; i++) {
      const agent = this.dirty[i];
      this.dirtyFlag[agent] = 0;
      this.writeRecord(agent);
      consume(agent);
    }
    this.dirtyCount = 0;
    return count;
  }

  snapshotStats(): CityStats {
    let walking = 0;
    let waiting = 0;
    let onRoof = 0;
    for (let a = 0; a < this.agents; a++) {
      const s = this.state[a];
      if (this.roof[a] === 1) onRoof++;
      else if (s === AgentState.Walk) walking++;
      else if (s === AgentState.Wait) waiting++;
    }
    let indoor = 0;
    for (const count of this.aggregate) indoor += count;
    return {
      ...this.stats,
      walking,
      waiting,
      indoor,
      onRoof,
      freeRows: this.freeCount,
      timeOfDayMs: (this.dayOffsetMs + this.tickTime) % 86_400_000,
      tablesBuilt: this.hops.human.builds + this.hops.robot.builds,
    };
  }

  /** FNV-1a over every agent's state and the aggregates, for determinism tests. */
  stateHash(): number {
    let h = 0x811c9dc5;
    const mix = (v: number) => {
      h = Math.imul(h ^ (v >>> 0), 0x01000193) >>> 0;
    };
    for (let a = 0; a < this.agents; a++) {
      mix(this.simHalf[a]);
      mix(Math.round(this.s0[a] * 1000));
      mix(this.t0[a]);
      mix(this.speed[a]);
      mix(this.nextEvent[a]);
      mix(this.state[a]);
      mix(this.lateral[a] & 0xff);
      mix(this.dest[a]);
      mix(this.roof[a]);
      mix(this.phase0[a]);
      mix(this.seedOf[a]);
    }
    for (const count of this.aggregate) mix(count);
    return h;
  }

  /** Current state of one agent (inspector, tests). */
  agentState(agent: number): {
    state: AgentState;
    navHalf: number;
    simHalf: number;
    dest: number;
    /** On a roof walk (for good). */
    roof: boolean;
    /** The building whose roof it is on, or −1. */
    building: number;
    robot: boolean;
    seed: number;
  } {
    const h = this.simHalf[agent];
    const roof = this.roof[agent] === 1;
    const navNode = this.tile.edges.from[this.graph.segmentEdge[h >>> 1]];
    const building = roof ? this.tile.nodes.buildingId[navNode] : NO_BUILDING;
    return {
      state: this.state[agent] as AgentState,
      navHalf: this.navHalf[agent],
      simHalf: h,
      dest: this.dest[agent],
      roof,
      building: building === NO_BUILDING ? -1 : building,
      robot: this.robot[agent] === 1,
      seed: this.seedOf[agent],
    };
  }

  /**
   * A roof walker for the follow camera, nearest the focus (any, without one); −1 if there is
   * none. `kind` limits it to people or to robots.
   */
  pickFollowCandidate(kind?: FollowKind): number {
    let best = -1;
    let bestSq = Infinity;
    for (let a = 0; a < this.agents; a++) {
      if (this.roof[a] === 0) continue;
      if (kind !== undefined && (this.robot[a] === 1) !== (kind === 'robot')) continue;
      if (!this.hasFocus) return a;
      const start = this.graph.edgeFrom[this.simHalf[a] >>> 1];
      const dx = this.graph.nodeX[start] - this.focusX;
      const dz = this.graph.nodeZ[start] - this.focusZ;
      if (dx * dx + dz * dz < bestSq) {
        best = a;
        bestSq = dx * dx + dz * dz;
      }
    }
    return best;
  }

  // --- lifecycle ----------------------------------------------------------------------------

  /**
   * The starting state: a share of the population on the streets (by time of day, one row each),
   * some of them on roofs instead, everyone else inside buildings, distributed by the previous
   * period's demand (at 08:00 people are where they slept: at home, or beyond the region at the
   * stations).
   */
  private spawn(seed: number, population: number, walkingShare: number | undefined): void {
    let rng = seed >>> 0 || 1;
    const random = () => {
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      return (rng >>> 0) / 4294967296;
    };
    const t = this.tickTime;
    const walking = Math.min(
      this.agents,
      Math.round(population * (walkingShare ?? START_WALKING[this.period])),
    );
    const onRoofs = Math.round(walking * this.roofShare * this.roofZoneShare);
    for (let a = 0; a < walking; a++) {
      this.assignIdentity(a, Math.floor(random() * 0x100000000) >>> 0);
      if (a < onRoofs) this.goOnRoof(a, random, t);
      else this.goWalkingFromAnywhere(a, random, t);
    }
    // Rows not walking are free; their people join the aggregates below.
    for (let a = this.agents - 1; a >= walking; a--) {
      if (this.state[a] === AgentState.Indoor && this.nextEvent[a] === 0xffffffff) continue;
      this.state[a] = AgentState.Indoor;
      this.nextEvent[a] = 0xffffffff;
      this.freeRows[this.freeCount++] = a;
      this.markDirty(a);
    }
    const before = this.entranceWeights[(this.period + PERIODS - 1) % PERIODS];
    const total = before[before.length - 1];
    // Everyone not walking — including walkers who found nowhere to go and collapsed already.
    let inside = population - this.population;
    while (inside > 0) {
      const r = random() * total;
      let lo = 0;
      let hi = before.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (before[mid] > r) hi = mid;
        else lo = mid + 1;
      }
      const building = this.tile.nodes.buildingId[this.entrances[lo]];
      if (building === NO_BUILDING) continue;
      this.aggregate[building]++;
      let seeds = this.cold.get(building);
      if (seeds === undefined) this.cold.set(building, (seeds = []));
      seeds.push(Math.floor(random() * 0x100000000) >>> 0);
      inside--;
    }
    for (let b = 0; b < this.aggregate.length; b++) this.scheduleEmission(b, t);
  }

  /**
   * Mid-trip outdoors: a random usable edge, heading for a reachable destination. An edge in a
   * fragment with no reachable entrance (for robots, pieces cut off by steps) is re-drawn a few
   * times before the agent collapses into a building.
   */
  private goWalkingFromAnywhere(a: number, random: () => number, t: number): void {
    const robot = this.robot[a] === 1;
    let e = 0;
    let from = 0;
    let to = 0;
    let dest = -1;
    for (let edgeTry = 0; edgeTry < 8 && dest < 0; edgeTry++) {
      e = robot
        ? this.robotEdges[Math.floor(random() * this.robotEdges.length)]
        : this.humanEdges[Math.floor(random() * this.humanEdges.length)];
      from = this.tile.edges.from[e];
      to = this.tile.edges.to[e];
      for (let attempt = 0; attempt < 4 && dest < 0; attempt++) {
        const candidate = this.pickEntrance(a, from);
        if (candidate !== from && this.canReach(a, from, candidate)) dest = candidate;
      }
      // As in startTripFrom: any other reachable entrance before trying another edge.
      const n = this.entrances.length;
      const start = Math.floor(random() * n);
      for (let k = 0; k < Math.min(n, 64) && dest < 0; k++) {
        const candidate = this.otherEntrance(a, from, start + k);
        if (candidate !== from && this.canReach(a, from, candidate)) dest = candidate;
      }
    }
    if (dest < 0) {
      const building = this.tile.nodes.buildingId[this.pickEntrance(a, from)];
      if (building !== NO_BUILDING) this.collapse(a, building, t);
      return;
    }
    this.dest[a] = dest;
    const forward = this.hopTowards(a, from) === e * 2 || to === dest;
    this.placeOnNavEdge(a, forward ? e * 2 : e * 2 + 1, random(), t);
  }

  /** Onto a roof walk for good: an edge by length, either way, anywhere along it. */
  private goOnRoof(a: number, random: () => number, t: number): void {
    const cumulative = this.roofLength;
    const r = random() * cumulative[cumulative.length - 1];
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cumulative[mid] > r) hi = mid;
      else lo = mid + 1;
    }
    this.roof[a] = 1;
    const e = this.roofEdges[lo];
    this.placeOnNavEdge(a, random() < 0.5 ? e * 2 : e * 2 + 1, random(), t);
  }

  private humanVariant(hash: number): number {
    const cumulative = this.humanCumulative;
    if (cumulative === null) return hash % this.humanVariants;
    const u = hash / 4294967296;
    for (let v = 0; v < cumulative.length - 1; v++) if (u < (cumulative[v] ?? 1)) return v;
    return cumulative.length - 1;
  }

  /** Everything an agent is follows from its seed: kind, model, speed, look, random stream. */
  private assignIdentity(a: number, seed: number): void {
    const h1 = hash32(seed ^ 0x9e3779b9);
    const h2 = hash32(h1);
    const h3 = hash32(h2);
    const robot = h1 / 4294967296 < this.robotShare;
    this.robot[a] = robot ? 1 : 0;
    this.variant[a] = robot ? 0 : this.humanVariant(h2);
    this.seedOf[a] = seed >>> 0;
    this.rng[a] = hash32(seed ^ 0x5bd1e995) || 1;
    const kind = robot ? this.kinds.robot : this.kinds.human;
    this.scale[a] = heightScaleFromSeed(seed, kind.heightVariation);
    // Humans 1.2–1.5 m/s, robots 1.35–1.5 with less spread (§15.6).
    const u = h3 / 4294967296;
    this.walkSpeed[a] = Math.round((robot ? 1.35 + u * 0.15 : 1.2 + u * 0.3) * 1000);
    this.phase0[a] = hash32(h3) & 0xffff;
  }

  private onEvent(agent: number): void {
    const t = this.nextEvent[agent];
    switch (this.state[agent]) {
      case AgentState.Wait: {
        const crossing = this.queuedFor[agent];
        if (crossing >= 0) {
          // Its row's turn: walk the rest of the approach and straight onto the crossing.
          this.queuedFor[agent] = -1;
          this.cleared[agent] = crossing;
          const waiting = (this.queues.get(crossing) ?? 1) - 1;
          if (waiting > 0) this.queues.set(crossing, waiting);
          else this.queues.delete(crossing);
          this.startSegment(agent, this.simHalf[agent], this.s0[agent], t, true);
          return;
        }
        this.startSegment(agent, firstSimHalfEdge(this.graph, this.navHalf[agent]), 0, t, true);
        return;
      }
      case AgentState.Pause:
        this.roofStep(agent, this.dest[agent], -1, t, false);
        return;
      case AgentState.Indoor:
        return;
      default: {
        if (this.queuedFor[agent] >= 0 && this.queueStop[agent] >= 0) {
          this.standInQueue(agent, t);
          return;
        }
        const next = nextSimHalfEdge(this.graph, this.simHalf[agent]);
        if (next >= 0) {
          this.startSegment(agent, next, 0, t, true);
          return;
        }
        const navHalf = this.navHalf[agent];
        const node =
          (navHalf & 1) === 0
            ? this.tile.edges.to[navHalf >>> 1]
            : this.tile.edges.from[navHalf >>> 1];
        this.leaveNavEdge(agent);
        if (this.roof[agent] === 1) {
          this.roofStep(agent, node, navHalf, t, true);
          return;
        }
        if (this.route[agent] !== null) {
          this.routePos[agent]++;
          this.followRoute(agent, t);
          return;
        }
        this.continueOutdoor(agent, node, t);
      }
    }
  }

  /**
   * At a corner of a roof walk, having come along `arrived` (−1: after a pause): sometimes stand a
   * moment (if `mayPause`), else on along a random other edge — back only from a dead end.
   */
  private roofStep(
    agent: number,
    node: number,
    arrived: number,
    t: number,
    mayPause: boolean,
  ): void {
    if (mayPause && this.random(agent) < ROOF_PAUSE_SHARE) {
      const h = this.simHalf[agent];
      this.dest[agent] = node;
      this.stand(agent, h, this.graph.edgeLength[h >>> 1], t, AgentState.Pause);
      const [min, max] = ROOF_PAUSE_MS;
      this.schedule(agent, t + min + Math.floor(this.random(agent) * (max - min)));
      return;
    }
    const first = this.tile.nodes.firstHalfEdge[node];
    const end = this.tile.nodes.firstHalfEdge[node + 1];
    const back = arrived >= 0 ? arrived ^ 1 : -1;
    const options = end - first - (back >= 0 ? 1 : 0);
    let next = back;
    if (options > 0) {
      let k = Math.floor(this.random(agent) * options);
      for (let i = first; i < end; i++) {
        const half = this.tile.adjacency[i];
        if (half === back) continue;
        if (k-- === 0) {
          next = half;
          break;
        }
      }
    }
    if (next < 0) next = this.tile.adjacency[first];
    this.enterNavEdge(agent, next, t);
  }

  /** At the destination entrance: on to the next destination, or into the building's aggregate. */
  private arrive(agent: number, node: number, t: number): void {
    // Showcase: straight on to the next destination.
    if (this.stayOutdoors && this.startTripFrom(agent, node, t)) return;
    const building = this.tile.nodes.buildingId[node];
    if (building !== NO_BUILDING) this.collapse(agent, building, t);
    else this.startTripFrom(agent, node, t);
  }

  /** Follows the last-mile route from `routePos`, then carries on from its end. */
  private followRoute(agent: number, t: number): void {
    const route = this.route[agent];
    if (route === null) return;
    const pos = this.routePos[agent];
    if (pos < route.length) {
      this.enterNavEdge(agent, route[pos], t);
      return;
    }
    const last = route[route.length - 1];
    const node =
      (last & 1) === 0 ? this.tile.edges.to[last >>> 1] : this.tile.edges.from[last >>> 1];
    this.route[agent] = null;
    this.continueOutdoor(agent, node, t);
  }

  /** Leaves `node` (an entrance) for a new reachable destination, or collapses back. */
  private startTripFrom(agent: number, node: number, t: number): boolean {
    const go = (dest: number) => {
      this.dest[agent] = dest;
      this.continueOutdoor(agent, node, t);
      return true;
    };
    for (let attempt = 0; attempt < 4; attempt++) {
      const dest = this.pickEntrance(agent, node);
      if (dest !== node && this.canReach(agent, node, dest)) return go(dest);
    }
    // Demand kept drawing this entrance (or unreachable ones): any other reachable entrance.
    const n = this.entrances.length;
    const start = Math.floor(this.random(agent) * n);
    for (let k = 0; k < Math.min(n, 64); k++) {
      const dest = this.otherEntrance(agent, node, start + k);
      if (dest !== node && this.canReach(agent, node, dest)) return go(dest);
    }
    return false;
  }

  /**
   * Outdoors at `node`: arrive, take the cluster's next hop, or — near the destination or at the
   * cluster — finish with a last-mile A* route.
   */
  private continueOutdoor(agent: number, node: number, t: number): void {
    const dest = this.dest[agent];
    if (node === dest) {
      this.arrive(agent, node, t);
      return;
    }
    const near =
      Math.hypot(
        this.tile.nodes.x[node] - this.tile.nodes.x[dest],
        this.tile.nodes.y[node] - this.tile.nodes.y[dest],
      ) < LAST_MILE_M;
    const hop = near ? -1 : this.hopTowards(agent, node);
    if (hop >= 0) {
      this.enterNavEdge(agent, hop, t);
      return;
    }
    // Bounded: a last mile is at most a cluster across; an unreachable destination must not
    // send the search over the whole city.
    const found = (this.robot[agent] === 1 ? this.lastMile.robot : this.lastMile.human).find(
      node,
      dest,
      LAST_MILE_MAX_COST,
    );
    if (found === null || found.halfEdges.length === 0) {
      // Unreachable after all. On the streets for good (showcase), set off somewhere else rather
      // than vanish into the building; otherwise go in.
      if (this.stayOutdoors && this.replanning < 2) {
        this.replanning++;
        const replanned = this.startTripFrom(agent, node, t);
        this.replanning--;
        if (replanned) return;
      }
      const building = this.tile.nodes.buildingId[dest];
      if (building !== NO_BUILDING) this.collapse(agent, building, t);
      return;
    }
    this.route[agent] = found.halfEdges;
    this.routePos[agent] = 0;
    this.followRoute(agent, t);
  }

  private hopTowards(agent: number, node: number): number {
    const key = this.clusterOf[this.dest[agent]];
    const sources = this.clusterSources.get(key);
    return sources === undefined ? -1 : this.hopsOf(agent).nextTo(node, key, sources);
  }

  private canReach(agent: number, node: number, dest: number): boolean {
    if (node === dest) return true;
    // The exact door, not only its cluster: a door on a fragment cut off inside the cluster (a
    // courtyard path, pavement behind steps for robots) is reached by no last mile.
    const component = this.robot[agent] === 1 ? this.component.robot : this.component.human;
    if (component[node] !== component[dest]) return false;
    const key = this.clusterOf[dest];
    const sources = this.clusterSources.get(key);
    return sources !== undefined && this.hopsOf(agent).reachableTo(node, key, sources);
  }

  // --- aggregates (T3) ----------------------------------------------------------------------

  /** Into an unobserved building's aggregate: the row is freed, the seed kept. */
  private collapse(agent: number, building: number, t: number): void {
    this.leaveQueue(agent);
    this.leaveNavEdge(agent);
    this.route[agent] = null;
    this.state[agent] = AgentState.Indoor;
    this.speed[agent] = 0;
    this.nextEvent[agent] = 0xffffffff;
    this.aggregate[building]++;
    let seeds = this.cold.get(building);
    if (seeds === undefined) this.cold.set(building, (seeds = []));
    seeds.push(this.seedOf[agent]);
    this.freeRows[this.freeCount++] = agent;
    this.stats.collapses++;
    this.markDirty(agent);
    this.scheduleEmission(building, t);
  }

  /** Buildings emit their aggregated agents at rate count / stay (demand model; Poisson). */
  private scheduleEmission(building: number, t: number): void {
    if (this.emissionPending[building] === 1 || this.aggregate[building] === 0) return;
    this.emissionPending[building] = 1;
    let x = this.buildingRng[building];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.buildingRng[building] = x >>> 0;
    const u = Math.max(1e-9, (x >>> 0) / 4294967296);
    const gap = (-Math.log(u) * this.stayMs(building)) / this.aggregate[building];
    this.heapPush(t + Math.max(this.tickMs, Math.round(gap)), building);
  }

  private emit(t: number): void {
    while (this.heapSize > 0 && this.heapTime[0] <= t) {
      const time = this.heapTime[0];
      const building = this.heapPop();
      this.emissionPending[building] = 0;
      const seeds = this.cold.get(building);
      if (seeds === undefined || seeds.length === 0 || this.aggregate[building] === 0) continue;
      if (this.freeCount === 0) {
        this.stats.blockedEmissions++;
        this.emissionPending[building] = 1;
        this.heapPush(t + 1000, building);
        continue;
      }
      const entrances = this.entrancesOf.get(building) ?? [];
      if (entrances.length === 0) continue;
      const agent = this.freeRows[this.freeCount - 1];
      // First in, first out: whoever has been inside longest leaves first.
      this.assignIdentity(agent, seeds[0]);
      const entrance = entrances[Math.floor(this.random(agent) * entrances.length)];
      this.freeCount--;
      seeds.shift();
      this.aggregate[building]--;
      this.stats.emissions++;
      this.lateral[agent] = 0;
      if (!this.startTripFrom(agent, entrance, Math.max(time, t - this.tickMs))) {
        // Nowhere reachable from this entrance: straight back in.
        this.collapse(agent, building, t);
        continue;
      }
      this.scheduleEmission(building, t);
    }
  }

  private heapPush(time: number, building: number): void {
    if (this.heapSize === this.heapTime.length) {
      const times = new Float64Array(this.heapSize * 2);
      const buildings = new Uint32Array(this.heapSize * 2);
      times.set(this.heapTime);
      buildings.set(this.heapBuilding);
      this.heapTime = times;
      this.heapBuilding = buildings;
    }
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      // Ties broken by building id: deterministic order.
      if (
        this.heapTime[parent] < time ||
        (this.heapTime[parent] === time && this.heapBuilding[parent] <= building)
      )
        break;
      this.heapTime[i] = this.heapTime[parent];
      this.heapBuilding[i] = this.heapBuilding[parent];
      i = parent;
    }
    this.heapTime[i] = time;
    this.heapBuilding[i] = building;
  }

  private heapPop(): number {
    const top = this.heapBuilding[0];
    const size = --this.heapSize;
    const time = this.heapTime[size];
    const building = this.heapBuilding[size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      const right = child + 1;
      if (
        right < size &&
        (this.heapTime[right] < this.heapTime[child] ||
          (this.heapTime[right] === this.heapTime[child] &&
            this.heapBuilding[right] < this.heapBuilding[child]))
      )
        child = right;
      if (
        this.heapTime[child] > time ||
        (this.heapTime[child] === time && this.heapBuilding[child] >= building)
      )
        break;
      this.heapTime[i] = this.heapTime[child];
      this.heapBuilding[i] = this.heapBuilding[child];
      i = child;
    }
    this.heapTime[i] = time;
    this.heapBuilding[i] = building;
    return top;
  }

  // --- movement -----------------------------------------------------------------------------

  private hopsOf(agent: number): NextHopTables {
    return this.robot[agent] === 1 ? this.hops.robot : this.hops.human;
  }

  private leaveNavEdge(agent: number): void {
    const navHalf = this.navHalf[agent];
    if (navHalf < 0) return;
    const e = navHalf >>> 1;
    if (this.occupancy[e] > 0) this.occupancy[e]--;
    this.navHalf[agent] = -1;
  }

  /** Speed on entering edge `e`: Weidmann's fundamental diagram on the edge's density. */
  private densitySpeed(agent: number, e: number): number {
    const area = Math.max(1, this.tile.edges.length[e] * (this.tile.edges.widthCm[e] / 100));
    const others = this.externalOccupancy === null ? 0 : this.externalOccupancy[e];
    const density = (this.occupancy[e] + others + 1) / area;
    const share =
      density >= JAM_DENSITY
        ? MIN_SPEED_SHARE
        : 1 - Math.exp(-WEIDMANN_GAMMA * (1 / density - 1 / JAM_DENSITY));
    const steps = this.tile.edges.type[e] === EdgeType.Steps ? STEPS_SPEED : 1;
    return Math.max(
      1,
      Math.round(this.walkSpeed[agent] * steps * Math.max(MIN_SPEED_SHARE, share)),
    );
  }

  /** Standing still (pausing on a roof) on `simHalf` at `s0`. */
  private stand(agent: number, simHalf: number, s0: number, t: number, state: AgentState): void {
    this.leaveNavEdge(agent);
    this.state[agent] = state;
    this.simHalf[agent] = simHalf;
    this.s0[agent] = s0;
    this.t0[agent] = t;
    this.speed[agent] = 0;
    this.anim[agent] = this.kindOf(agent).idleClip;
    this.markDirty(agent);
  }

  /** Starts walking nav half-edge `navHalf`, or waits at its kerb first if it is a crossing. */
  private enterNavEdge(agent: number, navHalf: number, t: number): void {
    this.navHalf[agent] = navHalf;
    this.onEnterEdge?.(agent, navHalf);
    const e = navHalf >>> 1;
    this.edgeSpeed[agent] = this.densitySpeed(agent, e);
    this.occupancy[e]++;
    const width = this.tile.edges.widthCm[e] / 100;
    // A new lane target: T0 agents drift there (avoid()); everyone else moves at once.
    this.chooseLane(agent, width, this.near[agent] === 0);
    if (this.tile.edges.type[e] === EdgeType.Crossing) {
      // A crossing already queued for (see planQueue) is walked straight onto.
      const wait = this.cleared[agent] === navHalf ? 0 : this.crossingWait(agent, e, t);
      this.cleared[agent] = -1;
      if (wait > 0) {
        this.state[agent] = AgentState.Wait;
        this.simHalf[agent] = firstSimHalfEdge(this.graph, navHalf);
        this.s0[agent] = 0;
        this.t0[agent] = t;
        this.speed[agent] = 0;
        this.anim[agent] = this.kindOf(agent).idleClip;
        this.schedule(agent, t + wait);
        this.markDirty(agent);
        return;
      }
    }
    this.startSegment(agent, firstSimHalfEdge(this.graph, navHalf), 0, t, false);
  }

  /** Enters nav half-edge `navHalf` at `fraction` of its length (spawning mid-trip). */
  private placeOnNavEdge(agent: number, navHalf: number, fraction: number, t: number): void {
    this.navHalf[agent] = navHalf;
    this.edgeSpeed[agent] = this.densitySpeed(agent, navHalf >>> 1);
    this.occupancy[navHalf >>> 1]++;
    this.chooseLane(agent, this.tile.edges.widthCm[navHalf >>> 1] / 100, true);
    let remaining = this.tile.edges.length[navHalf >>> 1] * fraction;
    let h = firstSimHalfEdge(this.graph, navHalf);
    for (;;) {
      const length = this.graph.edgeLength[h >>> 1];
      const next = nextSimHalfEdge(this.graph, h);
      if (remaining < length || next < 0) break;
      remaining -= length;
      h = next;
    }
    this.startSegment(
      agent,
      h,
      Math.min(remaining, this.graph.edgeLength[h >>> 1] * 0.999),
      t,
      false,
    );
  }

  /**
   * Walks sim half-edge `simHalf` from `s0` at time `t`. `continuing` keeps the walk cycle's
   * phase continuous from the previous walking record.
   */
  private startSegment(
    agent: number,
    simHalf: number,
    s0: number,
    t: number,
    continuing: boolean,
  ): void {
    const kind = this.kindOf(agent);
    if (continuing && this.state[agent] === AgentState.Walk && this.speed[agent] > 0) {
      const walked = (this.speed[agent] * (t - this.t0[agent])) / 1_000_000;
      const cycles = this.phase0[agent] / 0x10000 + walked / (kind.strideM * this.scale[agent]);
      this.phase0[agent] = Math.floor((cycles - Math.floor(cycles)) * 0x10000) & 0xffff;
    }
    this.state[agent] = AgentState.Walk;
    this.simHalf[agent] = simHalf;
    this.s0[agent] = s0;
    this.t0[agent] = t;
    this.speed[agent] = this.edgeSpeed[agent];
    this.anim[agent] = kind.walkClip;
    const length = this.graph.edgeLength[simHalf >>> 1];
    this.schedule(
      agent,
      t + Math.max(1, Math.ceil(((length - s0) * 1_000_000) / this.speed[agent])),
    );
    this.markDirty(agent);
    this.planQueue(agent, simHalf, s0, t);
  }

  /**
   * On the last segment before a road crossing that will be red on arrival: stop short, in a
   * queue behind the kerb — side by side, then rows further back — instead of piling onto one
   * point. The stop is on the walking line, so nobody jumps; each row sets off a little after
   * the one in front. Only for next-hop walking (a last-mile route is followed as it is).
   */
  private planQueue(agent: number, simHalf: number, s0: number, t: number): void {
    // Only while events drain: the wheel holds one entry per agent, re-read after each event,
    // so an earlier stop scheduled here is honoured; outside (spawning) it would fire late.
    if (!this.draining || this.cleared[agent] >= 0 || this.route[agent] !== null) return;
    if (nextSimHalfEdge(this.graph, simHalf) >= 0 || this.roof[agent] === 1) return;
    const navHalf = this.navHalf[agent];
    if (navHalf < 0) return;
    const e = navHalf >>> 1;
    const node = (navHalf & 1) === 0 ? this.tile.edges.to[e] : this.tile.edges.from[e];
    const dest = this.dest[agent];
    if (node === dest) return;
    const near =
      Math.hypot(
        this.tile.nodes.x[node] - this.tile.nodes.x[dest],
        this.tile.nodes.y[node] - this.tile.nodes.y[dest],
      ) < LAST_MILE_M;
    if (near) return;
    const crossing = this.hopTowards(agent, node);
    if (crossing < 0 || this.tile.edges.type[crossing >>> 1] !== EdgeType.Crossing) return;
    const length = this.graph.edgeLength[simHalf >>> 1];
    const arrival = t + ((length - s0) * 1_000_000) / Math.max(1, this.speed[agent]);
    const wait = this.crossingWait(agent, crossing >>> 1, arrival);
    if (wait <= 0) return;
    const slot = this.queues.get(crossing) ?? 0;
    this.queues.set(crossing, slot + 1);
    const width = this.tile.edges.widthCm[e] / 100;
    const lanes = Math.max(1, Math.min(4, Math.floor(width / LANE_M)));
    const row = Math.min(QUEUE_MAX_ROWS, Math.floor(slot / lanes));
    const stop = Math.max(s0, length - QUEUE_KERB_M - row * QUEUE_ROW_M);
    // Its column across the pavement: near the camera the agent drifts there (avoid()), further
    // out it steps across at once (as T2 agents take their lane at edge entry).
    const limit = this.laneLimit[agent] * 0.02;
    const column = ((slot % lanes) + 0.5) * (width / lanes) - width / 2;
    this.laneTarget[agent] = clampI8(Math.round(Math.max(-limit, Math.min(limit, column)) / 0.02));
    if (this.near[agent] === 0) this.lateral[agent] = this.laneTarget[agent];
    this.queuedFor[agent] = crossing;
    this.queueStop[agent] = stop;
    this.queueRelease[agent] = Math.ceil(arrival + wait + row * QUEUE_ROW_DELAY_MS);
    this.schedule(
      agent,
      t + Math.max(1, Math.ceil(((stop - s0) * 1_000_000) / Math.max(1, this.speed[agent]))),
    );
  }

  /** Forgets any queue this agent was in (it left the street). */
  private leaveQueue(agent: number): void {
    const crossing = this.queuedFor[agent];
    if (crossing >= 0) {
      const waiting = (this.queues.get(crossing) ?? 1) - 1;
      if (waiting > 0) this.queues.set(crossing, waiting);
      else this.queues.delete(crossing);
    }
    this.queuedFor[agent] = -1;
    this.queueStop[agent] = -1;
    this.cleared[agent] = -1;
  }

  /** Reached its queue place: stand there (Wait) until its row may go. */
  private standInQueue(agent: number, t: number): void {
    const stop = this.queueStop[agent];
    this.queueStop[agent] = -1;
    this.state[agent] = AgentState.Wait;
    this.s0[agent] = stop;
    this.t0[agent] = t;
    this.speed[agent] = 0;
    this.anim[agent] = this.kindOf(agent).idleClip;
    this.schedule(agent, Math.max(t + 1, this.queueRelease[agent]));
    this.markDirty(agent);
  }

  /**
   * Lane at edge entry: keep-left bias, jitter, and how far sideways the agent may move. `place`
   * puts the agent in the lane at once (spawning); otherwise it only sets the target.
   */
  private chooseLane(agent: number, widthM: number, place: boolean): void {
    const lanes = Math.max(1, Math.min(4, Math.floor(widthM / LANE_M)));
    let total = 0;
    for (let k = 0; k < lanes; k++) total += LANE_WEIGHTS[k];
    let r = this.random(agent) * total;
    let lane = 0;
    while (lane < lanes - 1 && r >= LANE_WEIGHTS[lane]) {
      r -= LANE_WEIGHTS[lane];
      lane++;
    }
    const laneWidth = widthM / lanes;
    // Lane 0 is leftmost; negative lateral is to the left of the walking direction.
    const centre = (lane + 0.5) * laneWidth - widthM / 2;
    const jitter = (this.random(agent) * 2 - 1) * LANE_JITTER_M;
    const limit = Math.max(0, widthM / 2 - KERB_MARGIN_M);
    const offset = Math.max(-limit, Math.min(limit, centre + jitter));
    this.laneTarget[agent] = clampI8(Math.round(offset / 0.02));
    if (place) this.lateral[agent] = this.laneTarget[agent];
    this.laneLimit[agent] = Math.min(127, Math.round(limit / 0.02));
  }

  /** Milliseconds to wait at the kerb before crossing edge `e`. */
  private crossingWait(agent: number, e: number, t: number): number {
    const flags = this.tile.edges.flags[e];
    const caution = this.robot[agent] === 1 ? 1000 : 0;
    if ((flags & EdgeFlag.Signalised) !== 0) {
      const offset = hash32(e) % SIGNAL_CYCLE_MS;
      const inCycle = (t + SIGNAL_CYCLE_MS - offset) % SIGNAL_CYCLE_MS;
      if (inCycle <= SIGNAL_GREEN_MS - SIGNAL_MIN_GREEN_MS) return 0;
      // Until the next green, plus a reaction time.
      return SIGNAL_CYCLE_MS - inCycle + Math.floor(this.random(agent) * 1500) + caution;
    }
    const [min, max] = (flags & EdgeFlag.Implicit) !== 0 ? [1000, 5000] : [0, 2500];
    return min + Math.floor(this.random(agent) * (max - min)) + caution;
  }

  // --- avoidance ----------------------------------------------------------------------------

  /**
   * Walking agents closer than AVOID_RADIUS push each other sideways (a neighbour on the left
   * pushes right), within the pavement; with no one near, agents drift back to their lane.
   * Positions are a snapshot taken before any lane changes, so the result does not depend on
   * iteration order.
   */
  /**
   * Near-tier membership (T0), with hysteresis: walking and waiting agents whose current segment
   * starts within NEAR_ENTER_M of the focus join, and leave beyond NEAR_LEAVE_M. Run at the start
   * of every tick, so edge entries in the tick already know the agent's tier.
   */
  private classifyTiers(): void {
    const { graph } = this;
    const enterSq = NEAR_ENTER_M * NEAR_ENTER_M;
    const leaveSq = NEAR_LEAVE_M * NEAR_LEAVE_M;
    for (let a = 0; a < this.agents; a++) {
      if (!this.hasFocus || this.state[a] === AgentState.Indoor) {
        this.near[a] = 0;
        continue;
      }
      // On the segment's start node: cheap, and segments are short.
      const start = graph.edgeFrom[this.simHalf[a] >>> 1];
      const dx = graph.nodeX[start] - this.focusX;
      const dz = graph.nodeZ[start] - this.focusZ;
      this.near[a] = dx * dx + dz * dz <= (this.near[a] === 1 ? leaveSq : enterSq) ? 1 : 0;
    }
  }

  /** Positions of this simulation's near-tier walkers at `t` into the scratch arrays. */
  private collectNear(t: number): number {
    const { graph, px, pz, fx, fz, walkers } = this;
    let count = 0;
    for (let a = 0; a < this.agents; a++) {
      // Roof walks are inset from the roof's edge, so they never meet the pavement in plan.
      if (this.near[a] === 0 || this.state[a] !== AgentState.Walk) continue;
      const h = this.simHalf[a];
      const e = h >>> 1;
      const length = graph.edgeLength[e];
      const s = Math.min(length, this.s0[a] + (this.speed[a] * (t - this.t0[a])) / 1_000_000);
      const reverse = (h & 1) === 1;
      const along = reverse ? length - s : s;
      const heading = graph.edgeHeading[e] + (reverse ? Math.PI : 0);
      const from = graph.edgeFrom[e];
      const sx = Math.sin(heading);
      const cz = Math.cos(heading);
      const lateral = this.lateral[a] * 0.02;
      const k = count++;
      walkers[k] = a;
      fx[k] = sx;
      fz[k] = cz;
      // Right of forward (sin h, cos h) is (−cos h, sin h), as in the GPU integrate kernel.
      px[k] = graph.nodeX[from] + Math.sin(graph.edgeHeading[e]) * along - cz * lateral;
      pz[k] = graph.nodeZ[from] + Math.cos(graph.edgeHeading[e]) * along + sx * lateral;
    }
    return count;
  }

  /**
   * Walking agents closer than AVOID_RADIUS push each other sideways (a neighbour on the left
   * pushes right), within the pavement; with no one near, agents drift back to their lane.
   * Positions are a snapshot taken before any lane changes, so the result does not depend on
   * iteration order. `external` adds other partitions' near walkers as neighbours.
   */
  avoid(t: number, external: readonly { data: Float32Array; count: number }[] | null): void {
    const own = this.collectNear(t);
    let count = own;
    for (const segment of external ?? []) {
      this.ensureScratch(count + segment.count);
      for (let k = 0; k < segment.count; k++) {
        this.px[count] = segment.data[k * 4];
        this.pz[count] = segment.data[k * 4 + 1];
        this.fx[count] = segment.data[k * 4 + 2];
        this.fz[count] = segment.data[k * 4 + 3];
        count++;
      }
    }
    const { px, pz, fx, fz, walkers, next, heads } = this;
    const mask = heads.length - 1;
    heads.fill(-1);
    for (let k = 0; k < count; k++) {
      const cell = cellHash(Math.floor(px[k] / HASH_CELL), Math.floor(pz[k] / HASH_CELL)) & mask;
      next[k] = heads[cell];
      heads[cell] = k;
    }
    this.stats.nearTier = own;
    const radiusSq = AVOID_RADIUS * AVOID_RADIUS;
    for (let k = 0; k < own; k++) {
      const cx = Math.floor(px[k] / HASH_CELL);
      const cz = Math.floor(pz[k] / HASH_CELL);
      let push = 0;
      for (let ox = -1; ox <= 1; ox++)
        for (let oz = -1; oz <= 1; oz++)
          for (let j = heads[cellHash(cx + ox, cz + oz) & mask]; j >= 0; j = next[j]) {
            if (j === k) continue;
            const rx = px[j] - px[k];
            const rz = pz[j] - pz[k];
            if (rx * rx + rz * rz > radiusSq) continue;
            // Right of forward is (−fz, fx): a neighbour on the right side pushes left.
            push += rx * -fz[k] + rz * fx[k] > 0 ? -1 : 1;
          }
      const agent = walkers[k];
      const current = this.lateral[agent];
      // An agent still outside a narrower pavement's limit is not snapped in; it drifts.
      const limit = Math.max(this.laneLimit[agent], Math.abs(current));
      let target = current;
      if (push > 0) target = Math.min(limit, current + LATERAL_STEP);
      else if (push < 0) target = Math.max(-limit, current - LATERAL_STEP);
      else if (current !== this.laneTarget[agent])
        target = current + Math.sign(this.laneTarget[agent] - current) * LATERAL_STEP;
      if (target !== current) {
        this.lateral[agent] = target;
        this.markDirty(agent);
        this.stats.lateralChanges++;
      }
    }
  }

  // --- helpers ------------------------------------------------------------------------------

  /** Grows the avoidance scratch to hold `n` walkers (own plus other partitions'). */
  private ensureScratch(n: number): void {
    if (n <= this.px.length) return;
    const size = Math.max(n, this.px.length * 2);
    const grow = <T extends Float32Array | Int32Array>(old: T, make: new (n: number) => T): T => {
      const out = new make(size);
      out.set(old);
      return out;
    };
    this.px = grow(this.px, Float32Array);
    this.pz = grow(this.pz, Float32Array);
    this.fx = grow(this.fx, Float32Array);
    this.fz = grow(this.fz, Float32Array);
    this.next = grow(this.next, Int32Array);
  }

  private kindOf(agent: number): KindAnimation {
    return this.robot[agent] === 1 ? this.kinds.robot : this.kinds.human;
  }

  /**
   * A fallback candidate when demand keeps drawing unusable entrances: the `k`-th of a scan through
   * all entrances, or with a trip radius a uniformly drawn nearby one.
   */
  private otherEntrance(agent: number, from: number, k: number): number {
    if (this.tripRadiusM === Infinity) return this.entrances[k % this.entrances.length];
    return this.pickEntrance(agent, from, true);
  }

  /**
   * A destination by demand (capacity × type × time of day). With a trip radius and an origin,
   * among the entrances of the trip cells within the radius of `from`: a cell by its total weight,
   * then an entrance in it. `uniform` weighs every entrance alike.
   */
  private pickEntrance(agent: number, from = -1, uniform = false): number {
    const weights = this.entranceWeights[this.period];
    if (this.tripRadiusM !== Infinity && from >= 0) {
      const local = this.pickLocal(agent, from, weights, uniform);
      if (local >= 0) return local;
    }
    return this.pickIn(
      weights,
      this.random(agent) * weights[weights.length - 1],
      0,
      weights.length,
    );
  }

  private pickLocal(agent: number, from: number, weights: Float64Array, uniform: boolean): number {
    const x = this.tile.nodes.x[from];
    const y = this.tile.nodes.y[from];
    const r = this.tripRadiusM;
    const reach = Math.ceil(r / TRIP_CELL_M);
    const cx = Math.floor(x / TRIP_CELL_M);
    const cy = Math.floor(y / TRIP_CELL_M);
    const { start, end, cum } = this.cellScratch;
    let count = 0;
    let total = 0;
    for (let dx = -reach; dx <= reach; dx++)
      for (let dy = -reach; dy <= reach; dy++) {
        // Nearest point of the cell within the radius.
        const nx = Math.max(0, Math.abs(dx) - 1) * TRIP_CELL_M;
        const ny = Math.max(0, Math.abs(dy) - 1) * TRIP_CELL_M;
        if (nx * nx + ny * ny > r * r) continue;
        const range = this.tripCells.get((cx + dx + 2048) * 4096 + (cy + dy + 2048));
        if (range === undefined) continue;
        const w = uniform
          ? range.end - range.start
          : weights[range.end - 1] - (range.start > 0 ? weights[range.start - 1] : 0);
        if (w <= 0) continue;
        total += w;
        start[count] = range.start;
        end[count] = range.end;
        cum[count++] = total;
      }
    if (count === 0) return -1;
    const pick = this.random(agent) * total;
    let c = 0;
    while (c < count - 1 && cum[c] <= pick) c++;
    const s = start[c];
    const e = end[c];
    if (uniform) return this.entrances[s + Math.floor(this.random(agent) * (e - s))];
    const base = s > 0 ? weights[s - 1] : 0;
    return this.pickIn(weights, base + this.random(agent) * (weights[e - 1] - base), s, e);
  }

  /** The entrance whose cumulative-weight interval in [lo, hi) holds `r`. */
  private pickIn(weights: Float64Array, r: number, lo: number, hi: number): number {
    hi -= 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (weights[mid] > r) hi = mid;
      else lo = mid + 1;
    }
    return this.entrances[lo];
  }

  /** Mean stay in a building of this type at this time of day (demand model). */
  private stayMs(building: number): number {
    return STAY_MINUTES[this.period][this.tile.buildings.type[building] as BuildingType] * 60_000;
  }

  /** xorshift32 per agent: [0, 1). */
  private random(agent: number): number {
    let x = this.rng[agent];
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.rng[agent] = x >>> 0;
    return (x >>> 0) / 4294967296;
  }

  /** Sets the agent's next event; filed in the wheel unless it is being drained (or already is). */
  private schedule(agent: number, dueMs: number): void {
    this.nextEvent[agent] = dueMs >>> 0;
    if (!this.draining && this.inWheel[agent] === 0) {
      this.wheel.schedule(agent, dueMs);
      this.inWheel[agent] = 1;
    }
  }

  private markDirty(agent: number): void {
    if (this.dirtyFlag[agent] === 1) return;
    this.dirtyFlag[agent] = 1;
    this.dirty[this.dirtyCount++] = agent;
  }

  private writeRecord(agent: number): void {
    const view = this.records;
    const base = agent * AGENT_RECORD_BYTES;
    const state = this.state[agent];
    const collapsed = state === AgentState.Indoor;
    const flags =
      (collapsed ? AgentFlag.Hidden : 0) | (this.roof[agent] === 1 ? AgentFlag.Roof : 0);
    view.setUint32(base + AgentRecordOffset.HalfEdge, collapsed ? 0 : this.simHalf[agent], true);
    view.setFloat32(base + AgentRecordOffset.S0, this.s0[agent], true);
    view.setUint32(base + AgentRecordOffset.T0, this.t0[agent], true);
    view.setUint16(base + AgentRecordOffset.Speed, this.speed[agent], true);
    view.setInt8(base + AgentRecordOffset.Lateral, this.lateral[agent]);
    view.setUint8(base + AgentRecordOffset.Anim, this.anim[agent]);
    view.setUint8(
      base + AgentRecordOffset.Kind,
      packAgentKind(this.robot[agent] === 1, this.variant[agent]),
    );
    view.setUint8(base + AgentRecordOffset.Flags, flags);
    view.setUint16(base + AgentRecordOffset.Phase0, this.phase0[agent], true);
    view.setUint32(base + AgentRecordOffset.Seed, this.seedOf[agent], true);
  }
}

function clampI8(v: number): number {
  return Math.max(-127, Math.min(127, v));
}

function cellHash(x: number, z: number): number {
  return (Math.imul(x, 73856093) ^ Math.imul(z, 19349663)) >>> 0;
}

/** Component id per node over the edges `costs` allows (union-find). */
function connectedComponents(graph: RoutingGraph, costs: Float32Array): Int32Array {
  const n = graph.firstHalfEdge.length - 1;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  for (let e = 0; e < graph.edgeFrom.length; e++)
    if (costs[e] !== Infinity) parent[find(graph.edgeFrom[e])] = find(graph.edgeTo[e]);
  for (let i = 0; i < n; i++) parent[i] = find(i);
  return parent;
}

/** Running totals of `shares` scaled to end at 1, or null when they are missing or all zero. */
function cumulativeShares(shares: number[] | undefined, variants: number): Float64Array | null {
  if (shares === undefined) return null;
  const weights = Array.from({ length: variants }, (_, v) => Math.max(0, shares[v] ?? 0));
  const total = weights.reduce((sum, w) => sum + w, 0);
  if (!(total > 0)) return null;
  const cumulative = new Float64Array(variants);
  let sum = 0;
  for (let v = 0; v < variants; v++) {
    sum += weights[v] ?? 0;
    cumulative[v] = sum / total;
  }
  return cumulative;
}
