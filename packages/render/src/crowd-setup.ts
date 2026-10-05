import type { MetricsBus } from '@city/metrics';
import { Frustum, Matrix4, type PerspectiveCamera } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { HUMAN_HEIGHT_VARIATION } from './appearance.ts';
import { bakeImpostors, type ImpostorAtlas } from './bake-impostors.ts';
import type { LoadedFamily } from './family.ts';
import { type CrowdFamily, type GpuCrowd, LOD_AUTO } from './gpu-crowd.ts';
import { IMPOSTOR_THRESHOLD, LOD_THRESHOLDS, type LodControls, pxPerRadian } from './lod-policy.ts';

/**
 * Turns loaded families into crowd families: bakes each family's impostor atlas on this
 * renderer's device (step 0.8) and gathers what the kernels need per family.
 */
export function prepareCrowdFamilies(
  renderer: WebGPURenderer,
  families: readonly LoadedFamily[],
  tint: boolean,
  bus: MetricsBus,
): CrowdFamily[] {
  return families.map((family) => {
    if (family.lodChain === null) throw new Error(`The GPU crowd needs LODs for ${family.key}`);
    const lod2 = family.lodChain.geometries[2];
    let impostor: ImpostorAtlas | null = null;
    if (lod2 !== undefined) {
      impostor = bakeImpostors(renderer, {
        template: family.source.template,
        clip: family.source.clip,
        geometries: lod2,
        meshes: family.source.meshes,
        height: family.source.height,
      });
      bus.setGauge(`impostor.${family.key}.bakeMs`, impostor.bakeMs);
      bus.setGauge(`impostor.${family.key}.bytes`, impostor.bytes);
    }
    return {
      animation: family.baked.baked,
      lods: family.lodChain.geometries,
      materials: family.source.meshes.map((mesh) => mesh.material),
      influences: family.source.influences,
      height: family.source.height,
      forwardAngle: Math.atan2(family.baked.forward[0], family.baked.forward[1]),
      robot: family.robot,
      heightVariation: family.robot || !tint ? 0 : HUMAN_HEIGHT_VARIATION,
      impostor,
    };
  });
}

export function applyLodControls(crowd: GpuCrowd, controls: LodControls): void {
  const [a, b, c, d] = LOD_THRESHOLDS[controls.preset];
  crowd.uniforms.lodThresholds.value.set(a, b, c, d);
  crowd.uniforms.forcedLod.value = controls.forced ?? LOD_AUTO;
  crowd.uniforms.impostorPx.value = controls.impostors ? IMPOSTOR_THRESHOLD[controls.preset] : 0;
  crowd.uniforms.fadeMs.value = controls.fade ? controls.fadeMs : 0;
  crowd.uniforms.debugColours.value = controls.debugColours ? 1 : 0;
}

const frustum = new Frustum();
const viewProjection = new Matrix4();

/** Per-frame uniforms: frustum planes, camera position, pixels per radian, simulation time. */
export function updateCrowdView(
  crowd: GpuCrowd,
  camera: PerspectiveCamera,
  drawingBufferHeight: number,
  simTimeMs: number,
): void {
  camera.updateMatrixWorld();
  viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(viewProjection, camera.coordinateSystem);
  frustum.planes.forEach((plane, index) => {
    crowd.uniforms.planeValues[index]?.set(
      plane.normal.x,
      plane.normal.y,
      plane.normal.z,
      plane.constant,
    );
  });
  crowd.uniforms.cameraPosition.value.copy(camera.position);
  crowd.uniforms.pxPerRadian.value = pxPerRadian(drawingBufferHeight, (camera.fov * Math.PI) / 180);
  crowd.uniforms.simTimeMs.value = simTimeMs >>> 0;
}
