/*
 * Ported from the 3d-city-million-cars project (src/simulation, src/data), same author: the
 * road graph, traffic model and vehicle buffer, reading this project's road network file.
 */
/**
 * Road-following synthetic traffic (spec §31, phase C4). Every vehicle sits on a
 * directed edge at a distance along it, accelerates toward the edge's speed limit
 * scaled by a per-vehicle factor, slows before junctions, and picks a random outgoing
 * edge at the end (avoiding immediate U-turns when it can). Dead ends respawn the
 * vehicle at a random network position.
 *
 * Car following uses a simplified Intelligent Driver Model: each tick vehicles are
 * grouped per edge (counting sort) and ordered leader-first; a vehicle accelerates toward
 * its desired speed but brakes to keep gap ≥ s0 + v·T from the vehicle ahead, which may
 * be the tail vehicle of its planned next edge. Nobody overtakes: positions are clamped
 * behind the leader. Everything is typed arrays; `step` allocates nothing.
 */

import type { RoadNetwork } from './road-network.ts';
import type { VehicleBuffer } from './vehicle-buffer.ts';

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RoadTrafficOptions {
  count: number;
  tickInterval?: number;
  seed?: number;
  /** m/s² */
  acceleration?: number;
  /** speed factor range applied to the edge limit per vehicle */
  speedFactor?: [number, number];
  /** speed limit through a junction, m/s */
  junctionSpeed?: number;
  /** keep to the left of the centreline on two-way roads (UK, Japan, Hong Kong); right otherwise */
  driveOnLeft?: boolean;
  /** lateral distance from the centreline on two-way roads, metres (half a 3.5 m lane) */
  laneOffset?: number;
  /** IDM parameters */
  vehicleLength?: number;
  minGap?: number;
  headwayTime?: number;
  comfortableDecel?: number;
}

export class RoadTraffic {
  readonly id = 'road-traffic';
  readonly vehicleCount: number;
  readonly tickInterval: number;
  running = false;
  private readonly edge: Int32Array;
  private readonly along: Float32Array;
  private readonly factor: Float32Array;
  /** planned next edge per vehicle (−1 = dead end) */
  private readonly next: Int32Array;
  // per-tick ordering scratch
  private readonly edgeStart: Int32Array;
  private readonly edgeFill: Int32Array;
  private readonly order: Uint32Array;
  private readonly tailVehicle: Int32Array;
  private readonly vehicleLength: number;
  private readonly minGap: number;
  private readonly headway: number;
  private readonly comfortDecel: number;
  private readonly rand: () => number;
  /** signed lateral offset: +left / −right of the direction of travel */
  private readonly lateral: number;
  private readonly accel: number;
  private readonly junctionSpeed: number;
  private accumulator = 0;
  /** milliseconds spent in the last step() */
  lastStepMs = 0;
  private readonly buffer: VehicleBuffer;
  readonly network: RoadNetwork;

  constructor(buffer: VehicleBuffer, network: RoadNetwork, opts: RoadTrafficOptions) {
    this.buffer = buffer;
    this.network = network;
    if (opts.count > buffer.capacity) throw new RangeError('count exceeds buffer capacity');
    if (network.edgeCount === 0) throw new Error('road network has no edges');
    this.vehicleCount = opts.count;
    this.tickInterval = opts.tickInterval ?? 0.1;
    this.accel = opts.acceleration ?? 2.5;
    this.junctionSpeed = opts.junctionSpeed ?? 6;
    this.vehicleLength = opts.vehicleLength ?? 4.5;
    this.minGap = opts.minGap ?? 2;
    this.headway = opts.headwayTime ?? 1.0;
    this.comfortDecel = opts.comfortableDecel ?? 3;
    this.lateral = (opts.laneOffset ?? 1.75) * (opts.driveOnLeft ? 1 : -1);
    this.rand = mulberry32(opts.seed ?? 11);
    this.next = new Int32Array(opts.count);
    this.edgeStart = new Int32Array(network.edgeCount + 1);
    this.edgeFill = new Int32Array(network.edgeCount);
    this.order = new Uint32Array(opts.count);
    this.tailVehicle = new Int32Array(network.edgeCount).fill(-1);
    const [fLo, fHi] = opts.speedFactor ?? [0.7, 1.15];
    this.edge = new Int32Array(opts.count);
    this.along = new Float32Array(opts.count);
    this.factor = new Float32Array(opts.count);
    // spawn evenly along the whole network so density is uniform per metre of road
    const spacing = network.totalLength / opts.count;
    const jitter = spacing * 0.5;
    for (let i = 0; i < opts.count; i++) {
      const d = (i * spacing + this.rand() * jitter) % network.totalLength;
      const { edge, offset } = network.edgeAtDistance(d);
      this.edge[i] = edge;
      this.along[i] = offset;
      this.next[i] = this.nextEdge(edge);
      this.factor[i] = fLo + this.rand() * (fHi - fLo);
      const speed = network.edgeSpeed[edge] * this.factor[i];
      buffer.set(i, {
        x: 0,
        y: 0,
        z: 0,
        heading: network.edgeHeading[edge],
        speed,
        vehicleType: 0,
        colorIndex: Math.floor(this.rand() * 16),
      });
    }
    this.writePositions();
  }

  start(): void {
    this.running = true;
  }

  stop(): void {
    this.running = false;
  }

  tick(dtSeconds: number): number {
    if (!this.running) return 0;
    this.accumulator += Math.min(dtSeconds, 1);
    let ticks = 0;
    while (this.accumulator >= this.tickInterval) {
      this.step(this.tickInterval);
      this.accumulator -= this.tickInterval;
      ticks++;
    }
    return ticks;
  }

  step(dt: number): void {
    const t0 = performance.now();
    const net = this.network;
    const { speed, heading } = this.buffer;
    const edge = this.edge;
    const along = this.along;
    const next = this.next;
    const n = this.vehicleCount;
    const E = net.edgeCount;
    const L = this.vehicleLength;
    const s0 = this.minGap;
    const T = this.headway;
    const A = this.accel;
    const B = this.comfortDecel;
    const sqrtAB2 = 2 * Math.sqrt(A * B);

    // 1. group vehicles per edge (counting sort) and order each group leader-first
    const edgeStart = this.edgeStart;
    const fill = this.edgeFill;
    const order = this.order;
    edgeStart.fill(0);
    for (let i = 0; i < n; i++) edgeStart[edge[i] + 1] = edgeStart[edge[i] + 1] + 1;
    for (let e = 0; e < E; e++) edgeStart[e + 1] = edgeStart[e + 1] + edgeStart[e];
    fill.fill(0);
    for (let i = 0; i < n; i++) {
      const e = edge[i];
      order[edgeStart[e] + fill[e]] = i;
      fill[e] = fill[e] + 1;
    }
    const tail = this.tailVehicle;
    for (let e = 0; e < E; e++) {
      const a = edgeStart[e];
      const b = edgeStart[e + 1];
      if (a === b) {
        tail[e] = -1;
        continue;
      }
      // insertion sort by along descending (groups are small)
      for (let k = a + 1; k < b; k++) {
        const id = order[k];
        const key = along[id];
        let j = k - 1;
        while (j >= a && along[order[j]] < key) {
          order[j + 1] = order[j];
          j--;
        }
        order[j + 1] = id;
      }
      tail[e] = order[b - 1];
    }

    // 2. update in leader-first order so followers see the leader's new position
    for (let e = 0; e < E; e++) {
      const a = edgeStart[e];
      const b = edgeStart[e + 1];
      const len = net.edgeLength[e];
      for (let k = a; k < b; k++) {
        const i = order[k];
        const v = speed[i];
        const s = along[i];

        // gap to the leader: same edge, or the tail of the planned next edge
        let gap = 1e9;
        let leaderV = v;
        if (k > a) {
          // the leader was updated first this tick and may already be on the next edge
          const lead = order[k - 1];
          const le = edge[lead];
          if (le === e) gap = along[lead] - s - L;
          else if (le === next[i]) gap = len - s + along[lead] - L;
          leaderV = speed[lead];
        } else {
          const ne = next[i];
          const lead = ne >= 0 ? tail[ne] : -1;
          if (lead >= 0 && lead !== i && edge[lead] === ne) {
            gap = len - s + along[lead] - L;
            leaderV = speed[lead];
          }
        }

        // desired speed: limit × factor, junction slow-down
        const limit = net.edgeSpeed[e] * this.factor[i];
        const remaining = len - s;
        const junctionLimit = this.junctionSpeed + Math.sqrt(2 * A * Math.max(0, remaining - 4));
        const v0 = Math.max(0.5, Math.min(limit, junctionLimit));

        // IDM acceleration
        const dv = v - leaderV;
        const sStar = s0 + Math.max(0, v * T + (v * dv) / sqrtAB2);
        const safeGap = gap < 0.1 ? 0.1 : gap;
        let acc = A * (1 - Math.pow(v / v0, 4) - (sStar / safeGap) * (sStar / safeGap));
        if (acc < -2 * B) acc = -2 * B;
        let nv = v + acc * dt;
        if (nv < 0) nv = 0;
        let ns = s + nv * dt;
        // never pass the leader
        if (gap < 1e8 && ns > s + gap) {
          ns = s + Math.max(0, gap);
          nv = Math.min(nv, leaderV);
        }
        speed[i] = nv;

        // advance across edges
        let ce = e;
        let clen = len;
        while (ns >= clen) {
          ns -= clen;
          const ne = next[i];
          if (ne < 0) {
            const spot = net.edgeAtDistance(this.rand() * net.totalLength);
            ce = spot.edge;
            ns = spot.offset;
            speed[i] = 0;
          } else {
            ce = ne;
          }
          next[i] = this.nextEdge(ce);
          clen = net.edgeLength[ce];
        }
        edge[i] = ce;
        along[i] = ns;
        heading[i] = net.edgeHeading[ce];
      }
    }
    this.writePositions();
    this.lastStepMs = performance.now() - t0;
  }

  private nextEdge(e: number): number {
    const net = this.network;
    const node = net.edgeTo[e];
    const degree = net.outDegree(node);
    if (degree === 0) return -1;
    if (degree === 1) return net.outEdge(node, 0);
    // avoid the edge that leads straight back where we came from, if there is a choice
    const from = net.edgeFrom[e];
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = net.outEdge(node, Math.floor(this.rand() * degree));
      if (net.edgeTo[candidate] !== from) return candidate;
    }
    return net.outEdge(node, Math.floor(this.rand() * degree));
  }

  private writePositions(): void {
    const net = this.network;
    const { x, y, z } = this.buffer;
    const edge = this.edge;
    const along = this.along;
    const lateral = this.lateral;
    for (let i = 0; i < this.vehicleCount; i++) {
      const e = edge[i];
      const from = net.edgeFrom[e];
      const to = net.edgeTo[e];
      const s = along[i];
      const dx = net.edgeDirX[e];
      const dz = net.edgeDirZ[e];
      // left of travel in the x-east / z-south frame is (dz, −dx); one-way roads stay centred
      const off = net.edgeTwoWay[e] * lateral;
      x[i] = net.nodeX[from] + dx * s + dz * off;
      z[i] = net.nodeZ[from] + dz * s - dx * off;
      // elevation: linear along the edge (0 everywhere when no terrain is applied)
      const t = s / net.edgeLength[e];
      y[i] = net.nodeY[from] * (1 - t) + net.nodeY[to] * t;
    }
  }

  dispose(): void {
    this.running = false;
  }
}
