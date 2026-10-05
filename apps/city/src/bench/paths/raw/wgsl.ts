/**
 * Hand-written WGSL for Path C (implementation plan §I.3, §30). Every kernel mirrors a CPU
 * reference: integrate → agentPoseAt() (walkers.ts), cullLod → stepLod() (lod-policy.ts),
 * appearance → appearanceFromSeed() (appearance.ts). Path B's TSL implements the same rules.
 */

export interface FamilyConstants {
  /** Human base meshes selected by the kind byte's variant bits. */
  humanCount: number;
  /** Family index of the robot family, or −1. */
  robotIndex: number;
  familyCount: number;
}

/** Bytes of the per-frame Params uniform (see PARAMS below). */
export const PARAMS_BYTES = 256;
export const PALETTE_ENTRIES = 36;
export const PALETTE_OFFSETS = { top: 0, bottoms: 12, skin: 20, hair: 28 } as const;
export const BUCKETS_PER_FAMILY = 6;
export const IMPOSTOR_BUCKET = 5;
export const WORKGROUP = 64;

const PARAMS = /* wgsl */ `
struct Params {
  cameraPosition: vec3f,
  simTimeMs: u32,
  planes: array<vec4f, 6>,
  lodThresholds: vec4f,
  pxPerRadian: f32,
  impostorPx: f32,
  fadeMs: f32,
  forcedLod: u32,
  debugColours: u32,
  agentCount: u32,
  capacity: u32,
  _pad0: u32,
  viewProjection: mat4x4f,
  sunDirection: vec3f,
  _pad1: f32,
}
`;

const COMMON = (f: FamilyConstants) => /* wgsl */ `
const RECORD_WORDS = 6u;
const CLIP_WORDS = 6u;
const HUMAN_COUNT = ${f.humanCount}u;
const ROBOT_INDEX = ${f.robotIndex}i;
const BUCKETS_PER_FAMILY = ${BUCKETS_PER_FAMILY}u;
const IMPOSTOR_BUCKET = ${IMPOSTOR_BUCKET}u;
const OUTGOING_BIT = 0x80000000u;
const LOD_AUTO = 0xffu;
const HYSTERESIS = 1.1;
const PI = 3.14159265358979;

// Family index from record word 4's kind byte: bit 7 = robot, bits 0–6 = human base.
fn familyOf(word4: u32) -> u32 {
  if (HUMAN_COUNT == 0u) { return u32(ROBOT_INDEX); }
  let base = min(word4 & 0x7fu, HUMAN_COUNT - 1u);
  if (ROBOT_INDEX >= 0i && ((word4 >> 7u) & 1u) == 1u) { return u32(ROBOT_INDEX); }
  return base;
}

// lowbias32; mirrors hash32() in appearance.ts.
fn lowbias32(v: u32) -> u32 {
  var x = v;
  x ^= x >> 16u;
  x *= 0x7feb352du;
  x ^= x >> 15u;
  x *= 0x846ca68bu;
  x ^= x >> 16u;
  return x;
}

struct Look { palette: u32, scale: f32 }

// Mirrors appearanceFromSeed(): palette indices packed top | bottoms << 8 | skin << 16 | hair << 24.
fn lookOf(seed: u32, heightVariation: f32) -> Look {
  let h0 = lowbias32(seed);
  let h1 = lowbias32(h0);
  let h2 = lowbias32(h1);
  let h3 = lowbias32(h2);
  let h4 = lowbias32(h3);
  let palette = (h0 % 12u) | ((h1 % 8u) << 8u) | ((h2 % 8u) << 16u) | ((h3 % 8u) << 24u);
  let scale = 1.0 + heightVariation * (2.0 * (f32(h4) / 4294967296.0) - 1.0);
  return Look(palette, scale);
}
`;

/** integrate: one record → pose (x, phase, z, yaw) and bone-matrix frame pair. */
export const integrateWgsl = (f: FamilyConstants) => /* wgsl */ `
${PARAMS}
${COMMON(f)}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> records: array<u32>;
@group(0) @binding(2) var<storage, read> edges: array<vec4f>;
@group(0) @binding(3) var<storage, read> families: array<vec4f>;
@group(0) @binding(4) var<storage, read> clips: array<u32>;
@group(0) @binding(5) var<storage, read_write> poses: array<vec4f>;
@group(0) @binding(6) var<storage, read_write> frames: array<vec4f>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.agentCount) { return; }
  let base = i * RECORD_WORDS;
  let halfEdge = records[base];
  let s0 = bitcast<f32>(records[base + 1u]);
  let t0 = records[base + 2u];
  let word3 = records[base + 3u];
  let word4 = records[base + 4u];
  let family = familyOf(word4);
  let family0 = families[family * 2u];
  let family1 = families[family * 2u + 1u];
  let scale = lookOf(records[base + 5u], family1.z).scale;

  let speed = f32(word3 & 0xffffu) * 0.001;
  let clipIndex = u32(family0.z) + (word3 >> 24u);
  let phase0 = f32(word4 >> 16u) / 65536.0;

  let edge = edges[halfEdge >> 1u];
  let reverse = (halfEdge & 1u) == 1u;
  let elapsed = f32(params.simTimeMs - t0) * 0.001;
  let distance = speed * elapsed;
  let s = (s0 + distance) % edge.w;
  let along = select(s, edge.w - s, reverse);
  let x = edge.x + sin(edge.z) * along;
  let z = edge.y + cos(edge.z) * along;
  let heading = edge.z + select(0.0, PI, reverse);

  let clipBase = clipIndex * CLIP_WORDS;
  let firstFrame = clips[clipBase];
  let frameCount = clips[clipBase + 1u];
  let fps = bitcast<f32>(clips[clipBase + 2u]);
  let stride = bitcast<f32>(clips[clipBase + 3u]);
  let duration = bitcast<f32>(clips[clipBase + 4u]);
  let looping = (clips[clipBase + 5u] & 1u) == 1u;

  // Taller agents take proportionally longer strides, so feet stay planted at any scale.
  var phase = phase0;
  if (stride > 0.0) { phase += distance / (stride * scale); } else { phase += elapsed / max(duration, 0.001); }
  let lastFrame = f32(frameCount - 1u);
  let u = select(min(elapsed * fps, lastFrame), fract(phase) * f32(frameCount), looping);
  let f0 = u32(min(floor(u), lastFrame));
  let next = f0 + 1u;
  let f1 = select(select(f0, 0u, looping), next, next < frameCount);
  let matrixBase = u32(family0.x);
  let boneCount = u32(family0.y);

  poses[i] = vec4f(x, fract(phase), z, heading - family1.x);
  frames[i] = vec4f(
    f32(matrixBase + (firstFrame + f0) * boneCount),
    f32(matrixBase + (firstFrame + f1) * boneCount),
    u - floor(u),
    1.0,
  );
}
`;

/** cullLod: frustum test, LOD with hysteresis and crossfade, appearance, scatter into buckets. */
export const cullLodWgsl = (f: FamilyConstants) => /* wgsl */ `
${PARAMS}
${COMMON(f)}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> records: array<u32>;
@group(0) @binding(2) var<storage, read> families: array<vec4f>;
@group(0) @binding(3) var<storage, read> poses: array<vec4f>;
@group(0) @binding(4) var<storage, read_write> frames: array<vec4f>;
@group(0) @binding(5) var<storage, read_write> lodState: array<u32>;
@group(0) @binding(6) var<storage, read_write> looks: array<u32>;
@group(0) @binding(7) var<storage, read_write> visible: array<u32>;
@group(0) @binding(8) var<storage, read_write> counters: array<atomic<u32>>;

fn bandOf(h: f32) -> u32 {
  if (h < params.impostorPx) { return IMPOSTOR_BUCKET; }
  let t = params.lodThresholds;
  return select(0u, 1u, h < t.x) + select(0u, 1u, h < t.y) + select(0u, 1u, h < t.z) + select(0u, 1u, h < t.w);
}

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= params.agentCount) { return; }
  let word4 = records[i * RECORD_WORDS + 4u];
  let family = familyOf(word4);
  let family0 = families[family * 2u];
  let family1 = families[family * 2u + 1u];
  let look = lookOf(records[i * RECORD_WORDS + 5u], family1.z);
  let height = family0.w * look.scale;
  let radius = family1.y * look.scale;
  let pose = poses[i];
  let centre = vec3f(pose.x, height * 0.5, pose.z);

  var inside = true;
  for (var p = 0u; p < 6u; p++) {
    let plane = params.planes[p];
    if (dot(plane.xyz, centre) + plane.w < -radius) { inside = false; }
  }

  let distance = max(length(params.cameraPosition - centre), 0.1);
  let heightPx = height * params.pxPerRadian / distance;

  let word0 = lodState[i * 2u];
  var fadeStart = lodState[i * 2u + 1u];
  let stored = word0 & 0xffu;
  var current = stored - 1u;
  var previous = ((word0 >> 8u) & 0xffu) - 1u;

  var wanted = bandOf(heightPx);
  if (stored != 0u) {
    let finer = bandOf(heightPx / HYSTERESIS);
    let coarser = bandOf(heightPx * HYSTERESIS);
    wanted = select(select(current, coarser, coarser > current), finer, finer < current);
  }
  if (params.forcedLod != LOD_AUTO) { wanted = min(params.forcedLod, BUCKETS_PER_FAMILY - 1u); }

  if (stored == 0u) {
    current = wanted;
    previous = wanted;
  } else if (wanted != current) {
    previous = current;
    current = wanted;
    fadeStart = params.simTimeMs;
  }
  let elapsed = f32(params.simTimeMs - fadeStart);
  let fading = params.fadeMs > 0.0 && previous != current && elapsed < params.fadeMs;
  if (!fading) { previous = current; }

  lodState[i * 2u] = (current + 1u) | ((previous + 1u) << 8u);
  lodState[i * 2u + 1u] = fadeStart;
  let frame = frames[i];
  frames[i] = vec4f(frame.xyz, select(1.0, elapsed / params.fadeMs, fading));

  if (inside) {
    looks[i * 2u] = look.palette;
    looks[i * 2u + 1u] = bitcast<u32>(look.scale);
    let firstBucket = family * BUCKETS_PER_FAMILY;
    atomicAdd(&counters[${f.familyCount * BUCKETS_PER_FAMILY}u], 1u);
    let bucket = firstBucket + current;
    let slot = atomicAdd(&counters[bucket], 1u);
    visible[bucket * params.capacity + slot] = i;
    if (fading) {
      let outBucket = firstBucket + previous;
      let outSlot = atomicAdd(&counters[outBucket], 1u);
      visible[outBucket * params.capacity + outSlot] = i | OUTGOING_BIT;
    }
  }
}
`;

/**
 * writeArgs: one invocation per bucket copies its count into the drawIndexedIndirect records of
 * that bucket's draws, publishes stats and resets the counters. drawTable = per-bucket start
 * offsets (buckets + 1 entries) followed by the args indices.
 */
export const writeArgsWgsl = (buckets: number) => /* wgsl */ `
@group(0) @binding(0) var<storage, read_write> counters: array<atomic<u32>>;
@group(0) @binding(1) var<storage, read_write> args: array<u32>;
@group(0) @binding(2) var<storage, read_write> stats: array<u32>;
@group(0) @binding(3) var<storage, read> drawTable: array<u32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  let bucket = id.x;
  if (bucket >= ${buckets}u) { return; }
  let count = atomicLoad(&counters[bucket]);
  for (var d = drawTable[bucket]; d < drawTable[bucket + 1u]; d++) {
    args[drawTable[${buckets + 1}u + d] * 5u + 1u] = count;
  }
  stats[bucket] = count;
  atomicStore(&counters[bucket], 0u);
  if (bucket == 0u) {
    stats[${buckets}u] = atomicLoad(&counters[${buckets}u]);
    atomicStore(&counters[${buckets}u], 0u);
  }
}
`;

/** Shared by the mesh, impostor and ground render pipelines (bind group 0). */
const RENDER_GROUP0 = /* wgsl */ `
${PARAMS}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<uniform> palettes: array<vec4f, ${PALETTE_ENTRIES}>;
@group(0) @binding(2) var<storage, read> visible: array<u32>;
@group(0) @binding(3) var<storage, read> poses: array<vec4f>;
@group(0) @binding(4) var<storage, read> frames: array<vec4f>;
@group(0) @binding(5) var<storage, read> looks: array<u32>;
@group(0) @binding(6) var<storage, read> matrices: array<vec4f>;

struct Draw {
  baseColour: vec3f,
  referenceLuminance: f32,
  debugColour: vec3f,
  bucketOffset: u32,
  flags: u32,
  quadWidth: f32,
  quadHeight: f32,
  quadBottom: f32,
  characterHeight: f32,
  atlasColumns: f32,
  atlasRows: f32,
  _pad: f32,
}
const FLAG_TINT = 1u;
const FLAG_MAP = 2u;

const SKY = vec3f(__SKY__);
const GROUND = vec3f(__GROUND__);
const HEMISPHERE = __HEMISPHERE__;
const SUN = __SUN__;
const PI = 3.14159265358979;

// Lambert with a hemisphere and one directional light, as Three's lights would give a
// non-metallic diffuse surface (specular omitted).
fn lit(albedo: vec3f, normal: vec3f) -> vec3f {
  let n = normalize(normal);
  let hemi = mix(GROUND, SKY, n.y * 0.5 + 0.5) * HEMISPHERE;
  let sun = max(dot(n, params.sunDirection), 0.0) * SUN;
  return albedo / PI * (hemi + vec3f(sun));
}

fn srgb(c: vec3f) -> vec3f {
  let cutoff = c < vec3f(0.0031308);
  return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, cutoff);
}

fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

// Mirrors the TSL tintColour(): palette colours weighted by the region mask, keeping the albedo's
// shading detail through its relative luminance.
fn tinted(albedo: vec3f, mask: vec4f, palette: u32, reference: f32) -> vec3f {
  let tint = palettes[${PALETTE_OFFSETS.top}u + (palette & 0xffu)].xyz * mask.x
    + palettes[${PALETTE_OFFSETS.bottoms}u + ((palette >> 8u) & 0xffu)].xyz * mask.y
    + palettes[${PALETTE_OFFSETS.skin}u + ((palette >> 16u) & 0xffu)].xyz * mask.z
    + palettes[${PALETTE_OFFSETS.hair}u + (palette >> 24u)].xyz * mask.w;
  let strength = mask.x + mask.y + mask.z + mask.w;
  let shaded = tint / max(strength, 0.0001) * (luminance(albedo) / reference);
  return mix(albedo, shaded, min(strength, 1.0));
}

// Screen-door crossfade; mirrors keepsPixel(): interleaved gradient noise per pixel.
fn keeps(pixel: vec2f, fade: f32, outgoing: f32) -> bool {
  let noise = fract(52.9829189 * fract(pixel.x * 0.06711056 + pixel.y * 0.00583715));
  // Parenthesised: a bare 'a < b, c >= d' would parse as a template list.
  return select((noise < fade), (noise >= fade), (outgoing > 0.5));
}
`;

export interface SceneLights {
  sky: [number, number, number];
  ground: [number, number, number];
  hemisphere: number;
  sun: number;
}

function withLights(code: string, lights: SceneLights): string {
  const v = (c: [number, number, number]) => c.map((x) => x.toFixed(6)).join(', ');
  return code
    .replace('__SKY__', v(lights.sky))
    .replace('__GROUND__', v(lights.ground))
    .replace('__HEMISPHERE__', lights.hemisphere.toFixed(4))
    .replace('__SUN__', lights.sun.toFixed(4));
}

/**
 * Skinned crowd mesh: one pipeline per influence count (1 or 4); everything else about a draw is
 * in its Draw uniform.
 */
export const meshWgsl = (influences: 1 | 4, lights: SceneLights) =>
  withLights(
    /* wgsl */ `
${RENDER_GROUP0}
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var albedoMap: texture_2d<f32>;
@group(1) @binding(2) var linearSampler: sampler;

struct VertexIn {
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) joints: vec4u,
  @location(4) weights: vec4f,
  @location(5) mask: vec4f,
}

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) mask: vec4f,
  @location(3) @interpolate(flat) palette: u32,
  @location(4) @interpolate(flat) fade: vec2f,
}

@vertex
fn vs(v: VertexIn, @builtin(instance_index) instance: u32) -> VertexOut {
  let entry = visible[draw.bucketOffset + instance];
  let agent = entry & 0x7fffffffu;
  let pose = poses[agent];
  let frame = frames[agent];
  let scale = bitcast<f32>(looks[agent * 2u + 1u]);
  let base0 = u32(frame.x);
  let base1 = u32(frame.y);
  var r0 = vec4f(0.0);
  var r1 = vec4f(0.0);
  var r2 = vec4f(0.0);
  for (var k = 0u; k < ${influences}u; k++) {
    let w = v.weights[k];
    let m0 = (base0 + v.joints[k]) * 3u;
    let m1 = (base1 + v.joints[k]) * 3u;
    r0 += mix(matrices[m0], matrices[m1], frame.z) * w;
    r1 += mix(matrices[m0 + 1u], matrices[m1 + 1u], frame.z) * w;
    r2 += mix(matrices[m0 + 2u], matrices[m1 + 2u], frame.z) * w;
  }
  let p = vec4f(v.position, 1.0);
  let local = vec3f(dot(r0, p), dot(r1, p), dot(r2, p)) * scale;
  let n = vec3f(dot(r0.xyz, v.normal), dot(r1.xyz, v.normal), dot(r2.xyz, v.normal));
  let c = cos(pose.w);
  let s = sin(pose.w);
  let world = vec3f(c * local.x + s * local.z, local.y, -s * local.x + c * local.z) + vec3f(pose.x, 0.0, pose.z);

  var out: VertexOut;
  out.clip = params.viewProjection * vec4f(world, 1.0);
  out.normal = vec3f(c * n.x + s * n.z, n.y, -s * n.x + c * n.z);
  out.uv = v.uv;
  out.mask = v.mask;
  out.palette = looks[agent * 2u];
  out.fade = vec2f(frame.w, f32(entry >> 31u));
  return out;
}

@fragment
fn fs(f: VertexOut) -> @location(0) vec4f {
  if (!keeps(f.clip.xy, f.fade.x, f.fade.y)) { discard; }
  var albedo = draw.baseColour;
  if ((draw.flags & FLAG_MAP) != 0u) { albedo *= textureSample(albedoMap, linearSampler, f.uv).rgb; }
  if ((draw.flags & FLAG_TINT) != 0u) { albedo = tinted(albedo, f.mask, f.palette, draw.referenceLuminance); }
  if (params.debugColours == 1u) { albedo = draw.debugColour; }
  return vec4f(srgb(lit(albedo, f.normal)), 1.0);
}
`,
    lights,
  );

/** Camera-facing impostor quads sampling the baked atlases (§9 step 6). */
export const impostorWgsl = (
  lights: SceneLights,
  layout: { yaws: number; pitchSplitRad: number; frames: number; pitches: number },
) =>
  withLights(
    /* wgsl */ `
${RENDER_GROUP0}
@group(1) @binding(0) var<uniform> draw: Draw;
@group(1) @binding(1) var albedoAtlas: texture_2d<f32>;
@group(1) @binding(2) var normalAtlas: texture_2d<f32>;
@group(1) @binding(3) var maskAtlas: texture_2d<f32>;
@group(1) @binding(4) var linearSampler: sampler;

struct VertexOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) yaw: f32,
  @location(2) @interpolate(flat) palette: u32,
  @location(3) @interpolate(flat) fade: vec2f,
}

@vertex
fn vs(@location(0) corner: vec2f, @builtin(instance_index) instance: u32) -> VertexOut {
  let entry = visible[draw.bucketOffset + instance];
  let agent = entry & 0x7fffffffu;
  let pose = poses[agent];
  let frame = frames[agent];
  let scale = bitcast<f32>(looks[agent * 2u + 1u]);
  let foot = vec3f(pose.x, 0.0, pose.z);
  let toCamera = params.cameraPosition - (foot + vec3f(0.0, draw.characterHeight * 0.5, 0.0));
  let facing = normalize(toCamera.xz);
  let right = vec3f(facing.y, 0.0, -facing.x);
  let world = foot + right * (corner.x * draw.quadWidth * scale)
    + vec3f(0.0, (draw.quadBottom + corner.y * draw.quadHeight) * scale, 0.0);

  // Tile: camera azimuth in the character's own frame, elevation and walk phase.
  let azimuth = atan2(toCamera.x, toCamera.z) - pose.w;
  let yaw = min(u32(floor(fract(azimuth / (2.0 * PI) + 0.5 / ${layout.yaws}.0) * ${layout.yaws}.0)), ${layout.yaws - 1}u);
  let pitch = select(0u, 1u, atan2(toCamera.y, length(toCamera.xz)) > ${layout.pitchSplitRad.toFixed(6)});
  let phaseFrame = min(u32(floor(fract(pose.y) * ${layout.frames}.0)), ${layout.frames - 1}u);
  let tile = (phaseFrame * ${layout.pitches}u + pitch) * ${layout.yaws}u + yaw;
  let columns = u32(draw.atlasColumns);
  let column = f32(tile % columns);
  let row = f32(tile / columns);

  var out: VertexOut;
  out.clip = params.viewProjection * vec4f(world, 1.0);
  out.uv = vec2f((column + corner.x + 0.5) / draw.atlasColumns, (row + 1.0 - corner.y) / draw.atlasRows);
  out.yaw = pose.w;
  out.palette = looks[agent * 2u];
  out.fade = vec2f(frame.w, f32(entry >> 31u));
  return out;
}

@fragment
fn fs(f: VertexOut) -> @location(0) vec4f {
  let albedo = textureSample(albedoAtlas, linearSampler, f.uv);
  let mask = textureSample(maskAtlas, linearSampler, f.uv);
  let raw = textureSample(normalAtlas, linearSampler, f.uv).xyz * 2.0 - 1.0;
  if (albedo.a < 0.5 || !keeps(f.clip.xy, f.fade.x, f.fade.y)) { discard; }
  let c = cos(f.yaw);
  let s = sin(f.yaw);
  let normal = vec3f(c * raw.x + s * raw.z, raw.y, -s * raw.x + c * raw.z);
  var colour = tinted(albedo.rgb, mask, f.palette, draw.referenceLuminance);
  if (params.debugColours == 1u) { colour = draw.debugColour; }
  return vec4f(srgb(lit(colour, normal)), 1.0);
}
`,
    lights,
  );

/** Ground quad of `extent` metres, lit like everything else. */
export const groundWgsl = (lights: SceneLights) =>
  withLights(
    /* wgsl */ `
${RENDER_GROUP0}
@group(1) @binding(0) var<uniform> draw: Draw;

struct VertexOut { @builtin(position) clip: vec4f }

@vertex
fn vs(@location(0) corner: vec2f) -> VertexOut {
  var out: VertexOut;
  let world = vec3f(corner.x * draw.quadWidth, 0.0, -corner.y * draw.quadWidth);
  out.clip = params.viewProjection * vec4f(world, 1.0);
  return out;
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(srgb(lit(draw.baseColour, vec3f(0.0, 1.0, 0.0))), 1.0);
}
`,
    lights,
  );
