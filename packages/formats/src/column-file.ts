/**
 * Binary runtime format v1 (implementation plan Appendix A): little-endian, one file per tile
 * and kind, a 32-byte header, a column table, then 8-byte-aligned columns. Readers build typed
 * array views straight over the fetched ArrayBuffer — no parsing — and skip unknown columns, so
 * columns can be added without breaking old readers.
 *
 *   header   offset  type  field
 *            0       u32   magic 'CNAV'
 *            4       u16   version
 *            6       u16   kind (FileKind)
 *            8       i32   tileX
 *            12      i32   tileY
 *            16      f32   tileSizeM
 *            20      u32   count (rows)
 *            24      u32   columnTableOffset
 *            28      u32   reserved
 *   table    u32 columnCount, then per column: u16 columnId, u16 type, u32 byteOffset, u32 elementCount
 */
export const FORMAT_MAGIC = 0x56414e43; // 'CNAV' read as little-endian u32
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 32;
const COLUMN_ENTRY_BYTES = 12;
const ALIGNMENT = 8;

export const ColumnType = {
  U8: 1,
  I8: 2,
  U16: 3,
  I16: 4,
  U32: 5,
  I32: 6,
  F32: 7,
  F64: 8,
} as const;
export type ColumnType = (typeof ColumnType)[keyof typeof ColumnType];

const ELEMENT_BYTES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 7: 4, 8: 8 };

export type ColumnArray =
  | Uint8Array
  | Int8Array
  | Uint16Array
  | Int16Array
  | Uint32Array
  | Int32Array
  | Float32Array
  | Float64Array;

export interface FileHeader {
  version: number;
  kind: number;
  tileX: number;
  tileY: number;
  tileSizeM: number;
  count: number;
}

export interface ColumnFile {
  header: FileHeader;
  /** Views over the file's buffer, keyed by column id. */
  columns: Map<number, ColumnArray>;
}

export class FormatError extends Error {}

function typeOf(array: ColumnArray): ColumnType {
  if (array instanceof Uint8Array) return ColumnType.U8;
  if (array instanceof Int8Array) return ColumnType.I8;
  if (array instanceof Uint16Array) return ColumnType.U16;
  if (array instanceof Int16Array) return ColumnType.I16;
  if (array instanceof Uint32Array) return ColumnType.U32;
  if (array instanceof Int32Array) return ColumnType.I32;
  if (array instanceof Float32Array) return ColumnType.F32;
  return ColumnType.F64;
}

function view(type: number, buffer: ArrayBuffer, offset: number, length: number): ColumnArray {
  switch (type) {
    case ColumnType.U8:
      return new Uint8Array(buffer, offset, length);
    case ColumnType.I8:
      return new Int8Array(buffer, offset, length);
    case ColumnType.U16:
      return new Uint16Array(buffer, offset, length);
    case ColumnType.I16:
      return new Int16Array(buffer, offset, length);
    case ColumnType.U32:
      return new Uint32Array(buffer, offset, length);
    case ColumnType.I32:
      return new Int32Array(buffer, offset, length);
    case ColumnType.F32:
      return new Float32Array(buffer, offset, length);
    case ColumnType.F64:
      return new Float64Array(buffer, offset, length);
    default:
      return new Uint8Array(0); // unknown type: skipped by callers via the id lookup
  }
}

const align = (n: number): number => Math.ceil(n / ALIGNMENT) * ALIGNMENT;

export function writeColumnFile(
  header: Omit<FileHeader, 'version'>,
  columns: readonly { id: number; data: ColumnArray }[],
): ArrayBuffer {
  const ids = new Set<number>();
  for (const column of columns) {
    if (ids.has(column.id)) throw new FormatError(`Duplicate column id ${column.id}`);
    ids.add(column.id);
  }
  const tableOffset = HEADER_BYTES;
  let offset = align(tableOffset + 4 + columns.length * COLUMN_ENTRY_BYTES);
  const placed = columns.map((column) => {
    const at = offset;
    offset = align(offset + column.data.byteLength);
    return { ...column, at };
  });

  const buffer = new ArrayBuffer(offset);
  const dv = new DataView(buffer);
  dv.setUint32(0, FORMAT_MAGIC, true);
  dv.setUint16(4, FORMAT_VERSION, true);
  dv.setUint16(6, header.kind, true);
  dv.setInt32(8, header.tileX, true);
  dv.setInt32(12, header.tileY, true);
  dv.setFloat32(16, header.tileSizeM, true);
  dv.setUint32(20, header.count, true);
  dv.setUint32(24, tableOffset, true);
  dv.setUint32(tableOffset, columns.length, true);
  placed.forEach((column, i) => {
    const entry = tableOffset + 4 + i * COLUMN_ENTRY_BYTES;
    dv.setUint16(entry, column.id, true);
    dv.setUint16(entry + 2, typeOf(column.data), true);
    dv.setUint32(entry + 4, column.at, true);
    dv.setUint32(entry + 8, column.data.length, true);
    new Uint8Array(buffer, column.at, column.data.byteLength).set(
      new Uint8Array(column.data.buffer, column.data.byteOffset, column.data.byteLength),
    );
  });
  return buffer;
}

/**
 * Reads a column file from `buffer`, or from the section of it at `byteOffset` (8-byte aligned)
 * spanning `byteLength` bytes (a file inside a tile container). Columns are views, not copies.
 */
export function readColumnFile(
  buffer: ArrayBuffer,
  expectedKind?: number,
  byteOffset = 0,
  byteLength = buffer.byteLength - byteOffset,
): ColumnFile {
  if (byteOffset % 8 !== 0) throw new FormatError('Section not 8-byte aligned');
  if (byteLength < HEADER_BYTES || byteOffset + byteLength > buffer.byteLength)
    throw new FormatError('File shorter than its header');
  const dv = new DataView(buffer, byteOffset, byteLength);
  if (dv.getUint32(0, true) !== FORMAT_MAGIC) throw new FormatError('Not a CNAV file (bad magic)');
  const header: FileHeader = {
    version: dv.getUint16(4, true),
    kind: dv.getUint16(6, true),
    tileX: dv.getInt32(8, true),
    tileY: dv.getInt32(12, true),
    tileSizeM: dv.getFloat32(16, true),
    count: dv.getUint32(20, true),
  };
  if (header.version > FORMAT_VERSION) {
    throw new FormatError(
      `Format version ${header.version} is newer than this reader (${FORMAT_VERSION})`,
    );
  }
  if (expectedKind !== undefined && header.kind !== expectedKind) {
    throw new FormatError(`Expected file kind ${expectedKind}, got ${header.kind}`);
  }
  const table = dv.getUint32(24, true);
  const columnCount = dv.getUint32(table, true);
  const columns = new Map<number, ColumnArray>();
  for (let i = 0; i < columnCount; i++) {
    const entry = table + 4 + i * COLUMN_ENTRY_BYTES;
    const id = dv.getUint16(entry, true);
    const type = dv.getUint16(entry + 2, true);
    const at = dv.getUint32(entry + 4, true);
    const length = dv.getUint32(entry + 8, true);
    if (type < ColumnType.U8 || type > ColumnType.F64) continue; // unknown type: skip
    if (at + length * ELEMENT_BYTES[type] > byteLength) {
      throw new FormatError(`Column ${id} runs past the end of the file`);
    }
    columns.set(id, view(type, buffer, byteOffset + at, length));
  }
  return { header, columns };
}
