import { AGENT_RECORD_BYTES, readAgentRecord } from '@city/core-types';
import { createGridGraph, halfEdgeEnd, halfEdgeStart } from '@city/nav';
import { describe, expect, it } from 'vitest';
import { AgentStateFlag, AgentStore, allocateAgentBuffer } from './agent-store.ts';
import { Simulation } from './simulation.ts';
import { TimingWheel } from './timing-wheel.ts';

const graph = createGridGraph(12, 12, 30);

function simulation(
  agents: number,
  options: Partial<ConstructorParameters<typeof Simulation>[0]> = {},
) {
  const store = new AgentStore(allocateAgentBuffer(agents, false), agents);
  return new Simulation({ graph, store, start: 0, end: agents, seed: 7, ...options });
}

describe('TimingWheel', () => {
  it('visits agents once their slot has passed, in slot order', () => {
    const wheel = new TimingWheel(0, 10, 16);
    wheel.schedule(1, 25);
    wheel.schedule(2, 5);
    wheel.schedule(3, 95);
    const seen: number[] = [];
    wheel.advanceTo(30, (a) => seen.push(a));
    expect(seen).toEqual([2, 1]);
    wheel.advanceTo(100, (a) => seen.push(a));
    expect(seen).toEqual([2, 1, 3]);
  });

  it('files events beyond the horizon at the horizon', () => {
    const wheel = new TimingWheel(0, 10, 8);
    wheel.schedule(9, 10_000);
    const seen: number[] = [];
    wheel.advanceTo(wheel.horizonMs + 10, (a) => seen.push(a));
    expect(seen).toEqual([9]);
  });
});

describe('Simulation', () => {
  it('marks every spawned agent dirty once', () => {
    const sim = simulation(500);
    const drained: number[] = [];
    expect(sim.drainDirty((a) => drained.push(a))).toBe(500);
    expect(new Set(drained).size).toBe(500);
    expect(sim.drainDirty(() => undefined)).toBe(0);
  });

  it('moves agents onto a connected half-edge at the exact arrival time', () => {
    const sim = simulation(2000);
    sim.drainDirty(() => undefined);
    const before = Array.from(sim.store.halfEdge);
    const due = Array.from(sim.store.nextEvent);
    // Under 18.75 s (30 m at the fastest 1.6 m/s), so no agent can arrive twice.
    const stats = sim.step(15_000);
    expect(stats.events).toBeGreaterThan(0);
    let changed = 0;
    for (let i = 0; i < 2000; i++) {
      if (sim.store.halfEdge[i] === before[i]) continue;
      changed++;
      // The new half-edge starts where the old one ended…
      expect(halfEdgeStart(graph, sim.store.halfEdge[i])).toBe(halfEdgeEnd(graph, before[i]));
      // …and its record is valid from the arrival time, at the start of the edge.
      expect(sim.store.t0[i]).toBe(due[i]);
      expect(sim.store.s0[i]).toBe(0);
    }
    expect(changed).toBe(stats.events);
    // Only agents that changed edge were marked dirty.
    expect(sim.drainDirty(() => undefined)).toBe(changed);
  });

  it('never processes an event before it is due, and never more than a slot and a step late', () => {
    const sim = simulation(1000);
    let late = 0;
    for (let t = 50; t <= 60_000; t += 50) {
      sim.step(t);
      // One expect per step would be 1.2M calls; count violations and assert once.
      for (let i = 0; i < 1000; i++) if (sim.store.nextEvent[i] <= t - 16 - 50) late++;
    }
    expect(late).toBe(0);
  });

  it('avoids U-turns except at dead ends', () => {
    const sim = simulation(3000);
    const previous = Array.from(sim.store.halfEdge);
    sim.step(30_000);
    for (let i = 0; i < 3000; i++) {
      if (sim.store.t0[i] === 0) continue;
      const node = halfEdgeStart(graph, sim.store.halfEdge[i]);
      const degree = graph.firstHalfEdge[node + 1] - graph.firstHalfEdge[node];
      if (degree > 1 && halfEdgeEnd(graph, previous[i]) === node) {
        expect(sim.store.halfEdge[i]).not.toBe(previous[i] ^ 1);
      }
    }
  });

  it('is deterministic for a seed', () => {
    const a = simulation(1000);
    const b = simulation(1000);
    for (let t = 1000; t <= 40_000; t += 1000) {
      a.step(t);
      b.step(t);
    }
    expect(Array.from(a.store.halfEdge)).toEqual(Array.from(b.store.halfEdge));
    expect(Array.from(a.store.t0)).toEqual(Array.from(b.store.t0));
  });

  it('packs dirty agents into 24-byte GPU records', () => {
    const sim = simulation(10);
    const out = new DataView(new ArrayBuffer(10 * AGENT_RECORD_BYTES));
    let n = 0;
    sim.drainDirty((agent) => {
      sim.store.writeRecord(agent, out, n++);
    });
    const record = readAgentRecord(out, 3);
    expect(record.halfEdge).toBe(sim.store.halfEdge[3]);
    expect(record.speed).toBe(sim.store.speed[3]);
    expect(record.seed).toBe(sim.store.seed[3]);
  });

  it('keeps a near tier around the focus and runs avoidance on it', () => {
    const sim = simulation(4000, { focus: { x: 0, z: 0, radius: 60 }, avoidance: true });
    expect(sim.nearTierSize).toBeGreaterThan(0);
    expect(sim.nearTierSize).toBeLessThan(4000);
    for (let i = 0; i < 4000; i++) {
      const near = (sim.store.state[i] & AgentStateFlag.Near) !== 0;
      const mid = sim.positionAt(i, 0);
      if (near) expect(Math.hypot(mid[0], mid[1])).toBeLessThan(60 + 30);
    }
    sim.drainDirty(() => undefined);
    let changes = 0;
    for (let t = 50; t <= 5000; t += 50) changes += sim.step(t).lateralChanges;
    expect(changes).toBeGreaterThan(0);
    for (let i = 0; i < 4000; i++) expect(Math.abs(sim.store.lateral[i])).toBeLessThanOrEqual(30);
  });
});
