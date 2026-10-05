/**
 * Minimal GLB reading and writing: enough to take geometry from one model, a skeleton and clips
 * from another, and write a skinned model. No textures, no sparse accessors, no extensions beyond
 * passing material JSON through.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- glTF JSON is read untyped */

export type GltfJson = any;

export interface Glb {
  json: GltfJson;
  bin: Uint8Array;
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

export function readGlb(bytes: Uint8Array): Glb {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a GLB file');
  let offset = 12;
  let json: GltfJson = null;
  let bin: Uint8Array = new Uint8Array(0);
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(data));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + length;
  }
  if (json === null) throw new Error('GLB without a JSON chunk');
  return { json, bin };
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** An accessor's values as floats (integers converted), `itemSize` per element. */
export function readAccessor(glb: Glb, index: number): { values: Float64Array; itemSize: number } {
  const accessor = glb.json.accessors[index];
  const itemSize = COMPONENTS[accessor.type as string] ?? 1;
  const count = accessor.count as number;
  const values = new Float64Array(count * itemSize);
  if (accessor.bufferView === undefined) return { values, itemSize };
  const bufferView = glb.json.bufferViews[accessor.bufferView];
  const base = Number(bufferView.byteOffset ?? 0) + Number(accessor.byteOffset ?? 0);
  const view = new DataView(glb.bin.buffer, glb.bin.byteOffset, glb.bin.byteLength);
  const type = accessor.componentType as number;
  const size = type === 5126 || type === 5125 ? 4 : type === 5123 || type === 5122 ? 2 : 1;
  const stride = (bufferView.byteStride as number | undefined) ?? size * itemSize;
  const read = (at: number): number => {
    switch (type) {
      case 5126:
        return view.getFloat32(at, true);
      case 5125:
        return view.getUint32(at, true);
      case 5123:
        return view.getUint16(at, true);
      case 5122:
        return view.getInt16(at, true);
      case 5121:
        return view.getUint8(at);
      default:
        return view.getInt8(at);
    }
  };
  for (let i = 0; i < count; i++)
    for (let c = 0; c < itemSize; c++)
      values[i * itemSize + c] = read(base + i * stride + c * size);
  return { values, itemSize };
}

type ComponentArray = Float32Array | Uint32Array | Uint16Array | Uint8Array;

/** Accumulates buffer views and accessors into one binary chunk. */
export class GlbWriter {
  readonly json: GltfJson = {
    asset: { version: '2.0', generator: '@city/auto-rig' },
    buffers: [{ byteLength: 0 }],
    bufferViews: [],
    accessors: [],
  };
  private readonly chunks: Uint8Array[] = [];
  private length = 0;

  /** Adds an accessor over `data`; `minMax` records bounds (POSITION and animation inputs). */
  accessor(
    data: ComponentArray,
    type: keyof typeof COMPONENTS,
    options: { target?: number; minMax?: boolean; normalized?: boolean } = {},
  ): number {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) this.push(new Uint8Array(padding));
    const view = this.json.bufferViews.length;
    this.json.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
      ...(options.target === undefined ? {} : { target: options.target }),
    });
    this.push(bytes);
    const itemSize = COMPONENTS[type] ?? 1;
    const componentType =
      data instanceof Float32Array
        ? 5126
        : data instanceof Uint32Array
          ? 5125
          : data instanceof Uint16Array
            ? 5123
            : 5121;
    const accessor: GltfJson = {
      bufferView: view,
      componentType,
      count: data.length / itemSize,
      type,
      ...(options.normalized === true ? { normalized: true } : {}),
    };
    if (options.minMax === true) {
      const min = new Array<number>(itemSize).fill(Infinity);
      const max = new Array<number>(itemSize).fill(-Infinity);
      for (let i = 0; i < data.length; i++) {
        const c = i % itemSize;
        min[c] = Math.min(min[c] ?? Infinity, data[i] ?? 0);
        max[c] = Math.max(max[c] ?? -Infinity, data[i] ?? 0);
      }
      accessor.min = min;
      accessor.max = max;
    }
    this.json.accessors.push(accessor);
    return this.json.accessors.length - 1;
  }

  /** A plain buffer view over `bytes` (e.g. an embedded image); returns its index. */
  view(bytes: Uint8Array): number {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) this.push(new Uint8Array(padding));
    this.json.bufferViews.push({
      buffer: 0,
      byteOffset: this.length,
      byteLength: bytes.byteLength,
    });
    this.push(bytes);
    return this.json.bufferViews.length - 1;
  }

  private push(bytes: Uint8Array): void {
    this.chunks.push(bytes.slice());
    this.length += bytes.byteLength;
  }

  toGlb(): Uint8Array {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) this.push(new Uint8Array(padding));
    this.json.buffers[0].byteLength = this.length;
    const jsonText = JSON.stringify(this.json);
    const jsonBytes = new TextEncoder().encode(
      jsonText + ' '.repeat((4 - (new TextEncoder().encode(jsonText).byteLength % 4)) % 4),
    );
    const total = 12 + 8 + jsonBytes.byteLength + 8 + this.length;
    const out = new Uint8Array(total);
    const view = new DataView(out.buffer);
    view.setUint32(0, GLB_MAGIC, true);
    view.setUint32(4, 2, true);
    view.setUint32(8, total, true);
    view.setUint32(12, jsonBytes.byteLength, true);
    view.setUint32(16, CHUNK_JSON, true);
    out.set(jsonBytes, 20);
    let offset = 20 + jsonBytes.byteLength;
    view.setUint32(offset, this.length, true);
    view.setUint32(offset + 4, CHUNK_BIN, true);
    offset += 8;
    for (const chunk of this.chunks) {
      out.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return out;
  }
}
