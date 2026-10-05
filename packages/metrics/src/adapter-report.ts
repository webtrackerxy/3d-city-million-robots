/** Optional features the architecture cares about (implementation plan §9, §23). */
export const TRACKED_FEATURES = [
  'timestamp-query',
  'indirect-first-instance',
  'shader-f16',
  'float32-filterable',
  'texture-compression-bc',
  'texture-compression-astc',
  'texture-compression-etc2',
] as const satisfies readonly GPUFeatureName[];

export const TRACKED_LIMITS = [
  'maxBufferSize',
  'maxStorageBufferBindingSize',
  'maxUniformBufferBindingSize',
  'maxStorageBuffersPerShaderStage',
  'maxBindGroups',
  'maxVertexBuffers',
  'maxComputeInvocationsPerWorkgroup',
  'maxComputeWorkgroupSizeX',
  'maxComputeWorkgroupsPerDimension',
  'maxTextureDimension2D',
  'maxTextureArrayLayers',
] as const satisfies readonly (keyof GPUSupportedLimits)[];

export interface FeatureReport {
  name: string;
  /** The hardware/browser supports it. */
  adapter: boolean;
  /** It was actually enabled on the device. */
  device: boolean;
}

export interface LimitReport {
  name: string;
  adapter: number;
  device: number;
}

export interface AdapterReport {
  vendor: string;
  architecture: string;
  deviceName: string;
  description: string;
  features: FeatureReport[];
  limits: LimitReport[];
}

export function buildAdapterReport(
  adapter: Pick<GPUAdapter, 'info' | 'features' | 'limits'>,
  device: Pick<GPUDevice, 'features' | 'limits'>,
): AdapterReport {
  return {
    vendor: adapter.info.vendor,
    architecture: adapter.info.architecture,
    deviceName: adapter.info.device,
    description: adapter.info.description,
    features: TRACKED_FEATURES.map((name) => ({
      name,
      adapter: adapter.features.has(name),
      device: device.features.has(name),
    })),
    limits: TRACKED_LIMITS.map((name) => ({
      name,
      adapter: adapter.limits[name],
      device: device.limits[name],
    })),
  };
}
