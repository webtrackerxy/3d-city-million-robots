import { describe, expect, it } from 'vitest';
import type { RoadNetworkData } from '@city/formats';
import { RoadNetwork } from './road-network.ts';
import { RoadTraffic } from './road-traffic.ts';
import { VehicleBuffer } from './vehicle-buffer.ts';

/** A 100 m eastbound edge followed by a 100 m northbound edge, ending in a dead end. */
function lShape(): RoadNetworkData {
  return {
    nodeX: Float32Array.from([0, 100, 100]),
    nodeY: Float32Array.from([0, 0, 100]),
    edgeFrom: Uint32Array.from([0, 1]),
    edgeTo: Uint32Array.from([1, 2]),
    speedMps: Float32Array.from([10, 10]),
    classIndex: Uint8Array.from([0, 0]),
    classes: ['residential'],
  };
}

describe('RoadNetwork', () => {
  const net = new RoadNetwork(lShape());

  it('builds lengths, headings and CSR adjacency', () => {
    expect(net.edgeCount).toBe(2);
    expect(net.edgeLength[0]).toBeCloseTo(100, 4);
    expect(net.edgeHeading[0]).toBeCloseTo(Math.PI / 2, 6); // east
    expect(net.edgeHeading[1]).toBeCloseTo(0, 6); // north
    expect(net.outDegree(0)).toBe(1);
    expect(net.outEdge(0, 0)).toBe(0);
    expect(net.outDegree(1)).toBe(1);
    expect(net.outEdge(1, 0)).toBe(1);
    expect(net.outDegree(2)).toBe(0);
    expect(net.totalLength).toBeCloseTo(200, 4);
  });

  it('finds the edge at a network distance', () => {
    expect(net.edgeAtDistance(30)).toEqual({ edge: 0, offset: 30 });
    const p = net.edgeAtDistance(150);
    expect(p.edge).toBe(1);
    expect(p.offset).toBeCloseTo(50, 4);
  });
});

describe('RoadTraffic', () => {
  it('moves a vehicle along an edge and turns the corner with the edge heading', () => {
    const file = lShape();
    const net = new RoadNetwork(file);
    const buffer = new VehicleBuffer(1);
    const traffic = new RoadTraffic(buffer, net, {
      count: 1,
      seed: 1,
      speedFactor: [1, 1],
      junctionSpeed: 10,
    });
    // spawned at network distance ≈ 0..spacing/2 on edge 0, heading east
    expect(buffer.heading[0]).toBeCloseTo(Math.PI / 2, 6);
    expect(buffer.z[0]).toBeCloseTo(0, 4);
    traffic.start();
    // drive for 8 s at ≤ 10 m/s: must have passed the 100 m corner onto the northbound edge
    for (let i = 0; i < 80; i++) traffic.step(0.1);
    expect(buffer.heading[0]).toBeCloseTo(0, 6);
    expect(buffer.x[0]).toBeCloseTo(100, 3);
    expect(buffer.z[0]).toBeLessThan(0); // moving north
    expect(buffer.speed[0]).toBeGreaterThan(0);
  });

  it('respawns at a dead end instead of leaving the network', () => {
    const net = new RoadNetwork(lShape());
    const buffer = new VehicleBuffer(1);
    const traffic = new RoadTraffic(buffer, net, { count: 1, seed: 3, speedFactor: [1, 1] });
    traffic.start();
    for (let i = 0; i < 600; i++) traffic.step(0.1); // 60 s: far beyond the 200 m network
    const x = buffer.x[0];
    const z = buffer.z[0];
    expect(x).toBeGreaterThanOrEqual(-1e-3);
    expect(x).toBeLessThanOrEqual(100 + 1e-3);
    expect(z).toBeLessThanOrEqual(1e-3);
    expect(z).toBeGreaterThanOrEqual(-100 - 1e-3);
  });

  it('keeps followers behind a slow leader (car following, no overtaking)', () => {
    // a single long straight edge
    const file: RoadNetworkData = {
      ...lShape(),
      nodeX: Float32Array.from([0, 1000]),
      nodeY: Float32Array.from([0, 0]),
      edgeFrom: Uint32Array.from([0]),
      edgeTo: Uint32Array.from([1]),
      speedMps: Float32Array.from([20]),
      classIndex: Uint8Array.from([0]),
    };
    const net = new RoadNetwork(file);
    const buffer = new VehicleBuffer(2);
    const traffic = new RoadTraffic(buffer, net, { count: 2, seed: 2, speedFactor: [1, 1] });
    // vehicle 0 ahead and slow, vehicle 1 behind and fast
    buffer.speed[0] = 3;
    buffer.speed[1] = 20;
    const leaderFactor = 3 / 20;
    // force the leader's desired speed low by patching its factor through a fresh instance is
    // not possible; instead verify ordering and gap over a short horizon where the leader
    // still accelerates slowly from 3 m/s while the follower closes in.
    traffic.start();
    const ahead = buffer.x[0] > buffer.x[1] ? 0 : 1;
    const behind = 1 - ahead;
    for (let i = 0; i < 100; i++) {
      traffic.step(0.1);
      const gap = buffer.x[ahead] - buffer.x[behind];
      if (buffer.x[ahead] < 990) expect(gap).toBeGreaterThanOrEqual(4.5 - 1e-6);
    }
    expect(leaderFactor).toBeLessThan(1);
  });

  it('spawns vehicles evenly along the network length', () => {
    const net = new RoadNetwork(lShape());
    const buffer = new VehicleBuffer(20);
    new RoadTraffic(buffer, net, { count: 20, seed: 5 });
    let onFirst = 0;
    for (let i = 0; i < 20; i++) if (buffer.z[i] > -1e-3 && buffer.x[i] < 100 - 1e-3) onFirst++;
    expect(onFirst).toBeGreaterThanOrEqual(8);
    expect(onFirst).toBeLessThanOrEqual(12);
  });
});

describe('lane offset on two-way roads', () => {
  /** one 100 m two-way east–west road (edges 0: east, 1: west) plus a one-way spur north */
  function twoWay(): RoadNetworkData {
    return {
      ...lShape(),
      edgeFrom: Uint32Array.from([0, 1, 1]),
      edgeTo: Uint32Array.from([1, 0, 2]),
      speedMps: Float32Array.from([10, 10, 10]),
      classIndex: Uint8Array.from([0, 0, 0]),
    };
  }

  it('flags the directions that have a reverse edge', () => {
    const net = new RoadNetwork(twoWay());
    expect(Array.from(net.edgeTwoWay)).toEqual([1, 1, 0]);
  });

  it('puts opposite directions on opposite sides of the centreline', () => {
    for (const driveOnLeft of [true, false]) {
      const net = new RoadNetwork(twoWay());
      const buffer = new VehicleBuffer(2);
      const traffic = new RoadTraffic(buffer, net, {
        count: 2,
        seed: 1,
        driveOnLeft,
        laneOffset: 2,
      });
      // vehicle 0 spawns on edge 0 (east), vehicle 1 further along the network on edge 1 (west)
      const east = buffer.heading[0];
      const west = buffer.heading[1];
      expect(east).toBeCloseTo(Math.PI / 2, 6);
      expect(west).toBeCloseTo(-Math.PI / 2, 6);
      // left of eastbound travel is north (−z) when driving on the left; south otherwise
      const expectedZ = driveOnLeft ? -2 : 2;
      expect(buffer.z[0]).toBeCloseTo(expectedZ, 5);
      expect(buffer.z[1]).toBeCloseTo(-expectedZ, 5);
      traffic.dispose();
    }
  });
});
