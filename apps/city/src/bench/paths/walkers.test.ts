import { type BakedClip, ClipFlag } from '@city/assets-runtime';
import { AGENT_KIND_ROBOT_BIT, AGENT_KIND_VARIANT_MASK, readAgentRecord } from '@city/core-types';
import { describe, expect, it } from 'vitest';
import {
  agentPoseAt,
  EDGE_FLOATS,
  layoutLineup,
  layoutWalkers,
  walkerAreaSize,
} from './walkers.ts';

const WALK: BakedClip = {
  name: 'walk',
  firstFrame: 10,
  frameCount: 30,
  fps: 30,
  strideLength: 1.6,
  duration: 1,
  flags: ClipFlag.Loop,
};

describe('layoutWalkers', () => {
  it('fills count agents, leaves the rest of the capacity zeroed, and is deterministic', () => {
    const humans = [{ robot: false, clipIndex: 3, clipSpeed: 1.5 }];
    const a = layoutWalkers(100, 128, 7, humans, 0, 5000);
    const b = layoutWalkers(100, 128, 7, humans, 0, 5000);
    expect(new Uint8Array(a.records.buffer)).toEqual(new Uint8Array(b.records.buffer));
    expect(a.records.byteLength).toBe(128 * 24);
    expect(a.edges.length).toBe(128 * EDGE_FLOATS);

    for (let i = 0; i < 100; i++) {
      const r = readAgentRecord(a.records, i);
      expect(r.halfEdge >>> 1).toBe(i);
      expect(r.anim).toBe(3);
      expect(r.t0).toBe(5000);
      expect(r.speed).toBeGreaterThanOrEqual(1500 * 0.85 - 1);
      expect(r.speed).toBeLessThanOrEqual(1500 * 1.15 + 1);
      expect(r.s0).toBeLessThan(a.edges[i * EDGE_FLOATS + 3] ?? 0);
    }
    expect(readAgentRecord(a.records, 100).speed).toBe(0);
    expect(a.areaSize).toBeCloseTo(walkerAreaSize(100), 6);
  });

  it('mixes robots in at the requested share, with their own clip and speed', () => {
    const families = [
      { robot: false, clipIndex: 6, clipSpeed: 1.66 },
      { robot: true, clipIndex: 10, clipSpeed: 1.42 },
    ];
    const layout = layoutWalkers(2000, 2048, 3, families, 0.25, 0);
    let robots = 0;
    for (let i = 0; i < 2000; i++) {
      const r = readAgentRecord(layout.records, i);
      const isRobot = (r.kind & AGENT_KIND_ROBOT_BIT) !== 0;
      if (isRobot) robots++;
      expect(r.anim).toBe(isRobot ? 10 : 6);
      const base = isRobot ? 1420 : 1660;
      expect(r.speed).toBeGreaterThanOrEqual(base * 0.85 - 1);
      expect(r.speed).toBeLessThanOrEqual(base * 1.15 + 1);
    }
    expect(robots / 2000).toBeGreaterThan(0.2);
    expect(robots / 2000).toBeLessThan(0.3);
  });

  it('spreads humans across base meshes through the variant bits', () => {
    const families = [
      { robot: false, clipIndex: 6, clipSpeed: 1.66 },
      { robot: false, clipIndex: 3, clipSpeed: 1.3 },
    ];
    const layout = layoutWalkers(1000, 1024, 5, families, 0, 0);
    const perBase = [0, 0];
    for (let i = 0; i < 1000; i++) {
      const r = readAgentRecord(layout.records, i);
      const base = r.kind & AGENT_KIND_VARIANT_MASK;
      perBase[base] = (perBase[base] ?? 0) + 1;
      expect(r.anim).toBe(base === 0 ? 6 : 3);
    }
    expect(perBase[0]).toBeGreaterThan(400);
    expect(perBase[1]).toBeGreaterThan(400);
  });

  it('makes every agent a robot when only robots are loaded', () => {
    const layout = layoutWalkers(10, 16, 1, [{ robot: true, clipIndex: 2, clipSpeed: 1 }], 0, 0);
    for (let i = 0; i < 10; i++) {
      expect(readAgentRecord(layout.records, i).kind & AGENT_KIND_ROBOT_BIT).toBe(
        AGENT_KIND_ROBOT_BIT,
      );
    }
  });
});

describe('layoutLineup', () => {
  it('stands agents in rows facing +Z, alternating bases', () => {
    const families = [
      { robot: false, clipIndex: 0, clipSpeed: 1 },
      { robot: false, clipIndex: 0, clipSpeed: 1 },
    ];
    const layout = layoutLineup(8, 8, 1, families, 0, 0);
    for (let i = 0; i < 8; i++) {
      const r = readAgentRecord(layout.records, i);
      expect(r.speed).toBe(0);
      expect(r.kind & AGENT_KIND_VARIANT_MASK).toBe(i % 2);
      expect(layout.edges[i * EDGE_FLOATS + 2]).toBe(0);
    }
    expect(
      new Set(Array.from({ length: 8 }, (_, i) => readAgentRecord(layout.records, i).seed)).size,
    ).toBe(8);
  });
});

describe('agentPoseAt', () => {
  const edges = new Float32Array([2, 3, Math.PI / 2, 10]); // from (2, 3) towards +X, 10 m
  const record = {
    halfEdge: 0,
    s0: 1,
    t0: 1000,
    speed: 2000,
    lateral: 0,
    anim: 0,
    kind: 0,
    flags: 0,
    phase0: 0,
    seed: 0,
  };

  it('dead-reckons along the edge and wraps at its end', () => {
    const at2s = agentPoseAt(record, edges, WALK, 65, 3000);
    expect(at2s.x).toBeCloseTo(2 + 5, 5);
    expect(at2s.z).toBeCloseTo(3, 5);
    expect(at2s.heading).toBeCloseTo(Math.PI / 2, 6);

    const wrapped = agentPoseAt(record, edges, WALK, 65, 1000 + 6000); // s = 1 + 12 → 3
    expect(wrapped.x).toBeCloseTo(2 + 3, 5);
  });

  it('walks reversed half-edges from the far end, facing back', () => {
    const pose = agentPoseAt({ ...record, halfEdge: 1 }, edges, WALK, 65, 3000);
    expect(pose.x).toBeCloseTo(2 + 10 - 5, 5);
    expect(pose.heading).toBeCloseTo(Math.PI * 1.5, 6);
  });

  it('advances phase by distance so faster agents cycle faster', () => {
    // 0.4 s at 2 m/s = 0.8 m = half a 1.6 m stride → frame 15 of 30.
    const pose = agentPoseAt(record, edges, WALK, 65, 1400);
    expect(pose.base0).toBe((10 + 15) * 65);
    expect(pose.alpha).toBeCloseTo(0, 4);

    const slow = agentPoseAt({ ...record, speed: 1000 }, edges, WALK, 65, 1400);
    expect(slow.base0).toBeLessThan(pose.base0);
  });

  it('wraps the loop seam to frame 0 and survives sim-time wrap-around', () => {
    // Just before the end of a stride: frames 29 → 0.
    const pose = agentPoseAt(record, edges, WALK, 65, 1000 + 790);
    expect(pose.base0).toBe((10 + 29) * 65);
    expect(pose.base1).toBe(10 * 65);

    const nearWrap = { ...record, t0: 0xffffffff - 99 };
    const after = agentPoseAt(nearWrap, edges, WALK, 65, 900); // 1 s later across u32 overflow
    expect(after.x).toBeCloseTo(2 + 3, 4);
  });

  it('uses elapsed time for clips that do not travel', () => {
    const idle = { ...WALK, strideLength: 0, duration: 2, frameCount: 60 };
    const pose = agentPoseAt(record, edges, idle, 65, 2000); // 1 s of a 2 s cycle
    expect(pose.base0).toBe((10 + 30) * 65);
  });
});
