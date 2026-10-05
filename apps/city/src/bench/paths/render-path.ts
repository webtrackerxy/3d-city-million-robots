import type { RenderPathKind } from '../harness/scenario.ts';
import type { LodControls } from '@city/render';

export type { LodControls } from '@city/render';

export interface PathFrameStats {
  /** CPU time spent advancing animation this frame. */
  animMs: number;
  drawCalls: number;
  triangles: number;
  /** Path-specific per-frame measurements, summarised per sweep step (e.g. upload bytes). */
  extras?: Record<string, number>;
}

/**
 * One way of drawing N animated characters. The engine owns the device, the frame loop and the
 * measurements; a path only draws. Paths B and C (steps 0.4, 0.9) implement the same interface.
 */
export interface RenderPath {
  readonly kind: RenderPathKind;
  setAgentCount(count: number): void;
  agentCount(): number;
  /** Called when the canvas's CSS size or pixel ratio changes, and once before the first frame. */
  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void;
  /** Only paths with GPU LOD selection implement this. */
  setLodControls?(controls: LodControls): void;
  /** Advances and draws one frame. `dtMs` is clamped by the engine. */
  frame(dtMs: number): PathFrameStats;
  dispose(): void;
}

/** GPU frame durations arrive asynchronously, a few frames late. */
export type GpuTimeSink = (ms: number) => void;
