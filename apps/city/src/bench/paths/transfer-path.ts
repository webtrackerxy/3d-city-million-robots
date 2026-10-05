import { type BakedClip, ClipFlag, packClipTable } from '@city/assets-runtime';
import { AGENT_RECORD_BYTES } from '@city/core-types';
import { GpuPassTimer, type MetricsBus } from '@city/metrics';
import { createGridGraph, gridForAgents, packGpuEdges } from '@city/nav';
import { AgentStore, allocateAgentBuffer, Simulation } from '@city/sim';
import { RenderPathKind, type TransferStrategy } from '../harness/scenario.ts';
import { integrateWgsl, PARAMS_BYTES, WORKGROUP } from './raw/wgsl.ts';
import type { GpuTimeSink, RenderPath } from './render-path.ts';

/**
 * Step 0.10, plan question Q10: how should simulation changes reach the GPU? The real simulation
 * (packages/sim) runs on the main thread; each frame its output is transferred with one strategy:
 *
 * - `full`:   the CPU dead-reckons every agent and uploads all positions (16 B each), the
 *             all-CPU alternative (a) of plan §1;
 * - `ranges`: dirty agents' 24 B records go into a CPU mirror, uploaded as coalesced ranges;
 *             the GPU dead-reckons (integrate);
 * - `events`: dirty records are packed with their ids into one upload and scattered into the
 *             record buffer by a compute pass; the GPU dead-reckons (plan §1's chosen design).
 *
 * Nothing is drawn: the frame is the transfer and the GPU work it implies.
 */

const AGENTS_PER_EDGE = 4.5;
const BLOCK_M = 30;
const EVENT_WORDS = 1 + AGENT_RECORD_BYTES / 4; // id + record
/** Ranges closer than this many records are merged into one write. */
const RANGE_MERGE_GAP = 8;
const VERIFY_AFTER_MS = 3000;
const WALK: BakedClip = {
  name: 'walk',
  firstFrame: 0,
  frameCount: 30,
  fps: 30,
  strideLength: 1.6,
  duration: 1,
  flags: ClipFlag.Loop,
};

const SCATTER_WGSL = /* wgsl */ `
@group(0) @binding(0) var<uniform> count: vec4u;
@group(0) @binding(1) var<storage, read> events: array<u32>;
@group(0) @binding(2) var<storage, read_write> records: array<u32>;

@compute @workgroup_size(${WORKGROUP})
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= count.x) { return; }
  let base = id.x * ${EVENT_WORDS}u;
  let agent = events[base];
  for (var k = 0u; k < ${AGENT_RECORD_BYTES / 4}u; k++) {
    records[agent * ${AGENT_RECORD_BYTES / 4}u + k] = events[base + 1u + k];
  }
}
`;

export function createTransferPath(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  strategy: TransferStrategy,
  seed: number,
  bus: MetricsBus,
  onGpuMs: GpuTimeSink,
): RenderPath {
  const context = canvas.getContext('webgpu');
  if (context === null) throw new Error('Canvas does not support a WebGPU context');
  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: 'opaque',
  });
  const timer = GpuPassTimer.isSupported(device) ? new GpuPassTimer(device, 'transfer') : null;

  let world: TransferWorld | null = null;
  let count = 0;

  return {
    kind: RenderPathKind.Transfer,
    setAgentCount(next) {
      world?.dispose();
      count = next;
      world = next > 0 ? createWorld(device, next, strategy, seed, bus) : null;
    },
    agentCount: () => count,
    resize(cssWidth, cssHeight, pixelRatio) {
      canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
    },
    frame() {
      const encoder = device.createCommandEncoder({ label: 'transfer frame' });
      const extras = world?.frame(encoder, timer) ?? {};
      const pass = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: { r: 0.04, g: 0.05, b: 0.08, a: 1 },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
      });
      pass.end();
      if (world?.usesGpu === true) timer?.resolve(encoder);
      device.queue.submit([encoder.finish()]);
      if (world?.usesGpu === true) timer?.readback(onGpuMs);
      world?.afterSubmit();
      return { animMs: extras.uploadCpuMs ?? 0, drawCalls: 0, triangles: 0, extras };
    },
    dispose() {
      world?.dispose();
      timer?.destroy();
      context.unconfigure();
    },
  };
}

interface TransferWorld {
  readonly usesGpu: boolean;
  frame(encoder: GPUCommandEncoder, timer: GpuPassTimer | null): Record<string, number>;
  afterSubmit(): void;
  dispose(): void;
}

function createWorld(
  device: GPUDevice,
  agents: number,
  strategy: TransferStrategy,
  seed: number,
  bus: MetricsBus,
): TransferWorld {
  const { columns, rows } = gridForAgents(agents, AGENTS_PER_EDGE);
  const graph = createGridGraph(columns, rows, BLOCK_M);
  const store = new AgentStore(allocateAgentBuffer(agents, false), agents);
  const startMs = performance.now();
  const simTime = (): number => Math.floor(performance.now() - startMs) >>> 0;
  const sim = new Simulation({ graph, store, start: 0, end: agents, seed, startMs: 0 });
  const owned: GPUBuffer[] = [];
  const create = (label: string, size: number, usage: GPUBufferUsageFlags): GPUBuffer => {
    const buffer = device.createBuffer({
      label,
      size: Math.max(16, Math.ceil(size / 4) * 4),
      usage,
    });
    owned.push(buffer);
    return buffer;
  };
  const STORAGE = GPUBufferUsage.STORAGE;
  const COPY_DST = GPUBufferUsage.COPY_DST;

  if (strategy === 'full') {
    // CPU dead reckoning of every agent, uploaded as (x, z, heading, 0).
    const poses = new Float32Array(agents * 4);
    const poseBuffer = create('transfer poses', poses.byteLength, STORAGE | COPY_DST);
    const point: [number, number] = [0, 0];
    return {
      usesGpu: false,
      frame() {
        const now = simTime();
        const simStart = performance.now();
        const stats = sim.step(now);
        sim.drainDirty(() => undefined);
        const uploadStart = performance.now();
        for (let i = 0; i < agents; i++) {
          sim.positionAt(i, now, point);
          const halfEdge = store.halfEdge[i] ?? 0;
          poses[i * 4] = point[0];
          poses[i * 4 + 1] = point[1];
          poses[i * 4 + 2] =
            (graph.edgeHeading[halfEdge >>> 1] ?? 0) + ((halfEdge & 1) === 1 ? Math.PI : 0);
        }
        device.queue.writeBuffer(poseBuffer, 0, poses);
        const uploadCpuMs = performance.now() - uploadStart;
        return {
          simMs: uploadStart - simStart,
          uploadCpuMs,
          uploadBytes: poses.byteLength,
          writeCalls: 1,
          events: stats.events,
          dirty: stats.events,
        };
      },
      afterSubmit: () => undefined,
      dispose: () => {
        for (const buffer of owned) buffer.destroy();
      },
    };
  }

  // GPU dead reckoning: records + edges + integrate, shared by `ranges` and `events`.
  const records = create(
    'transfer records',
    agents * AGENT_RECORD_BYTES,
    STORAGE | COPY_DST | GPUBufferUsage.COPY_SRC,
  );
  const edges = packGpuEdges(graph);
  const edgeBuffer = create('transfer edges', edges.byteLength, STORAGE | COPY_DST);
  device.queue.writeBuffer(edgeBuffer, 0, edges);
  const families = create('transfer families', 32, STORAGE | COPY_DST);
  device.queue.writeBuffer(families, 0, new Float32Array([0, 1, 0, 1.8, 0, 1.08, 0, 0]));
  const clipWords = new Uint32Array(packClipTable([WALK]));
  const clips = create('transfer clips', clipWords.byteLength, STORAGE | COPY_DST);
  device.queue.writeBuffer(clips, 0, clipWords);
  const params = create('transfer params', PARAMS_BYTES, GPUBufferUsage.UNIFORM | COPY_DST);
  const paramWords = new Uint32Array(PARAMS_BYTES / 4);
  paramWords[37] = agents;
  paramWords[38] = agents;
  const poses = create('transfer poses', agents * 16, STORAGE);
  const frames = create('transfer frames', agents * 16, STORAGE);
  const integrate = device.createComputePipeline({
    label: 'transfer integrate',
    layout: 'auto',
    compute: {
      module: device.createShaderModule({
        code: integrateWgsl({ humanCount: 1, robotIndex: -1, familyCount: 1 }),
      }),
      entryPoint: 'main',
    },
  });
  const integrateGroup = device.createBindGroup({
    layout: integrate.getBindGroupLayout(0),
    entries: [params, records, edgeBuffer, families, clips, poses, frames].map(
      (buffer, binding) => ({
        binding,
        resource: { buffer },
      }),
    ),
  });

  // Correctness: once, read the GPU records back and compare with the simulation's.
  const readback = create(
    'transfer verify',
    agents * AGENT_RECORD_BYTES,
    GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  );
  let verifyState: 'waiting' | 'copied' | 'done' = 'waiting';
  /** CPU records snapshotted in the frame whose GPU copy is being read back. */
  let expected: Uint8Array | null = null;
  /** Record mismatches found by the one-time readback; reported in every later frame's extras. */
  let verifiedMismatches: number | null = null;
  const verification = (): Record<string, number> =>
    verifiedMismatches === null ? {} : { mismatches: verifiedMismatches };
  const verify = (): void => {
    void readback.mapAsync(GPUMapMode.READ).then(() => {
      const gpu = new Uint8Array(readback.getMappedRange().slice(0));
      readback.unmap();
      let mismatches = 0;
      for (let i = 0; i < agents; i++) {
        for (let b = 0; b < AGENT_RECORD_BYTES; b++) {
          if (gpu[i * AGENT_RECORD_BYTES + b] !== expected?.[i * AGENT_RECORD_BYTES + b]) {
            mismatches++;
            break;
          }
        }
      }
      bus.setGauge('transfer.verifiedAgents', agents);
      bus.setGauge('transfer.mismatches', mismatches);
      verifiedMismatches = mismatches;
    });
  };

  const encodeIntegrate = (
    encoder: GPUCommandEncoder,
    timer: GpuPassTimer | null,
    before?: (pass: GPUComputePassEncoder) => void,
  ): void => {
    paramWords[3] = simTime();
    device.queue.writeBuffer(params, 0, paramWords);
    const pass = encoder.beginComputePass({
      label: 'transfer compute',
      ...(timer === null ? {} : { timestampWrites: timer.timestampWrites }),
    });
    before?.(pass);
    pass.setPipeline(integrate);
    pass.setBindGroup(0, integrateGroup);
    pass.dispatchWorkgroups(Math.ceil(agents / WORKGROUP));
    pass.end();
  };

  const maybeVerify = (encoder: GPUCommandEncoder): void => {
    if (verifyState === 'waiting' && performance.now() - startMs > VERIFY_AFTER_MS) {
      encoder.copyBufferToBuffer(records, 0, readback, 0, agents * AGENT_RECORD_BYTES);
      const snapshot = new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES));
      for (let i = 0; i < agents; i++) store.writeRecord(i, snapshot, i);
      expected = new Uint8Array(snapshot.buffer);
      verifyState = 'copied';
    }
  };
  const afterSubmit = (): void => {
    if (verifyState === 'copied') {
      verifyState = 'done';
      verify();
    }
  };
  const dispose = (): void => {
    for (const buffer of owned) buffer.destroy();
  };

  if (strategy === 'ranges') {
    const mirror = new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES));
    const mirrorBytes = new Uint8Array(mirror.buffer);
    const dirty = new Uint32Array(agents);
    return {
      usesGpu: true,
      frame(encoder, timer) {
        const now = simTime();
        const simStart = performance.now();
        const stats = sim.step(now);
        const uploadStart = performance.now();
        let n = 0;
        sim.drainDirty((agent) => {
          store.writeRecord(agent, mirror, agent);
          dirty[n++] = agent;
        });
        const ids = dirty.subarray(0, n).sort();
        let writes = 0;
        let bytes = 0;
        for (let i = 0; i < n;) {
          const first = ids[i] ?? 0;
          let last = first;
          while (i + 1 < n && (ids[i + 1] ?? 0) - last <= RANGE_MERGE_GAP) last = ids[++i] ?? last;
          i++;
          const offset = first * AGENT_RECORD_BYTES;
          const size = (last - first + 1) * AGENT_RECORD_BYTES;
          device.queue.writeBuffer(records, offset, mirrorBytes, offset, size);
          writes++;
          bytes += size;
        }
        encodeIntegrate(encoder, timer);
        maybeVerify(encoder);
        const uploadCpuMs = performance.now() - uploadStart;
        return {
          simMs: uploadStart - simStart,
          uploadCpuMs,
          uploadBytes: bytes,
          writeCalls: writes,
          events: stats.events,
          dirty: n,
          ...verification(),
        };
      },
      afterSubmit,
      dispose,
    };
  }

  // `events`: one packed upload plus a scatter pass.
  const staging = new Uint32Array(agents * EVENT_WORDS);
  const stagingView = new DataView(staging.buffer);
  const eventBuffer = create('transfer events', staging.byteLength, STORAGE | COPY_DST);
  const countBuffer = create('transfer event count', 16, GPUBufferUsage.UNIFORM | COPY_DST);
  const scatter = device.createComputePipeline({
    label: 'transfer scatter',
    layout: 'auto',
    compute: { module: device.createShaderModule({ code: SCATTER_WGSL }), entryPoint: 'main' },
  });
  const scatterGroup = device.createBindGroup({
    layout: scatter.getBindGroupLayout(0),
    entries: [countBuffer, eventBuffer, records].map((buffer, binding) => ({
      binding,
      resource: { buffer },
    })),
  });
  const recordScratch = new DataView(new ArrayBuffer(AGENT_RECORD_BYTES));
  return {
    usesGpu: true,
    frame(encoder, timer) {
      const now = simTime();
      const simStart = performance.now();
      const stats = sim.step(now);
      const uploadStart = performance.now();
      let n = 0;
      sim.drainDirty((agent) => {
        const base = n * EVENT_WORDS;
        staging[base] = agent;
        store.writeRecord(agent, recordScratch, 0);
        for (let k = 0; k < AGENT_RECORD_BYTES / 4; k++) {
          stagingView.setUint32((base + 1 + k) * 4, recordScratch.getUint32(k * 4, true), true);
        }
        n++;
      });
      const bytes = n * EVENT_WORDS * 4;
      if (n > 0) {
        device.queue.writeBuffer(eventBuffer, 0, staging, 0, n * EVENT_WORDS);
        device.queue.writeBuffer(countBuffer, 0, new Uint32Array([n, 0, 0, 0]));
      }
      encodeIntegrate(encoder, timer, (pass) => {
        if (n === 0) return;
        pass.setPipeline(scatter);
        pass.setBindGroup(0, scatterGroup);
        pass.dispatchWorkgroups(Math.ceil(n / WORKGROUP));
      });
      maybeVerify(encoder);
      const uploadCpuMs = performance.now() - uploadStart;
      return {
        simMs: uploadStart - simStart,
        uploadCpuMs,
        uploadBytes: bytes,
        writeCalls: n > 0 ? 2 : 0,
        events: stats.events,
        dirty: n,
        ...verification(),
      };
    },
    afterSubmit,
    dispose,
  };
}
