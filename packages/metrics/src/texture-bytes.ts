interface TexelBlock {
  width: number;
  height: number;
  bytes: number;
}

const SPECIAL_FORMATS: Readonly<Record<string, TexelBlock>> = {
  stencil8: texel(1),
  depth16unorm: texel(2),
  depth24plus: texel(4),
  'depth24plus-stencil8': texel(4),
  depth32float: texel(4),
  'depth32float-stencil8': texel(5),
  rgb9e5ufloat: texel(4),
  rgb10a2unorm: texel(4),
  rgb10a2uint: texel(4),
  rg11b10ufloat: texel(4),
};

const BLOCK_4X4_BYTES: Readonly<Record<string, number>> = {
  bc1: 8,
  bc2: 16,
  bc3: 16,
  bc4: 8,
  bc5: 16,
  bc6h: 16,
  bc7: 16,
  'etc2-rgb8unorm': 8,
  'etc2-rgb8a1unorm': 8,
  'etc2-rgba8unorm': 16,
  'eac-r11': 8,
  'eac-rg11': 16,
};

const CHANNEL_COUNT: Readonly<Record<string, number>> = { r: 1, rg: 2, rgba: 4, bgra: 4 };

function texel(bytes: number): TexelBlock {
  return { width: 1, height: 1, bytes };
}

/** Block footprint of a WebGPU texture format. Unknown formats are assumed to be 4 bytes/texel. */
export function texelBlockOf(format: string): TexelBlock {
  const special = SPECIAL_FORMATS[format];
  if (special !== undefined) return special;

  const astc = /^astc-(\d+)x(\d+)-/.exec(format);
  if (astc !== null) return { width: Number(astc[1]), height: Number(astc[2]), bytes: 16 };

  for (const [prefix, bytes] of Object.entries(BLOCK_4X4_BYTES)) {
    if (format.startsWith(prefix)) return { width: 4, height: 4, bytes };
  }

  const plain = /^(rgba|bgra|rg|r)(8|16|32)/.exec(format);
  if (plain !== null) {
    const channels = CHANNEL_COUNT[plain[1] ?? ''] ?? 4;
    return texel((channels * Number(plain[2])) / 8);
  }

  return texel(4);
}

/**
 * Estimated GPU memory of a texture: all mip levels, layers and samples. Drivers add alignment
 * and padding on top, so treat this as a lower bound that is comparable between runs.
 */
export function estimateTextureBytes(descriptor: GPUTextureDescriptor): number {
  const [width, height, depthOrLayers] = extent(descriptor.size);
  const block = texelBlockOf(descriptor.format);
  const mipLevels = descriptor.mipLevelCount ?? 1;
  const samples = descriptor.sampleCount ?? 1;
  const is3d = descriptor.dimension === '3d';

  let bytes = 0;
  for (let level = 0; level < mipLevels; level++) {
    const w = Math.max(1, width >> level);
    const h = Math.max(1, height >> level);
    const d = is3d ? Math.max(1, depthOrLayers >> level) : depthOrLayers;
    bytes += Math.ceil(w / block.width) * Math.ceil(h / block.height) * block.bytes * d;
  }
  return bytes * samples;
}

function extent(size: GPUExtent3D): [number, number, number] {
  if (Symbol.iterator in size) {
    const [width = 1, height = 1, depthOrLayers = 1] = size;
    return [width, height, depthOrLayers];
  }
  return [size.width, size.height ?? 1, size.depthOrArrayLayers ?? 1];
}
