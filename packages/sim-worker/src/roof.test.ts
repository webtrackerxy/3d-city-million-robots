import { appendRoofs } from '@city/buildings';
import { AGENT_RECORD_BYTES, AgentFlag, EdgeType, readAgentRecord } from '@city/core-types';
import { simGraphFromTile } from '@city/nav';
import { AgentState, CitySimulation, type CitySimulationOptions } from '@city/sim';
import { describe, expect, it } from 'vitest';
import { city } from './test-city.ts';

function setup(agents: number, overrides: Partial<CitySimulationOptions> = {}) {
  const { tile, firstRoofEdge, roofs } = appendRoofs(city());
  const graph = simGraphFromTile(tile);
  const records = new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES));
  const sim = new CitySimulation({
    tile,
    graph,
    agents,
    robotShare: 0.3,
    seed: 7,
    human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
    robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
    humanVariants: 1,
    records,
    firstRoofEdge,
    roofShare: 0.1,
    ...overrides,
  });
  return { sim, tile, graph, records, roofs, firstRoofEdge };
}

describe('Roof walkers', () => {
  it('about a tenth of the walkers, of both kinds, walk on roofs, and only they do', () => {
    const agents = 2000;
    const { sim, tile, graph, records, roofs } = setup(agents, {
      stayOutdoors: true,
      startWalkingShare: 1,
    });
    // Every building of the test city is tall and large enough.
    expect(roofs).toBe(6);
    const onRoof = sim.snapshotStats().onRoof;
    expect(onRoof).toBe(agents / 10);
    let robots = 0;
    for (let a = 0; a < agents; a++)
      if (sim.agentState(a).roof && sim.agentState(a).robot) robots++;
    // robotShare 0.3 of the 200.
    expect(robots).toBeGreaterThan(40);
    expect(robots).toBeLessThan(80);
    for (let t = 1000; t <= 600_000; t += 1000) {
      sim.advanceTo(t);
      sim.flush((agent) => {
        const r = readAgentRecord(records, agent);
        // Collapsed (no destination reachable): never a roof walker.
        if ((r.flags & AgentFlag.Hidden) !== 0) {
          expect(r.flags & AgentFlag.Roof).toBe(0);
          return;
        }
        const edge = graph.segmentEdge[r.halfEdge >>> 1];
        const roofEdge = tile.edges.type[edge] === EdgeType.Roof;
        const roof = (r.flags & AgentFlag.Roof) !== 0;
        expect(roofEdge).toBe(roof);
        if (roof) {
          // Up at the roof's height (the tower is 42 m, the lowest building 7 m).
          expect(graph.nodeY[graph.edgeFrom[r.halfEdge >>> 1]]).toBeGreaterThanOrEqual(7);
        }
      });
      expect(sim.snapshotStats().onRoof).toBe(onRoof);
    }
    const stats = sim.snapshotStats();
    expect(stats.walking + stats.waiting + stats.freeRows).toBe(agents - onRoof);
  }, 60_000);

  it('keeps the population with buildings emitting and absorbing street walkers', () => {
    const { sim } = setup(600, { population: 1500 });
    const population = sim.population;
    const onRoof = sim.snapshotStats().onRoof;
    expect(onRoof).toBeGreaterThan(0);
    let paused = 0;
    for (let t = 1000; t <= 900_000; t += 1000) {
      sim.advanceTo(t);
      sim.flush(() => undefined);
      expect(sim.population).toBe(population);
      expect(sim.snapshotStats().onRoof).toBe(onRoof);
      for (let a = 0; a < 600; a++) if (sim.agentState(a).state === AgentState.Pause) paused++;
    }
    expect(paused).toBeGreaterThan(0);
    expect(sim.snapshotStats().collapses).toBeGreaterThan(0);
  }, 60_000);

  it('picks a person or a robot on a roof to follow, as asked', () => {
    const { sim } = setup(1000, { stayOutdoors: true, startWalkingShare: 1 });
    sim.setFocus(25, -25);
    for (const kind of ['human', 'robot'] as const) {
      const agent = sim.pickFollowCandidate(kind);
      expect(agent).toBeGreaterThanOrEqual(0);
      const s = sim.agentState(agent);
      expect(s.roof).toBe(true);
      expect(s.robot).toBe(kind === 'robot');
      expect(s.building).toBeGreaterThanOrEqual(0);
    }
  });

  it('puts nobody on a roof without a roof share, or without roofs', () => {
    expect(setup(500, { roofShare: 0 }).sim.snapshotStats().onRoof).toBe(0);
    const plain = city();
    const sim = new CitySimulation({
      tile: plain,
      graph: simGraphFromTile(plain),
      agents: 500,
      robotShare: 0.3,
      seed: 7,
      human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
      robot: { walkClip: 1, idleClip: 0, strideM: 1.2, heightVariation: 0 },
      humanVariants: 1,
      records: new DataView(new ArrayBuffer(500 * AGENT_RECORD_BYTES)),
      roofShare: 0.1,
    });
    expect(sim.snapshotStats().onRoof).toBe(0);
  });

  it('is deterministic with roof walkers and aggregates', () => {
    const a = setup(300).sim;
    const b = setup(300).sim;
    for (let t = 500; t <= 900_000; t += 500) a.advanceTo(t);
    b.advanceTo(900_000);
    expect(a.stateHash()).toBe(b.stateHash());
  }, 60_000);
});
