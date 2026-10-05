import {
  type AdapterReport,
  buildAdapterReport,
  GpuAllocationTracker,
  instrumentDevice,
  type MetricsBus,
} from '@city/metrics';
import { type CharacterInfo, loadFamilies } from '../characters/character-family.ts';
import { BENCHMARK_RESULT_SCHEMA, type BenchmarkResult } from '../harness/benchmark-result.ts';
import { RenderPathKind, type Scenario } from '../harness/scenario.ts';
import { type MemoryProbe, SweepRunner } from '../harness/sweep-runner.ts';
import { createIdlePath } from '../paths/idle-path.ts';
import { createPathA } from '../paths/path-a.ts';
import { createPathB } from '../paths/path-b.ts';
import { createPathC } from '../paths/path-c.ts';
import { createTransferPath } from '../paths/transfer-path.ts';
import type { GpuTimeSink, LodControls, RenderPath } from '../paths/render-path.ts';
import { initWebGpu } from './init-webgpu.ts';

export type { CharacterInfo } from '../characters/character-family.ts';

export type EngineStatus =
  | { state: 'starting'; message: string }
  | { state: 'running'; report: AdapterReport; characters: CharacterInfo[] }
  | { state: 'failed'; reason: string };

export interface EngineCallbacks {
  onStatus(status: EngineStatus): void;
  onResult(result: BenchmarkResult): void;
}

export interface EngineHandle {
  setAgentCount(count: number): void;
  setLodControls(controls: LodControls): void;
  /** Starts the scenario's sweep. Returns false if the engine is not ready or already sweeping. */
  runSweep(): boolean;
  dispose(): void;
}

/** Frames longer than this (tab in background, breakpoint) do not advance animation further. */
const MAX_FRAME_DT_MS = 100;

/** Exposed for the Playwright matrix runner (step 0.11). */
export interface BenchmarkGlobal {
  status: 'starting' | 'ready' | 'running' | 'done' | 'failed';
  result?: BenchmarkResult;
  error?: string;
}

declare global {
  interface Window {
    __cityBenchmark?: BenchmarkGlobal;
  }
}

/**
 * Owns the GPUDevice, the render path and the frame loop. Lives entirely outside React: the UI
 * receives coarse status changes and results, and polls the MetricsBus for numbers.
 */
export function startEngine(
  canvas: HTMLCanvasElement,
  bus: MetricsBus,
  scenario: Scenario,
  callbacks: EngineCallbacks,
): EngineHandle {
  const lifecycle = { disposed: false };
  // A call, not a property read: TS would keep the narrowing from an earlier check across awaits,
  // although dispose() can flip the flag in between.
  const isDisposed = (): boolean => lifecycle.disposed;
  let running: RunningEngine | undefined;

  const fail = (reason: string): void => {
    if (isDisposed()) return;
    window.__cityBenchmark = { status: 'failed', error: reason };
    callbacks.onStatus({ state: 'failed', reason });
  };

  window.__cityBenchmark = { status: 'starting' };
  callbacks.onStatus({ state: 'starting', message: 'Initialising WebGPU…' });

  void (async () => {
    const init = await initWebGpu();
    if (!init.ok) {
      fail(init.reason);
      return;
    }
    const { adapter, device } = init;
    if (isDisposed()) {
      device.destroy();
      return;
    }
    void device.lost.then((info) => {
      fail(`GPU device lost: ${info.message}`);
    });

    try {
      running = await startRunning(canvas, device, bus, scenario, callbacks, (message) => {
        if (!isDisposed()) callbacks.onStatus({ state: 'starting', message });
      });
    } catch (error) {
      device.destroy();
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    if (isDisposed()) {
      running.dispose();
      return;
    }

    const report = buildAdapterReport(adapter, device);
    running.report = report;
    window.__cityBenchmark = { status: 'ready' };
    callbacks.onStatus({ state: 'running', report, characters: running.characters });
    if (scenario.autorun) running.runSweep();
  })();

  return {
    setAgentCount(count) {
      running?.setAgentCount(count);
    },
    setLodControls(controls) {
      running?.setLodControls(controls);
    },
    runSweep() {
      return running?.runSweep() ?? false;
    },
    dispose() {
      lifecycle.disposed = true;
      running?.dispose();
    },
  };
}

interface RunningEngine {
  report: AdapterReport | undefined;
  characters: CharacterInfo[];
  setAgentCount(count: number): void;
  setLodControls(controls: LodControls): void;
  runSweep(): boolean;
  dispose(): void;
}

async function startRunning(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  bus: MetricsBus,
  scenario: Scenario,
  callbacks: EngineCallbacks,
  progress: (message: string) => void,
): Promise<RunningEngine> {
  const tracker = new GpuAllocationTracker();
  instrumentDevice(device, tracker);

  let path: RenderPath | undefined;
  let sweep: SweepRunner | null = null;

  const onGpuMs: GpuTimeSink = (ms) => {
    bus.record('gpu.frameMs', ms);
    sweep?.gpuSample(ms);
  };

  const memory: MemoryProbe = {
    gpuBytes: () => {
      const totals = tracker.totals();
      return totals.bufferBytes + totals.textureBytes;
    },
    lodVisible: () => {
      const gauges = bus.snapshot().gauges;
      const counts = [0, 1, 2, 3, 4, 5].map((lod) => gauges[`lod.visible${lod}`]);
      return counts.every((c) => c === undefined) ? null : counts.map((c) => c ?? 0);
    },
    jsHeapBytes: () =>
      (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  };

  let characters: CharacterInfo[] = [];
  try {
    if (scenario.path === RenderPathKind.Idle) {
      path = createIdlePath(canvas, device, onGpuMs);
    } else if (scenario.path === RenderPathKind.Transfer) {
      path = createTransferPath(canvas, device, scenario.strategy, scenario.seed, bus, onGpuMs);
    } else {
      const withLods = scenario.path !== RenderPathKind.A;
      const families = await loadFamilies(scenario, bus, withLods, progress);
      characters = families.map((family) => family.info);
      progress('Compiling pipelines…');
      const lineup = scenario.layout === 'lineup';
      if (scenario.path === RenderPathKind.A) {
        path = await createPathA(
          canvas,
          device,
          families,
          scenario.robotShare,
          scenario.seed,
          onGpuMs,
        );
      } else if (scenario.path === RenderPathKind.B) {
        path = await createPathB(
          canvas,
          device,
          families,
          scenario.robotShare,
          scenario.seed,
          scenario.tint,
          lineup,
          bus,
          onGpuMs,
        );
      } else {
        path = await createPathC(
          canvas,
          device,
          families,
          scenario.robotShare,
          scenario.seed,
          scenario.tint,
          lineup,
          bus,
          onGpuMs,
        );
      }
    }
  } catch (error) {
    path?.dispose();
    throw error;
  }

  const activePath = path;
  let cssWidth = 0;
  let cssHeight = 0;
  let pixelRatio = 0;
  const resizeIfNeeded = (): void => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    const maxDimension = device.limits.maxTextureDimension2D;
    const ratio = Math.min(devicePixelRatio, maxDimension / width, maxDimension / height);
    if (width === cssWidth && height === cssHeight && ratio === pixelRatio) return;
    cssWidth = width;
    cssHeight = height;
    pixelRatio = ratio;
    activePath.resize(width, height, ratio);
  };

  resizeIfNeeded();
  activePath.setLodControls?.({
    forced: scenario.lod,
    impostors: scenario.impostors,
    preset: scenario.lodPreset,
    debugColours: scenario.lodColours,
    fade: scenario.fade,
    fadeMs: scenario.fadeMs,
  });
  activePath.setAgentCount(scenario.agents);

  const engine: RunningEngine = {
    report: undefined,
    characters,
    setAgentCount(count) {
      if (sweep === null) activePath.setAgentCount(count);
    },
    setLodControls(controls) {
      activePath.setLodControls?.(controls);
    },
    runSweep() {
      if (sweep !== null) return false;
      sweep = new SweepRunner(scenario.sweep, scenario, memory);
      activePath.setAgentCount(sweep.start(performance.now()));
      window.__cityBenchmark = { status: 'running' };
      return true;
    },
    dispose() {
      cancelAnimationFrame(frameRequest);
      activePath.dispose();
      device.destroy();
      bus.reset();
    },
  };

  const finishSweep = (runner: SweepRunner): void => {
    const report = engine.report;
    if (report === undefined) return;
    const result: BenchmarkResult = {
      schema: BENCHMARK_RESULT_SCHEMA,
      createdAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      devicePixelRatio,
      canvas: { width: canvas.width, height: canvas.height },
      crossOriginIsolated,
      adapter: report,
      scenario: {
        path: scenario.path,
        models: scenario.models,
        clip: scenario.clip,
        tris: scenario.tris,
        robot: scenario.robot,
        robotShare: scenario.robotShare,
        robotClip: scenario.robotClip,
        robotSkin: scenario.robotSkin,
        robotHeight: scenario.robotHeight,
        agents: scenario.agents,
        sweep: scenario.sweep,
        warmupMs: scenario.warmupMs,
        measureMs: scenario.measureMs,
        seed: scenario.seed,
        lod: scenario.lod,
        impostors: scenario.impostors,
        lodPreset: scenario.lodPreset,
        lodColours: scenario.lodColours,
        fade: scenario.fade,
        fadeMs: scenario.fadeMs,
        tint: scenario.tint,
        layout: scenario.layout,
        strategy: scenario.strategy,
      },
      characters,
      steps: [...runner.completed()],
    };
    window.__cityBenchmark = { status: 'done', result };
    callbacks.onResult(result);
  };

  let frameRequest = 0;
  let previousFrameStart = performance.now();

  const frame = (frameStart: number): void => {
    frameRequest = requestAnimationFrame(frame);
    const intervalMs = frameStart - previousFrameStart;
    previousFrameStart = frameStart;
    const cpuStart = performance.now();

    resizeIfNeeded();
    const stats = activePath.frame(Math.min(Math.max(intervalMs, 0), MAX_FRAME_DT_MS));
    const cpuMs = performance.now() - cpuStart;

    bus.record('frame.intervalMs', intervalMs);
    bus.record('frame.cpuMs', cpuMs);
    bus.record('anim.updateMs', stats.animMs);

    const runner = sweep;
    if (runner !== null) {
      const next = runner.frame(frameStart, { intervalMs, cpuMs, ...stats });
      if (next !== undefined) activePath.setAgentCount(next);
      const state = runner.progress();
      bus.setGauge('sweep.step', state.step + 1);
      bus.setGauge('sweep.steps', state.steps);
      bus.setGauge('sweep.measuring', state.phase === 'measure' ? 1 : 0);
      if (state.phase === 'done') {
        sweep = null;
        finishSweep(runner);
      }
    }
    bus.setGauge('sweep.active', sweep === null ? 0 : 1);

    const gpu = tracker.totals();
    bus.setGauge('gpu.bufferBytes', gpu.bufferBytes);
    bus.setGauge('gpu.bufferCount', gpu.bufferCount);
    bus.setGauge('gpu.textureBytes', gpu.textureBytes);
    bus.setGauge('gpu.textureCount', gpu.textureCount);
    bus.setGauge('gpu.peakBytes', gpu.peakBytes);
    bus.setGauge('canvas.width', canvas.width);
    bus.setGauge('canvas.height', canvas.height);
    bus.setGauge('render.drawCalls', stats.drawCalls);
    bus.setGauge('render.triangles', stats.triangles);
    bus.setGauge('agents.total', activePath.agentCount());
    // Paths with GPU culling publish their own visible count from an asynchronous readback.
    if (activePath.setLodControls === undefined) {
      bus.setGauge('agents.visible', activePath.agentCount());
    }
  };

  frameRequest = requestAnimationFrame(frame);
  return engine;
}
