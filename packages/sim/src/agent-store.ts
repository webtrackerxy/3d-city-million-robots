import { AGENT_RECORD_BYTES, AgentRecordOffset } from '@city/core-types';

/**
 * Authoritative agent state (implementation plan §14): structure-of-arrays over one
 * (Shared)ArrayBuffer, so every worker can view the same memory. 32 bytes per agent.
 */
export const AGENT_STORE_BYTES_PER_AGENT = 32;

export const AgentStateFlag = {
  /** In the dirty list since the last drain. */
  Dirty: 1 << 0,
  /** Near tier (T0): runs per-tick local avoidance. */
  Near: 1 << 1,
} as const;

export class AgentStore {
  readonly capacity: number;
  readonly buffer: ArrayBufferLike;
  /** edge * 2 + direction. */
  readonly halfEdge: Uint32Array;
  /** Sim time (ms) at which s0 was valid. */
  readonly t0: Uint32Array;
  /** Sim time (ms) the agent reaches the end of its half-edge. */
  readonly nextEvent: Uint32Array;
  /** Appearance / PRNG seed (uploaded). */
  readonly seed: Uint32Array;
  /** xorshift32 state for route choices (CPU only). */
  readonly rng: Uint32Array;
  /** Metres along the half-edge at t0. */
  readonly s0: Float32Array;
  /** mm/s. */
  readonly speed: Uint16Array;
  /** Animation phase at t0, 0..65535 = one cycle. */
  readonly phase0: Uint16Array;
  /** Lane offset, 2 cm units. */
  readonly lateral: Int8Array;
  readonly anim: Uint8Array;
  readonly kind: Uint8Array;
  /** AgentStateFlag bits (CPU only). */
  readonly state: Uint8Array;

  static bytesFor(capacity: number): number {
    return capacity * AGENT_STORE_BYTES_PER_AGENT;
  }

  constructor(buffer: ArrayBufferLike, capacity: number) {
    if (buffer.byteLength < AgentStore.bytesFor(capacity)) {
      throw new RangeError(`AgentStore needs ${AgentStore.bytesFor(capacity)} bytes`);
    }
    this.buffer = buffer;
    this.capacity = capacity;
    let offset = 0;
    const take = <T>(make: (b: ArrayBufferLike, o: number, n: number) => T, bytes: number): T => {
      const view = make(buffer, offset, capacity);
      offset += bytes * capacity;
      return view;
    };
    this.halfEdge = take((b, o, n) => new Uint32Array(b, o, n), 4);
    this.t0 = take((b, o, n) => new Uint32Array(b, o, n), 4);
    this.nextEvent = take((b, o, n) => new Uint32Array(b, o, n), 4);
    this.seed = take((b, o, n) => new Uint32Array(b, o, n), 4);
    this.rng = take((b, o, n) => new Uint32Array(b, o, n), 4);
    this.s0 = take((b, o, n) => new Float32Array(b, o, n), 4);
    this.speed = take((b, o, n) => new Uint16Array(b, o, n), 2);
    this.phase0 = take((b, o, n) => new Uint16Array(b, o, n), 2);
    this.lateral = take((b, o, n) => new Int8Array(b, o, n), 1);
    this.anim = take((b, o, n) => new Uint8Array(b, o, n), 1);
    this.kind = take((b, o, n) => new Uint8Array(b, o, n), 1);
    this.state = take((b, o, n) => new Uint8Array(b, o, n), 1);
  }

  /** Writes agent `agent` as the 24-byte GPU record at `recordIndex` of `out`. */
  writeRecord(agent: number, out: DataView, recordIndex: number): void {
    const base = recordIndex * AGENT_RECORD_BYTES;
    out.setUint32(base + AgentRecordOffset.HalfEdge, this.halfEdge[agent], true);
    out.setFloat32(base + AgentRecordOffset.S0, this.s0[agent], true);
    out.setUint32(base + AgentRecordOffset.T0, this.t0[agent], true);
    out.setUint16(base + AgentRecordOffset.Speed, this.speed[agent], true);
    out.setInt8(base + AgentRecordOffset.Lateral, this.lateral[agent]);
    out.setUint8(base + AgentRecordOffset.Anim, this.anim[agent]);
    out.setUint8(base + AgentRecordOffset.Kind, this.kind[agent]);
    out.setUint8(base + AgentRecordOffset.Flags, 0);
    out.setUint16(base + AgentRecordOffset.Phase0, this.phase0[agent], true);
    out.setUint32(base + AgentRecordOffset.Seed, this.seed[agent], true);
  }
}

/** Allocates shared memory when the environment allows it (workers), else a plain buffer. */
export function allocateAgentBuffer(capacity: number, shared: boolean): ArrayBufferLike {
  const bytes = AgentStore.bytesFor(capacity);
  return shared && typeof SharedArrayBuffer === 'function'
    ? new SharedArrayBuffer(bytes)
    : new ArrayBuffer(bytes);
}
