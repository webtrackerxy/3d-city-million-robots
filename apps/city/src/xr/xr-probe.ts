import { MOBILE_DEVICE } from '../device.ts';

/** What this browser offers for XR, WebGPU and WebGL: the questions of the XR plan's Phase 0. */
export interface XrProbe {
  userAgent: string;
  mobileDevice: boolean;
  secureContext: boolean;
  crossOriginIsolated: boolean;
  cores: number | null;
  /** navigator.deviceMemory (GB, rounded by the browser), where exposed. */
  deviceMemoryGb: number | null;
  /** performance.memory.jsHeapSizeLimit (MB, Chromium), where exposed. */
  heapLimitMb: number | null;
  webxr: boolean;
  immersiveVr: boolean | null;
  immersiveAr: boolean | null;
  /** The WebXR–WebGPU binding three.js needs to present a WebGPU scene in XR. */
  xrGpuBinding: boolean;
  webgpu: boolean;
  webgpuAdapter: string | null;
  webgpuFeatures: string[];
  webgpuLimits: Partial<Record<(typeof LIMITS)[number], number>>;
  webgl2: boolean;
  webglRenderer: string | null;
  webglMultiview: string[];
  maxTextureSize: number | null;
  error: string | null;
}

const LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
  'maxComputeWorkgroupSizeX',
  'maxComputeInvocationsPerWorkgroup',
  'maxTextureDimension2D',
] as const;

async function sessionSupported(mode: XRSessionMode): Promise<boolean | null> {
  try {
    return (await navigator.xr?.isSessionSupported(mode)) ?? false;
  } catch {
    return null;
  }
}

export async function probeXr(): Promise<XrProbe> {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const memory = (performance as Performance & { memory?: { jsHeapSizeLimit: number } }).memory;
  const probe: XrProbe = {
    userAgent: navigator.userAgent,
    mobileDevice: MOBILE_DEVICE,
    secureContext: isSecureContext,
    crossOriginIsolated,
    cores: navigator.hardwareConcurrency || null,
    deviceMemoryGb: nav.deviceMemory ?? null,
    heapLimitMb: memory === undefined ? null : Math.round(memory.jsHeapSizeLimit / 2 ** 20),
    webxr: 'xr' in navigator,
    immersiveVr: null,
    immersiveAr: null,
    xrGpuBinding: 'XRGPUBinding' in globalThis,
    webgpu: 'gpu' in navigator,
    webgpuAdapter: null,
    webgpuFeatures: [],
    webgpuLimits: {},
    webgl2: false,
    webglRenderer: null,
    webglMultiview: [],
    maxTextureSize: null,
    error: null,
  };
  try {
    if (probe.webxr) {
      probe.immersiveVr = await sessionSupported('immersive-vr');
      probe.immersiveAr = await sessionSupported('immersive-ar');
    }
    if (probe.webgpu) {
      const adapter = await navigator.gpu.requestAdapter({ xrCompatible: true });
      if (adapter !== null) {
        const info = adapter.info;
        probe.webgpuAdapter =
          [info.vendor, info.architecture, info.device, info.description]
            .filter((s) => s !== '')
            .join(' · ') || 'unnamed adapter';
        probe.webgpuFeatures = [...adapter.features].sort();
        for (const key of LIMITS) probe.webgpuLimits[key] = adapter.limits[key];
      }
    }
    const gl = document.createElement('canvas').getContext('webgl2');
    if (gl !== null) {
      probe.webgl2 = true;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      probe.webglRenderer = String(
        gl.getParameter(debug === null ? gl.RENDERER : debug.UNMASKED_RENDERER_WEBGL),
      );
      probe.webglMultiview = ['OVR_multiview2', 'OCULUS_multiview'].filter(
        (name) => gl.getExtension(name) !== null,
      );
      probe.maxTextureSize = Number(gl.getParameter(gl.MAX_TEXTURE_SIZE));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch (e) {
    probe.error = e instanceof Error ? e.message : String(e);
  }
  return probe;
}

/** Phase 0's outcome from a probe: which rendering path XR can take on this device. */
export function xrPath(probe: XrProbe): string {
  if (!probe.webxr || probe.immersiveVr !== true)
    return 'No immersive WebXR here: XR needs a headset browser or PC VR.';
  if (probe.webgpu && probe.xrGpuBinding)
    return 'Path A looks possible: WebGPU and the WebXR–WebGPU binding are both present. Confirm with the WebGPU XR test.';
  return 'Path B: WebXR works, but not with WebGPU here, so XR needs the WebGL crowd renderer.';
}
