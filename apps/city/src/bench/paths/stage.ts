import {
  Color,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  type PerspectiveCamera,
  PlaneGeometry,
  Scene,
} from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { CameraRig } from './camera-rig.ts';
import type { GpuTimeSink } from './render-path.ts';

/** Scene look shared by every path (Path C reproduces these lights in WGSL). */
export const STAGE_BACKGROUND = 0x0b0f16;
export const STAGE_SKY = 0xdfe8ff;
export const STAGE_GROUND_LIGHT = 0x262b33;
export const STAGE_HEMISPHERE_INTENSITY = 1.8;
export const STAGE_SUN_INTENSITY = 2.2;
export const STAGE_SUN_POSITION = [6, 12, 8] as const;
export const STAGE_GROUND_COLOUR = 0x1a212c;

/**
 * Scene, lights, ground, camera and GPU timing shared by the Three.js paths, so A and B differ
 * only in how characters are drawn.
 */
export class Stage {
  readonly scene = new Scene();
  readonly rig: CameraRig;
  private readonly renderer: WebGPURenderer;
  private readonly ground: Mesh<PlaneGeometry, MeshStandardMaterial>;
  private readonly trackTimestamp: boolean;
  private resolving = false;

  constructor(renderer: WebGPURenderer, canvas: HTMLCanvasElement, trackTimestamp: boolean) {
    this.renderer = renderer;
    this.trackTimestamp = trackTimestamp;
    this.rig = new CameraRig(canvas);
    this.scene.background = new Color(STAGE_BACKGROUND);
    this.scene.add(new HemisphereLight(STAGE_SKY, STAGE_GROUND_LIGHT, STAGE_HEMISPHERE_INTENSITY));
    const sun = new DirectionalLight(0xffffff, STAGE_SUN_INTENSITY);
    sun.position.set(...STAGE_SUN_POSITION);
    this.scene.add(sun);

    this.ground = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshStandardMaterial({ color: STAGE_GROUND_COLOUR }),
    );
    this.ground.rotation.x = -Math.PI / 2;
    this.scene.add(this.ground);
  }

  get camera(): PerspectiveCamera {
    return this.rig.camera;
  }

  /** Overhead view of a square grid of side `size`. */
  frame(size: number, characterHeight: number): void {
    this.setGround(this.rig.frameGrid(size, characterHeight));
  }

  /** Street-level view across a square crowd of side `size` (see CameraRig.frameStreet). */
  frameStreet(size: number, characterHeight: number): void {
    this.setGround(this.rig.frameStreet(size, characterHeight));
  }

  /** Front view of a lineup `width` metres wide. */
  frameLineup(width: number, characterHeight: number): void {
    this.setGround(this.rig.frameLineup(width, characterHeight));
  }

  resize(cssWidth: number, cssHeight: number, pixelRatio: number): void {
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(cssWidth, cssHeight, false);
    this.rig.setAspect(cssWidth / Math.max(1, cssHeight));
  }

  render(): { drawCalls: number; triangles: number } {
    this.rig.update();
    this.renderer.render(this.scene, this.camera);
    return {
      drawCalls: this.renderer.info.render.drawCalls,
      triangles: this.renderer.info.render.triangles,
    };
  }

  /** Reports render + compute GPU time. Skips frames while a previous readback is pending. */
  resolveGpuTime(onGpuMs: GpuTimeSink, includeCompute: boolean): void {
    if (!this.trackTimestamp || this.resolving) return;
    this.resolving = true;
    void Promise.all([
      this.renderer.resolveTimestampsAsync('render'),
      includeCompute ? this.renderer.resolveTimestampsAsync('compute') : Promise.resolve(0),
    ])
      .then(([render, compute]) => {
        const total = (render ?? 0) + (compute ?? 0);
        if (total > 0) onGpuMs(total);
      })
      .finally(() => {
        this.resolving = false;
      });
  }

  private setGround(extent: number): void {
    this.ground.scale.set(extent, extent, 1);
  }

  dispose(): void {
    this.rig.dispose();
    this.ground.geometry.dispose();
    this.ground.material.dispose();
  }
}
