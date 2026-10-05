import { describe, expect, it } from 'vitest';
import { allocateShared, RingReader, RingWriter } from './shared.ts';

describe('dirty ring', () => {
  it('hands the reader exactly what was published, in order', () => {
    const shared = allocateShared(100, 1, 16);
    const writer = new RingWriter(shared.rings[0]);
    const reader = new RingReader(shared.rings[0]);
    writer.push(3);
    writer.push(7);
    expect(reader.drain()?.count).toBe(0); // not yet published
    writer.publish();
    const batch = reader.drain();
    expect(Array.from(batch?.ids.subarray(0, batch.count) ?? [])).toEqual([3, 7]);
    expect(reader.drain()?.count).toBe(0);
  });

  it('wraps around, and reports an overflow when the writer laps the reader', () => {
    const shared = allocateShared(100, 1, 16); // capacity 1024
    const writer = new RingWriter(shared.rings[0]);
    const reader = new RingReader(shared.rings[0]);
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 700; i++) writer.push(i);
      writer.publish();
      const batch = reader.drain();
      expect(batch?.count).toBe(700);
      expect(batch?.ids[699]).toBe(699);
    }
    for (let i = 0; i < 2000; i++) writer.push(i);
    writer.publish();
    expect(reader.drain()).toBeNull();
    expect(reader.drain()?.count).toBe(0);
  });
});
