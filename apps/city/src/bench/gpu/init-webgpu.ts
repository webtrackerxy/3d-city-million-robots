/** Enabled when the adapter offers them; every consumer must feature-detect on the device. */
const OPTIONAL_FEATURES: readonly GPUFeatureName[] = [
  'timestamp-query',
  'indirect-first-instance',
  'shader-f16',
  'texture-compression-bc',
  'texture-compression-astc',
  'texture-compression-etc2',
];

/**
 * Raised to whatever the adapter allows. The defaults are 256 MiB / 128 MiB / 8, and the crowd
 * vertex stage is the first place the storage-buffer count gets tight (implementation plan §8).
 */
const RAISED_LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
] as const;

export type WebGpuInit =
  { ok: true; adapter: GPUAdapter; device: GPUDevice } | { ok: false; reason: string };

export async function initWebGpu(): Promise<WebGpuInit> {
  if (!('gpu' in navigator)) {
    return { ok: false, reason: 'This browser does not expose WebGPU (navigator.gpu is missing).' };
  }

  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (adapter === null) {
    return { ok: false, reason: 'WebGPU is available but no suitable GPU adapter was found.' };
  }

  const requiredLimits: Record<string, number> = {};
  for (const name of RAISED_LIMITS) requiredLimits[name] = adapter.limits[name];

  try {
    const device = await adapter.requestDevice({
      label: 'benchmark device',
      requiredFeatures: OPTIONAL_FEATURES.filter((feature) => adapter.features.has(feature)),
      requiredLimits,
    });
    return { ok: true, adapter, device };
  } catch (error) {
    return { ok: false, reason: `requestDevice failed: ${String(error)}` };
  }
}
