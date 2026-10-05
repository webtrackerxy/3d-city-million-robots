import {
  AGENT_RECORD_BYTES,
  AgentFlag,
  EdgeFlag,
  EdgeType,
  readAgentRecord,
  type AgentRecord,
} from '@city/core-types';
import { simGraphFromTile, type SimGraph } from '@city/nav';
import { describe, expect, it } from 'vitest';
import { AgentState, CitySimulation, type CitySimulationOptions } from './city-sim.ts';
import { gridTile } from './test-tile.ts';

const tile = gridTile();
const graph = simGraphFromTile(tile);

function create(agents: number, overrides: Partial<CitySimulationOptions> = {}) {
  const records = new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES));
  const sim = new CitySimulation({
    tile,
    graph,
    agents,
    robotShare: 0.3,
    seed: 42,
    human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
    robot: { walkClip: 3, idleClip: 2, strideM: 1.2, heightVariation: 0 },
    humanVariants: 2,
    records,
    // The whole 150 m test grid is in the near tier (T0) unless a test says otherwise.
    focus: { x: 75, z: -75 },
    ...overrides,
  });
  return { sim, records };
}

/** Centreline position of a record at time t (lateral ignored), clamped at the segment end. */
function position(g: SimGraph, r: AgentRecord, t: number): [number, number] {
  const e = r.halfEdge >>> 1;
  const length = g.edgeLength[e];
  const s = Math.min(length, r.s0 + (r.speed * (t - r.t0)) / 1_000_000);
  const along = (r.halfEdge & 1) === 1 ? length - s : s;
  const from = g.edgeFrom[e];
  return [
    g.nodeX[from] + Math.sin(g.edgeHeading[e]) * along,
    g.nodeZ[from] + Math.cos(g.edgeHeading[e]) * along,
  ];
}

describe('CitySimulation', () => {
  it('is deterministic, and independent of how time is advanced', () => {
    const a = create(400).sim;
    const b = create(400).sim;
    for (let t = 100; t <= 300_000; t += 100) a.advanceTo(t);
    // Irregular steps, as a frame loop would call it.
    let t = 0;
    let k = 1;
    while (t < 300_000) {
      t = Math.min(300_000, t + ((k * 7919) % 1234) + 1);
      k++;
      b.advanceTo(t);
    }
    expect(a.now).toBe(b.now);
    expect(a.stateHash()).toBe(b.stateHash());
    const c = create(400, { seed: 43 }).sim;
    c.advanceTo(300_000);
    expect(c.stateHash()).not.toBe(a.stateHash());
  });

  it('never teleports: each new walking record starts where the previous one ended', () => {
    const { sim, records } = create(300);
    const last = new Map<number, AgentRecord>();
    let checked = 0;
    // Flush every tick (33 ms), so each lateral step is its own record.
    for (let t = 33; t <= 120_000; t += 33) {
      sim.advanceTo(t);
      sim.flush((agent) => {
        const next = readAgentRecord(records, agent);
        const previous = last.get(agent);
        last.set(agent, next);
        // Same person only: a freed row can be re-emitted as someone else between flushes.
        if (previous?.flags !== 0 || next.flags !== 0 || previous.seed !== next.seed) return;
        const [x0, z0] = position(graph, previous, next.t0);
        const [x1, z1] = position(graph, next, next.t0);
        expect(Math.hypot(x1 - x0, z1 - z0)).toBeLessThan(0.02);
        // Sideways moves are gradual: at most one 2 cm step per record change, plus rounding.
        expect(Math.abs(next.lateral - previous.lateral)).toBeLessThanOrEqual(1);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('keeps unobserved (T2) agents event-driven: no avoidance churn without a focus', () => {
    const { sim } = create(400, { focus: undefined });
    sim.advanceTo(60_000);
    sim.flush(() => undefined);
    const before = sim.snapshotStats();
    sim.advanceTo(120_000);
    let records = 0;
    sim.flush(() => {
      records++;
    });
    const after = sim.snapshotStats();
    expect(after.nearTier).toBe(0);
    expect(after.lateralChanges).toBe(0);
    // One record per event at most (plus none from avoidance).
    expect(records).toBeLessThanOrEqual(after.events - before.events);
  });

  it('slows agents on crowded edges (density speed)', () => {
    const { sim, records } = create(3000, { robotShare: 0 });
    let slowest = Infinity;
    for (let t = 1000; t <= 60_000; t += 1000) {
      sim.advanceTo(t);
      sim.flush((agent) => {
        const r = readAgentRecord(records, agent);
        if (r.speed > 0) slowest = Math.min(slowest, r.speed);
      });
    }
    // Humans walk 1.2–1.5 m/s when free; 3000 agents on this small grid crowd some edges.
    expect(slowest).toBeLessThan(1000);
    expect(slowest).toBeGreaterThanOrEqual(Math.floor(1200 * 0.15));
  });

  it('conserves the population and hides agents indoors', () => {
    const { sim, records } = create(500);
    for (let t = 1000; t <= 400_000; t += 1000) {
      sim.advanceTo(t);
      sim.flush(() => undefined);
      const stats = sim.snapshotStats();
      expect(stats.walking + stats.waiting + stats.indoor).toBe(500);
    }
    let hidden = 0;
    for (let a = 0; a < 500; a++) {
      const indoor = sim.agentState(a).state === AgentState.Indoor;
      const flagged = (readAgentRecord(records, a).flags & AgentFlag.Hidden) !== 0;
      expect(flagged).toBe(indoor);
      if (indoor) hidden++;
    }
    expect(hidden).toBeGreaterThan(0);
    expect(hidden).toBeLessThan(500);
  });

  it('starts across a signalised crossing only on green, and robots never take steps', () => {
    const { sim, records } = create(600, { robotShare: 0.5 });
    const crossing = 7;
    expect(tile.edges.flags[crossing] & EdgeFlag.Signalised).toBeTruthy();
    const starts: number[] = [];
    let robotOnSteps = 0;
    for (let t = 100; t <= 600_000; t += 100) {
      sim.advanceTo(t);
      sim.flush((agent) => {
        const r = readAgentRecord(records, agent);
        if (r.flags !== 0) return;
        const navEdge = graph.segmentEdge[r.halfEdge >>> 1];
        const robot = (r.kind & 0x80) !== 0;
        if (robot && tile.edges.type[navEdge] === EdgeType.Steps) robotOnSteps++;
        // First moving record on the crossing, from its kerb.
        if (navEdge === crossing && r.speed > 0 && r.s0 === 0) starts.push(r.t0);
      });
    }
    expect(robotOnSteps).toBe(0);
    expect(starts.length).toBeGreaterThan(5);
    // All starts fall in one 12 s green window of the 60 s cycle (plus reaction time).
    const phases = starts.map((t) => t % 60_000).sort((x, y) => x - y);
    const spread = Math.min(
      ...phases.map((p) => {
        const shifted = phases.map((q) => (q - p + 60_000) % 60_000);
        return Math.max(...shifted);
      }),
    );
    expect(spread).toBeLessThanOrEqual(12_000 + 1_500 + 1_000);
  });
});
