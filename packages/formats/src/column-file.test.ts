import { describe, expect, it } from 'vitest';
import { FORMAT_MAGIC, FormatError, readColumnFile, writeColumnFile } from './column-file.ts';

const header = { kind: 7, tileX: -3, tileY: 12, tileSizeM: 256, count: 3 };

describe('column files', () => {
  it('round-trips the header and every column type', () => {
    const columns = [
      { id: 1, data: new Uint8Array([1, 2, 255]) },
      { id: 2, data: new Int8Array([-1, 0, 127]) },
      { id: 3, data: new Uint16Array([1, 65535, 3]) },
      { id: 4, data: new Int16Array([-32768, 0, 5]) },
      { id: 5, data: new Uint32Array([0xffffffff, 0, 7]) },
      { id: 6, data: new Int32Array([-1, 2, -3]) },
      { id: 7, data: new Float32Array([1.5, -2.25, 3]) },
      { id: 8, data: new Float64Array([529_000.123456, -1e-9, 3]) },
    ];
    const file = readColumnFile(writeColumnFile(header, columns), 7);
    expect(file.header).toEqual({ version: 1, ...header });
    for (const column of columns) {
      const read = file.columns.get(column.id);
      expect(read?.constructor).toBe(column.data.constructor);
      expect(Array.from(read ?? [])).toEqual(Array.from(column.data));
    }
  });

  it('aligns every column to 8 bytes so views need no copying', () => {
    const buffer = writeColumnFile(header, [
      { id: 1, data: new Uint8Array(3) },
      { id: 2, data: new Float64Array([1, 2]) },
    ]);
    const file = readColumnFile(buffer);
    expect((file.columns.get(2)?.byteOffset ?? 1) % 8).toBe(0);
    expect(file.columns.get(2)?.buffer).toBe(buffer);
  });

  it('skips columns of unknown type', () => {
    const buffer = writeColumnFile(header, [{ id: 1, data: new Uint8Array([9]) }]);
    new DataView(buffer).setUint16(32 + 4 + 2, 99, true); // corrupt the type of column 1
    expect(readColumnFile(buffer).columns.size).toBe(0);
  });

  it('rejects wrong magic, newer versions, wrong kinds and truncated files', () => {
    const buffer = writeColumnFile(header, [{ id: 1, data: new Float32Array(4) }]);
    expect(new DataView(buffer).getUint32(0, true)).toBe(FORMAT_MAGIC);
    expect(() => readColumnFile(buffer, 8)).toThrow(FormatError);
    const newer = buffer.slice(0);
    new DataView(newer).setUint16(4, 2, true);
    expect(() => readColumnFile(newer)).toThrow(/newer/);
    const bad = buffer.slice(0);
    new DataView(bad).setUint32(0, 0, true);
    expect(() => readColumnFile(bad)).toThrow(/magic/);
    expect(() => readColumnFile(buffer.slice(0, buffer.byteLength - 8))).toThrow(/past the end/);
    expect(() => readColumnFile(new ArrayBuffer(8))).toThrow(FormatError);
  });

  it('refuses duplicate column ids', () => {
    expect(() =>
      writeColumnFile(header, [
        { id: 1, data: new Uint8Array(1) },
        { id: 1, data: new Uint8Array(1) },
      ]),
    ).toThrow(/Duplicate/);
  });
});
