import {
  type BakedAnimation,
  BONE_MATRIX_FLOATS,
  packClipTable,
  TINT_MASK_ATTRIBUTE,
} from '@city/assets-runtime';
import { AGENT_RECORD_BYTES, RENDER_LOD_DEBUG_COLOURS } from '@city/core-types';
import {
  type BufferAttribute,
  type BufferGeometry,
  Color,
  type InterleavedBufferAttribute,
  type Material,
  MeshStandardMaterial,
} from 'three';
import { PALETTES } from '@city/render';
import { IMPOSTOR_FRAMES, IMPOSTOR_PITCHES, IMPOSTOR_YAWS, type ImpostorAtlas } from '@city/render';
import { EDGE_FLOATS } from '../walkers.ts';
import {
  BUCKETS_PER_FAMILY,
  cullLodWgsl,
  type FamilyConstants,
  groundWgsl,
  IMPOSTOR_BUCKET,
  impostorWgsl,
  integrateWgsl,
  meshWgsl,
  PALETTE_ENTRIES,
  PALETTE_OFFSETS,
  PARAMS_BYTES,
  type SceneLights,
  WORKGROUP,
  writeArgsWgsl,
} from './wgsl.ts';

const INDIRECT_WORDS = 5;
const DRAW_UNIFORM_BYTES = 64;
const DEPTH_FORMAT: GPUTextureFormat = 'depth24plus';

export interface RawFamily {
  animation: BakedAnimation;
  /** geometries[lod][subMesh]. */
  lods: BufferGeometry[][];
  materials: (Material | Material[])[];
  /** Albedo map per sub-mesh as a GPU texture, when the material has one. */
  maps: (GPUTexture | null)[];
  influences: readonly (1 | 4)[];
  height: number;
  forwardAngle: number;
  robot: boolean;
  heightVariation: number;
  impostor: {
    atlas: ImpostorAtlas;
    albedo: GPUTexture;
    normal: GPUTexture;
    mask: GPUTexture;
  } | null;
}

export interface RawCrowdOptions {
  device: GPUDevice;
  colourFormat: GPUTextureFormat;
  capacity: number;
  families: readonly RawFamily[];
  lights: SceneLights;
  groundColour: Color;
}

/** Everything the host writes into the Params uniform each frame. */
export interface FrameParams {
  cameraPosition: [number, number, number];
  simTimeMs: number;
  planes: readonly [number, number, number, number][];
  lodThresholds: readonly [number, number, number, number];
  pxPerRadian: number;
  impostorPx: number;
  fadeMs: number;
  forcedLod: number;
  debugColours: boolean;
  viewProjection: ArrayLike<number>;
  sunDirection: [number, number, number];
}

export interface RawCrowd {
  readonly capacity: number;
  readonly drawCount: number;
  readonly stats: GPUBuffer;
  readonly statsBytes: number;
  setActive(records: DataView<ArrayBuffer>, edges: Float32Array, active: number): void;
  setGroundExtent(extent: number): void;
  writeParams(params: FrameParams): void;
  encodeCompute(pass: GPUComputePassEncoder): void;
  bundle(): GPURenderBundle;
  dispose(): void;
}

/**
 * Path C's GPU crowd: the same buffers and kernels as Path B's gpu-crowd.ts, in hand-written
 * WebGPU. Compute: integrate → cullLod → writeArgs. Render: one static render bundle holding the
 * ground, one indirect draw per (family, LOD, sub-mesh) and one impostor draw per family.
 */
export function createRawCrowd(options: RawCrowdOptions): RawCrowd {
  const { device, capacity, families } = options;
  const owned: { destroy(): void }[] = [];
  const buffer = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const created = device.createBuffer({ label, size: Math.max(16, align4(size)), usage });
    owned.push(created);
    return created;
  };
  const upload = (label: string, data: ArrayBufferView, usage: GPUBufferUsageFlags): GPUBuffer => {
    const created = buffer(label, data.byteLength, usage | GPUBufferUsage.COPY_DST);
    device.queue.writeBuffer(created, 0, data.buffer, data.byteOffset, align4Down(data.byteLength));
    const tail = data.byteLength % 4;
    if (tail !== 0) {
      const padded = new Uint8Array(4);
      padded.set(new Uint8Array(data.buffer, data.byteOffset + data.byteLength - tail, tail));
      device.queue.writeBuffer(created, align4Down(data.byteLength), padded);
    }
    return created;
  };
  const STORAGE = GPUBufferUsage.STORAGE;

  const familyConstants: FamilyConstants = {
    humanCount: families.filter((family) => !family.robot).length,
    robotIndex: families.findIndex((family) => family.robot),
    familyCount: families.length,
  };
  const buckets = families.length * BUCKETS_PER_FAMILY;

  // Shared data: all families' matrices and clip tables back to back, and the family table.
  const matrixFloats = families.reduce((n, f) => n + f.animation.matrices.length, 0);
  const allMatrices = new Float32Array(matrixFloats);
  const clipWords: number[] = [];
  const familyTable = new Float32Array(families.length * 8);
  let matrixOffset = 0;
  families.forEach((family, index) => {
    allMatrices.set(family.animation.matrices, matrixOffset);
    familyTable.set(
      [
        matrixOffset / BONE_MATRIX_FLOATS,
        family.animation.boneCount,
        clipWords.length / 6,
        family.height,
        family.forwardAngle,
        family.height * 0.6,
        family.heightVariation,
        0,
      ],
      index * 8,
    );
    clipWords.push(...new Uint32Array(packClipTable(family.animation.clips)));
    matrixOffset += family.animation.matrices.length;
  });
  const matrices = upload('raw matrices', allMatrices, STORAGE);
  const clips = upload('raw clips', Uint32Array.from(clipWords), STORAGE);
  const familyBuffer = upload('raw families', familyTable, STORAGE);

  const palettes = new Float32Array(PALETTE_ENTRIES * 4);
  const setPalette = (offset: number, colours: readonly (readonly [number, number, number])[]) => {
    colours.forEach((c, i) => {
      palettes.set([c[0], c[1], c[2], 1], (offset + i) * 4);
    });
  };
  setPalette(PALETTE_OFFSETS.top, PALETTES.top);
  setPalette(PALETTE_OFFSETS.bottoms, PALETTES.bottoms);
  setPalette(PALETTE_OFFSETS.skin, PALETTES.skin);
  setPalette(PALETTE_OFFSETS.hair, PALETTES.hair);
  const paletteBuffer = upload('raw palettes', palettes, GPUBufferUsage.UNIFORM);

  // Per-agent state.
  const COPY = GPUBufferUsage.COPY_DST;
  const records = buffer('raw records', capacity * AGENT_RECORD_BYTES, STORAGE | COPY);
  const edges = buffer('raw edges', capacity * EDGE_FLOATS * 4, STORAGE | COPY);
  const poses = buffer('raw poses', capacity * 16, STORAGE);
  const frames = buffer('raw frames', capacity * 16, STORAGE);
  const lodState = buffer('raw lod state', capacity * 8, STORAGE | COPY);
  const looks = buffer('raw looks', capacity * 8, STORAGE);
  const visible = buffer('raw visible', capacity * buckets * 4, STORAGE);
  const counters = buffer('raw counters', (buckets + 1) * 4, STORAGE);
  const statsBytes = (buckets + 1) * 4;
  const stats = buffer('raw stats', statsBytes, STORAGE | GPUBufferUsage.COPY_SRC);
  const params = buffer('raw params', PARAMS_BYTES, GPUBufferUsage.UNIFORM | COPY);

  // Indirect args, one record per draw, and the per-bucket draw table for writeArgs.
  const drawsOf: number[][] = Array.from({ length: buckets }, () => []);
  const argsList: number[] = [];
  families.forEach((family, f) => {
    family.lods.forEach((level, lod) => {
      for (const geometry of level) {
        drawsOf[f * BUCKETS_PER_FAMILY + lod]?.push(argsList.length / INDIRECT_WORDS);
        argsList.push(geometry.index?.count ?? 0, 0, 0, 0, 0);
      }
    });
    if (family.impostor !== null) {
      drawsOf[f * BUCKETS_PER_FAMILY + IMPOSTOR_BUCKET]?.push(argsList.length / INDIRECT_WORDS);
      argsList.push(6, 0, 0, 0, 0);
    }
  });
  const args = upload(
    'raw indirect args',
    Uint32Array.from(argsList),
    STORAGE | GPUBufferUsage.INDIRECT,
  );
  const starts = [0];
  for (const draws of drawsOf) starts.push((starts[starts.length - 1] ?? 0) + draws.length);
  const drawTable = upload(
    'raw draw table',
    Uint32Array.from([...starts, ...drawsOf.flat()]),
    STORAGE,
  );

  // Compute pipelines.
  const computePipeline = (label: string, code: string) =>
    device.createComputePipeline({
      label,
      layout: 'auto',
      compute: { module: device.createShaderModule({ label, code }), entryPoint: 'main' },
    });
  const integrate = computePipeline('raw integrate', integrateWgsl(familyConstants));
  const cullLod = computePipeline('raw cullLod', cullLodWgsl(familyConstants));
  const writeArgs = computePipeline('raw writeArgs', writeArgsWgsl(buckets));
  const bind = (pipeline: GPUComputePipeline, resources: GPUBuffer[]) =>
    device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: resources.map((resource, binding) => ({ binding, resource: { buffer: resource } })),
    });
  const integrateGroup = bind(integrate, [
    params,
    records,
    edges,
    familyBuffer,
    clips,
    poses,
    frames,
  ]);
  const cullGroup = bind(cullLod, [
    params,
    records,
    familyBuffer,
    poses,
    frames,
    lodState,
    looks,
    visible,
    counters,
  ]);
  const argsGroup = bind(writeArgs, [counters, args, stats, drawTable]);

  // Render: explicit layouts so group 0 is shared by every pipeline.
  const V = GPUShaderStage.VERTEX;
  const F = GPUShaderStage.FRAGMENT;
  const group0Layout = device.createBindGroupLayout({
    label: 'raw frame',
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, buffer: { type: 'uniform' } },
      ...[2, 3, 4, 5, 6].map((binding) => ({
        binding,
        visibility: V,
        buffer: { type: 'read-only-storage' as const },
      })),
    ],
  });
  const frameGroup = device.createBindGroup({
    layout: group0Layout,
    entries: [params, paletteBuffer, visible, poses, frames, looks, matrices].map(
      (resource, binding) => ({
        binding,
        resource: { buffer: resource },
      }),
    ),
  });
  const meshDrawLayout = device.createBindGroupLayout({
    label: 'raw mesh draw',
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, texture: {} },
      { binding: 2, visibility: F, sampler: {} },
    ],
  });
  const impostorDrawLayout = device.createBindGroupLayout({
    label: 'raw impostor draw',
    entries: [
      { binding: 0, visibility: V | F, buffer: { type: 'uniform' } },
      { binding: 1, visibility: F, texture: {} },
      { binding: 2, visibility: F, texture: {} },
      { binding: 3, visibility: F, texture: {} },
      { binding: 4, visibility: F, sampler: {} },
    ],
  });
  const groundDrawLayout = device.createBindGroupLayout({
    label: 'raw ground draw',
    entries: [{ binding: 0, visibility: V | F, buffer: { type: 'uniform' } }],
  });
  const sampler = device.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
    addressModeU: 'repeat',
    addressModeV: 'repeat',
  });
  const white = device.createTexture({
    size: [1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  device.queue.writeTexture({ texture: white }, new Uint8Array([255, 255, 255, 255]), {}, [1, 1]);
  owned.push(white);

  const target: GPUColorTargetState = { format: options.colourFormat };
  const depthStencil: GPUDepthStencilState = {
    format: DEPTH_FORMAT,
    depthWriteEnabled: true,
    depthCompare: 'less',
  };
  const meshModules = new Map<1 | 4, GPUShaderModule>();
  const meshPipelines = new Map<string, GPURenderPipeline>();
  const meshPipeline = (influences: 1 | 4, layouts: GPUVertexBufferLayout[]): GPURenderPipeline => {
    const key = `${influences}|${layouts.map((l) => `${l.arrayStride}:${[...l.attributes][0]?.format ?? ''}`).join(',')}`;
    let pipeline = meshPipelines.get(key);
    if (pipeline === undefined) {
      let module = meshModules.get(influences);
      if (module === undefined) {
        module = device.createShaderModule({
          label: `raw mesh ${influences}`,
          code: meshWgsl(influences, options.lights),
        });
        meshModules.set(influences, module);
      }
      pipeline = device.createRenderPipeline({
        label: `raw mesh ${key}`,
        layout: device.createPipelineLayout({ bindGroupLayouts: [group0Layout, meshDrawLayout] }),
        vertex: { module, entryPoint: 'vs', buffers: layouts },
        fragment: { module, entryPoint: 'fs', targets: [target] },
        primitive: { topology: 'triangle-list', cullMode: 'back' },
        depthStencil,
      });
      meshPipelines.set(key, pipeline);
    }
    return pipeline;
  };
  const quadLayout: GPUVertexBufferLayout = {
    arrayStride: 8,
    attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x2' }],
  };
  const quadPipeline = (label: string, code: string, drawLayout: GPUBindGroupLayout) => {
    const module = device.createShaderModule({ label, code });
    return device.createRenderPipeline({
      label,
      layout: device.createPipelineLayout({ bindGroupLayouts: [group0Layout, drawLayout] }),
      vertex: { module, entryPoint: 'vs', buffers: [quadLayout] },
      fragment: { module, entryPoint: 'fs', targets: [target] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil,
    });
  };
  const impostorPipeline = quadPipeline(
    'raw impostor',
    impostorWgsl(options.lights, {
      yaws: IMPOSTOR_YAWS,
      pitchSplitRad: ((IMPOSTOR_PITCHES[0] + IMPOSTOR_PITCHES[1]) / 2) * (Math.PI / 180),
      frames: IMPOSTOR_FRAMES,
      pitches: IMPOSTOR_PITCHES.length,
    }),
    impostorDrawLayout,
  );
  const groundPipeline = quadPipeline('raw ground', groundWgsl(options.lights), groundDrawLayout);

  const impostorQuad = upload(
    'raw impostor quad',
    new Float32Array([-0.5, 0, 0.5, 0, 0.5, 1, -0.5, 1]),
    GPUBufferUsage.VERTEX,
  );
  const groundQuad = upload(
    'raw ground quad',
    new Float32Array([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5]),
    GPUBufferUsage.VERTEX,
  );
  const quadIndex = upload(
    'raw quad index',
    new Uint32Array([0, 1, 2, 0, 2, 3]),
    GPUBufferUsage.INDEX,
  );

  const drawUniform = (label: string, fields: DrawFields): GPUBuffer => {
    const data = new ArrayBuffer(DRAW_UNIFORM_BYTES);
    const f32 = new Float32Array(data);
    const u32 = new Uint32Array(data);
    f32.set(fields.baseColour, 0);
    f32[3] = fields.referenceLuminance;
    f32.set(fields.debugColour, 4);
    u32[7] = fields.bucketOffset;
    u32[8] = fields.flags;
    f32[9] = fields.quadWidth;
    f32[10] = fields.quadHeight;
    f32[11] = fields.quadBottom;
    f32[12] = fields.characterHeight;
    f32[13] = fields.atlasColumns;
    f32[14] = fields.atlasRows;
    return upload(label, new Uint8Array(data), GPUBufferUsage.UNIFORM);
  };

  // Vertex buffers are shared across LODs: simplified LODs reuse the source attributes.
  const vertexBuffers = new Map<
    object,
    { buffer: GPUBuffer; format: GPUVertexFormat; stride: number }
  >();
  const zeroAttribute = upload('raw zero attribute', new Float32Array(4), GPUBufferUsage.VERTEX);
  const vertexBuffer = (
    attribute: BufferAttribute | InterleavedBufferAttribute | undefined,
    fallback: GPUVertexFormat,
  ) => {
    if (attribute === undefined) return { buffer: zeroAttribute, format: fallback, stride: 0 };
    let cached = vertexBuffers.get(attribute);
    if (cached === undefined) {
      const { data, format } = packAttribute(attribute);
      cached = {
        buffer: upload(`raw vertex ${format}`, data, GPUBufferUsage.VERTEX),
        format,
        stride: formatBytes(format),
      };
      vertexBuffers.set(attribute, cached);
    }
    return cached;
  };

  const groundUniform = drawUniform('raw ground draw', {
    ...emptyDraw(),
    baseColour: [options.groundColour.r, options.groundColour.g, options.groundColour.b],
    quadWidth: 100,
  });
  const recordBundle = (): GPURenderBundle => {
    const encoder = device.createRenderBundleEncoder({
      colorFormats: [options.colourFormat],
      depthStencilFormat: DEPTH_FORMAT,
    });
    encoder.setBindGroup(0, frameGroup);

    encoder.setPipeline(groundPipeline);
    encoder.setBindGroup(
      1,
      device.createBindGroup({
        layout: groundDrawLayout,
        entries: [{ binding: 0, resource: { buffer: groundUniform } }],
      }),
    );
    encoder.setVertexBuffer(0, groundQuad);
    encoder.setIndexBuffer(quadIndex, 'uint32');
    encoder.drawIndexed(6);

    families.forEach((family, f) => {
      family.lods.forEach((level, lod) => {
        const bucket = f * BUCKETS_PER_FAMILY + lod;
        level.forEach((geometry, sub) => {
          const attributes = [
            vertexBuffer(geometry.getAttribute('position'), 'float32x3'),
            vertexBuffer(geometry.getAttribute('normal'), 'float32x3'),
            vertexBuffer(
              geometry.hasAttribute('uv') ? geometry.getAttribute('uv') : undefined,
              'float32x2',
            ),
            vertexBuffer(geometry.getAttribute('skinIndex'), 'uint16x4'),
            vertexBuffer(geometry.getAttribute('skinWeight'), 'float32x4'),
            vertexBuffer(
              geometry.hasAttribute(TINT_MASK_ATTRIBUTE)
                ? geometry.getAttribute(TINT_MASK_ATTRIBUTE)
                : undefined,
              'float32x4',
            ),
          ];
          const layouts: GPUVertexBufferLayout[] = attributes.map((a, location) => ({
            arrayStride: a.stride,
            attributes: [{ shaderLocation: location, offset: 0, format: a.format }],
          }));
          encoder.setPipeline(meshPipeline(family.influences[sub] ?? 4, layouts));
          const source = firstStandard(family.materials[sub]);
          const map = family.maps[sub] ?? null;
          const colour = source?.color ?? new Color(0x8fa3bf);
          const debug = RENDER_LOD_DEBUG_COLOURS[lod] ?? [1, 1, 1];
          const tinted = geometry.hasAttribute(TINT_MASK_ATTRIBUTE);
          const uniform = drawUniform(`raw draw f${f} lod${lod} ${sub}`, {
            ...emptyDraw(),
            baseColour: [colour.r, colour.g, colour.b],
            referenceLuminance: map !== null ? 0.45 : Math.max(0.05, luminance(colour)),
            debugColour: [debug[0], debug[1], debug[2]],
            bucketOffset: bucket * capacity,
            flags: (tinted ? 1 : 0) | (map !== null ? 2 : 0),
          });
          encoder.setBindGroup(
            1,
            device.createBindGroup({
              layout: meshDrawLayout,
              entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: (map ?? white).createView() },
                { binding: 2, resource: sampler },
              ],
            }),
          );
          attributes.forEach((a, slot) => {
            encoder.setVertexBuffer(slot, a.buffer);
          });
          const index = geometry.index;
          if (index === null) return;
          const indexData =
            index.array instanceof Uint16Array ? index.array : Uint32Array.from(index.array);
          const indexBuffer =
            vertexBuffers.get(index)?.buffer ??
            upload('raw index', indexData, GPUBufferUsage.INDEX);
          vertexBuffers.set(index, { buffer: indexBuffer, format: 'uint32', stride: 0 });
          encoder.setIndexBuffer(
            indexBuffer,
            indexData instanceof Uint16Array ? 'uint16' : 'uint32',
          );
          const draw = drawsOf[bucket]?.[sub] ?? 0;
          encoder.drawIndexedIndirect(args, draw * INDIRECT_WORDS * 4);
        });
      });

      const impostor = family.impostor;
      if (impostor === null) return;
      const bucket = f * BUCKETS_PER_FAMILY + IMPOSTOR_BUCKET;
      const debug = RENDER_LOD_DEBUG_COLOURS[IMPOSTOR_BUCKET] ?? [1, 0, 1];
      const uniform = drawUniform(`raw impostor f${f}`, {
        ...emptyDraw(),
        referenceLuminance: impostor.atlas.referenceLuminance,
        debugColour: [debug[0], debug[1], debug[2]],
        bucketOffset: bucket * capacity,
        quadWidth: impostor.atlas.quad.width,
        quadHeight: impostor.atlas.quad.height,
        quadBottom: impostor.atlas.quad.bottom,
        characterHeight: family.height,
        atlasColumns: impostor.atlas.columns,
        atlasRows: impostor.atlas.rows,
      });
      encoder.setPipeline(impostorPipeline);
      encoder.setBindGroup(
        1,
        device.createBindGroup({
          layout: impostorDrawLayout,
          entries: [
            { binding: 0, resource: { buffer: uniform } },
            { binding: 1, resource: impostor.albedo.createView() },
            { binding: 2, resource: impostor.normal.createView() },
            { binding: 3, resource: impostor.mask.createView() },
            { binding: 4, resource: sampler },
          ],
        }),
      );
      encoder.setVertexBuffer(0, impostorQuad);
      encoder.setIndexBuffer(quadIndex, 'uint32');
      encoder.drawIndexedIndirect(args, (drawsOf[bucket]?.[0] ?? 0) * INDIRECT_WORDS * 4);
    });
    return encoder.finish({ label: 'raw crowd' });
  };
  const renderBundle = recordBundle();

  let active = 0;
  const paramData = new ArrayBuffer(PARAMS_BYTES);
  const f32 = new Float32Array(paramData);
  const u32 = new Uint32Array(paramData);

  return {
    capacity,
    drawCount: argsList.length / INDIRECT_WORDS + 1,
    stats,
    statsBytes,
    setActive(recordView, edgeData, count) {
      device.queue.writeBuffer(records, 0, recordView.buffer, 0, count * AGENT_RECORD_BYTES);
      device.queue.writeBuffer(
        edges,
        0,
        edgeData.buffer,
        edgeData.byteOffset,
        count * EDGE_FLOATS * 4,
      );
      // Fresh agents choose their LOD from scratch.
      device.queue.writeBuffer(lodState, 0, new Uint32Array(Math.max(1, count) * 2));
      active = count;
    },
    setGroundExtent(extent) {
      device.queue.writeBuffer(groundUniform, 36, new Float32Array([extent]));
    },
    writeParams(p) {
      f32.set(p.cameraPosition, 0);
      u32[3] = p.simTimeMs >>> 0;
      p.planes.forEach((plane, i) => {
        f32.set(plane, 4 + i * 4);
      });
      f32.set(p.lodThresholds, 28);
      f32[32] = p.pxPerRadian;
      f32[33] = p.impostorPx;
      f32[34] = p.fadeMs;
      u32[35] = p.forcedLod;
      u32[36] = p.debugColours ? 1 : 0;
      u32[37] = active;
      u32[38] = capacity;
      f32.set(p.viewProjection, 40);
      f32.set(p.sunDirection, 56);
      device.queue.writeBuffer(params, 0, paramData);
    },
    encodeCompute(pass) {
      if (active === 0) return;
      const groups = Math.ceil(active / WORKGROUP);
      pass.setPipeline(integrate);
      pass.setBindGroup(0, integrateGroup);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(cullLod);
      pass.setBindGroup(0, cullGroup);
      pass.dispatchWorkgroups(groups);
      pass.setPipeline(writeArgs);
      pass.setBindGroup(0, argsGroup);
      pass.dispatchWorkgroups(Math.ceil(buckets / WORKGROUP));
    },
    bundle: () => renderBundle,
    dispose() {
      for (const resource of owned) resource.destroy();
    },
  };
}

interface DrawFields {
  baseColour: [number, number, number];
  referenceLuminance: number;
  debugColour: [number, number, number];
  bucketOffset: number;
  flags: number;
  quadWidth: number;
  quadHeight: number;
  quadBottom: number;
  characterHeight: number;
  atlasColumns: number;
  atlasRows: number;
}

function emptyDraw(): DrawFields {
  return {
    baseColour: [1, 1, 1],
    referenceLuminance: 0.5,
    debugColour: [1, 1, 1],
    bucketOffset: 0,
    flags: 0,
    quadWidth: 1,
    quadHeight: 1,
    quadBottom: 0,
    characterHeight: 1,
    atlasColumns: 1,
    atlasRows: 1,
  };
}

/** Tightly packed copy of an attribute (interleaved ones are de-interleaved) and its format. */
function packAttribute(attribute: BufferAttribute | InterleavedBufferAttribute): {
  data: ArrayBufferView;
  format: GPUVertexFormat;
} {
  const itemSize = attribute.itemSize;
  const source = attribute.array;
  const Constructor = source.constructor as new (length: number) => typeof source;
  const packed = new Constructor(attribute.count * itemSize);
  for (let i = 0; i < attribute.count; i++) {
    for (let k = 0; k < itemSize; k++) packed[i * itemSize + k] = attribute.getComponent(i, k);
  }
  if (attribute.normalized && !(packed instanceof Float32Array)) {
    // getComponent de-normalises; write the raw integers back.
    const scale = packed instanceof Uint8Array ? 255 : packed instanceof Uint16Array ? 65535 : 1;
    for (let i = 0; i < packed.length; i++) packed[i] = Math.round((packed[i] ?? 0) * scale);
  }
  return { data: packed, format: vertexFormat(packed, itemSize, attribute.normalized) };
}

function vertexFormat(
  array: ArrayBufferView,
  itemSize: number,
  normalized: boolean,
): GPUVertexFormat {
  const n = itemSize === 1 ? '' : `x${itemSize}`;
  if (array instanceof Float32Array) return `float32${n}` as GPUVertexFormat;
  if (array instanceof Uint16Array)
    return `${normalized ? 'unorm' : 'uint'}16${n}` as GPUVertexFormat;
  if (array instanceof Uint8Array)
    return `${normalized ? 'unorm' : 'uint'}8${n}` as GPUVertexFormat;
  if (array instanceof Uint32Array) return `uint32${n}` as GPUVertexFormat;
  throw new Error(`Unsupported vertex attribute array ${array.constructor.name}`);
}

function formatBytes(format: GPUVertexFormat): number {
  const [, type, count] = /^[a-z]+(\d+)(?:x(\d))?$/.exec(format) ?? [];
  return (Number(type) / 8) * Number(count ?? 1);
}

function firstStandard(
  source: Material | Material[] | undefined,
): MeshStandardMaterial | undefined {
  const first = Array.isArray(source) ? source[0] : source;
  return first instanceof MeshStandardMaterial ? first : undefined;
}

function luminance(c: Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

function align4(n: number): number {
  return Math.ceil(n / 4) * 4;
}

function align4Down(n: number): number {
  return Math.floor(n / 4) * 4;
}
