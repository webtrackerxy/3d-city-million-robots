import { GpuPassTimer } from '@city/metrics';
import { RenderPathKind } from '../harness/scenario.ts';
import type { GpuTimeSink, PathFrameStats, RenderPath } from './render-path.ts';

/**
 * Clears the screen and nothing else. Its numbers are the harness floor that every other path is
 * compared against.
 */
export function createIdlePath(
  canvas: HTMLCanvasElement,
  device: GPUDevice,
  onGpuMs: GpuTimeSink,
): RenderPath {
  const context = canvas.getContext('webgpu');
  if (context === null) throw new Error('Canvas does not support a WebGPU context');
  context.configure({
    device,
    format: navigator.gpu.getPreferredCanvasFormat(),
    alphaMode: 'opaque',
  });

  const timer = GpuPassTimer.isSupported(device) ? new GpuPassTimer(device, 'clear') : null;
  const stats: PathFrameStats = { animMs: 0, drawCalls: 0, triangles: 0 };
  let agents = 0;

  return {
    kind: RenderPathKind.Idle,
    setAgentCount(count) {
      agents = count;
    },
    agentCount: () => agents,
    resize(cssWidth, cssHeight, pixelRatio) {
      canvas.width = Math.max(1, Math.round(cssWidth * pixelRatio));
      canvas.height = Math.max(1, Math.round(cssHeight * pixelRatio));
    },
    frame() {
      // Slow colour drift: a static clear is indistinguishable from a hung frame loop.
      const t = performance.now() / 1000;
      const encoder = device.createCommandEncoder({ label: 'frame' });
      const pass = encoder.beginRenderPass({
        label: 'clear',
        colorAttachments: [
          {
            view: context.getCurrentTexture().createView(),
            clearValue: {
              r: 0.04 + 0.03 * Math.sin(t * 0.7),
              g: 0.06 + 0.03 * Math.sin(t * 0.9 + 2),
              b: 0.1 + 0.04 * Math.sin(t * 0.5 + 4),
              a: 1,
            },
            loadOp: 'clear',
            storeOp: 'store',
          },
        ],
        ...(timer === null ? {} : { timestampWrites: timer.timestampWrites }),
      });
      pass.end();
      timer?.resolve(encoder);
      device.queue.submit([encoder.finish()]);
      timer?.readback(onGpuMs);
      return stats;
    },
    dispose() {
      timer?.destroy();
      context.unconfigure();
    },
  };
}
