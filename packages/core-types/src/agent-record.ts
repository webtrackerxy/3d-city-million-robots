/**
 * Byte layout of the per-agent GPU upload record (implementation plan §14).
 *
 * This layout is the whole contract between the simulation and the renderer: the simulation
 * writes records, the renderer binds them as a storage buffer. Keep it in sync with the WGSL
 * struct in the render package.
 *
 *   offset  type  field
 *   0       u32   halfEdge   edgeId * 2 + direction
 *   4       f32   s0         metres along the edge at t0
 *   8       u32   t0         simulation time of the last update, in ms
 *   12      u16   speed      mm/s
 *   14      i8    lateral    lane offset, 2 cm units
 *   15      u8    anim       animation clip id
 *   16      u8    kind       bit 7 = robot, bits 0..6 = base model variant
 *   17      u8    flags      AgentFlag bits
 *   18      u16   phase0     animation phase at t0, 0..65535 = one cycle
 *   20      u32   seed       appearance + PRNG stream
 */
export const AGENT_RECORD_BYTES = 24;

export const AgentRecordOffset = {
  HalfEdge: 0,
  S0: 4,
  T0: 8,
  Speed: 12,
  Lateral: 14,
  Anim: 15,
  Kind: 16,
  Flags: 17,
  Phase0: 18,
  Seed: 20,
} as const;

/**
 * GPU edge record the integrate kernels read, one per (straight) edge: start x, start z (Three
 * coordinates), heading in radians (0 = +Z) and length in metres.
 */
export const GPU_EDGE_FLOATS = 4;

export const AGENT_KIND_ROBOT_BIT = 0x80;
export const AGENT_KIND_VARIANT_MASK = 0x7f;

export const AgentFlag = {
  /** Inside a building (aggregated): simulated, not drawn. */
  Hidden: 1 << 0,
  /** Walking on a roof: drawn only where its building is (see the crowd's roof area). */
  Roof: 1 << 1,
} as const;

export interface AgentRecord {
  halfEdge: number;
  s0: number;
  t0: number;
  speed: number;
  lateral: number;
  anim: number;
  kind: number;
  flags: number;
  phase0: number;
  seed: number;
}

export function packAgentKind(isRobot: boolean, variant: number): number {
  return (isRobot ? AGENT_KIND_ROBOT_BIT : 0) | (variant & AGENT_KIND_VARIANT_MASK);
}

export function writeAgentRecord(view: DataView, index: number, record: AgentRecord): void {
  const base = index * AGENT_RECORD_BYTES;
  view.setUint32(base + AgentRecordOffset.HalfEdge, record.halfEdge, true);
  view.setFloat32(base + AgentRecordOffset.S0, record.s0, true);
  view.setUint32(base + AgentRecordOffset.T0, record.t0, true);
  view.setUint16(base + AgentRecordOffset.Speed, record.speed, true);
  view.setInt8(base + AgentRecordOffset.Lateral, record.lateral);
  view.setUint8(base + AgentRecordOffset.Anim, record.anim);
  view.setUint8(base + AgentRecordOffset.Kind, record.kind);
  view.setUint8(base + AgentRecordOffset.Flags, record.flags);
  view.setUint16(base + AgentRecordOffset.Phase0, record.phase0, true);
  view.setUint32(base + AgentRecordOffset.Seed, record.seed, true);
}

export function readAgentRecord(view: DataView, index: number): AgentRecord {
  const base = index * AGENT_RECORD_BYTES;
  return {
    halfEdge: view.getUint32(base + AgentRecordOffset.HalfEdge, true),
    s0: view.getFloat32(base + AgentRecordOffset.S0, true),
    t0: view.getUint32(base + AgentRecordOffset.T0, true),
    speed: view.getUint16(base + AgentRecordOffset.Speed, true),
    lateral: view.getInt8(base + AgentRecordOffset.Lateral),
    anim: view.getUint8(base + AgentRecordOffset.Anim),
    kind: view.getUint8(base + AgentRecordOffset.Kind),
    flags: view.getUint8(base + AgentRecordOffset.Flags),
    phase0: view.getUint16(base + AgentRecordOffset.Phase0, true),
    seed: view.getUint32(base + AgentRecordOffset.Seed, true),
  };
}
