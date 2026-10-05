import { describe, expect, it } from 'vitest';
import {
  AGENT_KIND_ROBOT_BIT,
  AGENT_RECORD_BYTES,
  type AgentRecord,
  packAgentKind,
  readAgentRecord,
  writeAgentRecord,
} from './agent-record.ts';

describe('agent record layout', () => {
  it('is 24 bytes and 4-byte aligned for use as a WGSL storage array element', () => {
    expect(AGENT_RECORD_BYTES).toBe(24);
    expect(AGENT_RECORD_BYTES % 4).toBe(0);
  });

  it('round-trips records without touching neighbouring rows', () => {
    const view = new DataView(new ArrayBuffer(AGENT_RECORD_BYTES * 3));
    const record: AgentRecord = {
      halfEdge: 0xfffffffe,
      s0: 12.5,
      t0: 86_400_000,
      speed: 1400,
      lateral: -37,
      anim: 3,
      kind: packAgentKind(true, 5),
      flags: 0b11,
      phase0: 0xabcd,
      seed: 0xdeadbeef,
    };

    writeAgentRecord(view, 1, record);

    expect(readAgentRecord(view, 1)).toEqual(record);
    expect(new Uint8Array(view.buffer, 0, AGENT_RECORD_BYTES).every((b) => b === 0)).toBe(true);
    expect(
      new Uint8Array(view.buffer, AGENT_RECORD_BYTES * 2, AGENT_RECORD_BYTES).every((b) => b === 0),
    ).toBe(true);
  });

  it('packs the robot bit and variant into one byte', () => {
    expect(packAgentKind(false, 7)).toBe(7);
    expect(packAgentKind(true, 7)).toBe(AGENT_KIND_ROBOT_BIT | 7);
    expect(packAgentKind(true, 0xff)).toBe(0xff);
  });
});
