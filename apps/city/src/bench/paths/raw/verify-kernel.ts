import { type BakedClip, ClipFlag, packClipTable } from '@city/assets-runtime';
import { AGENT_RECORD_BYTES, readAgentRecord } from '@city/core-types';
import { agentPoseAt, EDGE_FLOATS, layoutWalkers } from '../walkers.ts';
import { integrateWgsl, PARAMS_BYTES, WORKGROUP } from './wgsl.ts';

export interface KernelCheck {
  checked: number;
  /** Largest distance between GPU and CPU positions, metres. */
  maxPositionError: number;
  /** Largest heading difference, radians. */
  maxHeadingError: number;
  /** Agents whose frame pair differs, excluding those within float noise of a frame boundary. */
  frameMismatches: number;
}

const AGENTS = 4096;
const BONES = 65;
const SIM_TIME_MS = 12_345;
const CLIP: BakedClip = {
  name: 'walk',
  firstFrame: 10,
  frameCount: 30,
  fps: 30,
  strideLength: 1.6,
  duration: 1,
  flags: ClipFlag.Loop,
};

/**
 * CPU-vs-GPU equivalence test for the integrate kernel (implementation plan §1: "two
 * representations of where the agent is must use identical maths"). Runs the WGSL on a seeded
 * crowd and compares every agent with agentPoseAt().
 */
export async function verifyIntegrateKernel(device: GPUDevice): Promise<KernelCheck> {
  const layout = layoutWalkers(
    AGENTS,
    AGENTS,
    99,
    [{ robot: false, clipIndex: 0, clipSpeed: 1.5 }],
    0,
    1000,
  );
  const familyTable = new Float32Array([0, BONES, 0, 1.8, 0, 1.08, 0, 0]);

  const storage = (data: ArrayBufferView | number, extra = 0): GPUBuffer => {
    const size = typeof data === 'number' ? data : data.byteLength;
    const buffer = device.createBuffer({
      size: Math.max(16, size),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC | extra,
    });
    if (typeof data !== 'number')
      device.queue.writeBuffer(buffer, 0, data.buffer, data.byteOffset, data.byteLength);
    return buffer;
  };
  const params = device.createBuffer({
    size: PARAMS_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  const paramData = new ArrayBuffer(PARAMS_BYTES);
  new Uint32Array(paramData)[3] = SIM_TIME_MS;
  new Uint32Array(paramData)[37] = AGENTS;
  new Uint32Array(paramData)[38] = AGENTS;
  device.queue.writeBuffer(params, 0, paramData);

  const records = storage(new Uint8Array(layout.records.buffer, 0, AGENTS * AGENT_RECORD_BYTES));
  const edges = storage(layout.edges.subarray(0, AGENTS * EDGE_FLOATS));
  const families = storage(familyTable);
  const clips = storage(new Uint32Array(packClipTable([CLIP])));
  const poses = storage(AGENTS * 16);
  const frames = storage(AGENTS * 16);

  const module = device.createShaderModule({
    label: 'integrate self-test',
    code: integrateWgsl({ humanCount: 1, robotIndex: -1, familyCount: 1 }),
  });
  const pipeline = device.createComputePipeline({
    layout: 'auto',
    compute: { module, entryPoint: 'main' },
  });
  const group = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [params, records, edges, families, clips, poses, frames].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  });

  const readPoses = device.createBuffer({
    size: AGENTS * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const readFrames = device.createBuffer({
    size: AGENTS * 16,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, group);
  pass.dispatchWorkgroups(Math.ceil(AGENTS / WORKGROUP));
  pass.end();
  encoder.copyBufferToBuffer(poses, 0, readPoses, 0, AGENTS * 16);
  encoder.copyBufferToBuffer(frames, 0, readFrames, 0, AGENTS * 16);
  device.queue.submit([encoder.finish()]);
  await Promise.all([readPoses.mapAsync(GPUMapMode.READ), readFrames.mapAsync(GPUMapMode.READ)]);
  const gpuPoses = new Float32Array(readPoses.getMappedRange().slice(0));
  const gpuFrames = new Float32Array(readFrames.getMappedRange().slice(0));

  let maxPositionError = 0;
  let maxHeadingError = 0;
  let frameMismatches = 0;
  for (let i = 0; i < AGENTS; i++) {
    const expected = agentPoseAt(
      readAgentRecord(layout.records, i),
      layout.edges,
      CLIP,
      BONES,
      SIM_TIME_MS,
    );
    const x = gpuPoses[i * 4] ?? 0;
    const z = gpuPoses[i * 4 + 2] ?? 0;
    const heading = gpuPoses[i * 4 + 3] ?? 0;
    maxPositionError = Math.max(maxPositionError, Math.hypot(x - expected.x, z - expected.z));
    const dh = Math.atan2(
      Math.sin(heading - expected.heading),
      Math.cos(heading - expected.heading),
    );
    maxHeadingError = Math.max(maxHeadingError, Math.abs(dh));
    const nearBoundary = expected.alpha < 1e-3 || expected.alpha > 1 - 1e-3;
    const sameFrames =
      gpuFrames[i * 4] === expected.base0 && gpuFrames[i * 4 + 1] === expected.base1;
    if (!sameFrames && !nearBoundary) frameMismatches++;
  }

  for (const buffer of [
    params,
    records,
    edges,
    families,
    clips,
    poses,
    frames,
    readPoses,
    readFrames,
  ]) {
    buffer.destroy();
  }
  return { checked: AGENTS, maxPositionError, maxHeadingError, frameMismatches };
}
