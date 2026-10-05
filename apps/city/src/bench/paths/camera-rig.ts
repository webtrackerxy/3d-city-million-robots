import { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/**
 * Camera, orbit controls and the framing presets shared by every render path. Only Three's maths
 * and input handling are used here, so the raw WebGPU path can use it too.
 */
export class CameraRig {
  readonly camera = new PerspectiveCamera(45, 1, 0.1, 5000);
  private readonly controls: OrbitControls;

  constructor(canvas: HTMLCanvasElement) {
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
  }

  /** Overhead view of a square grid of side `size`. Returns the ground extent to draw. */
  frameGrid(size: number, characterHeight: number): number {
    const extent = Math.max(size, characterHeight * 2);
    this.place(
      [extent * 0.15, characterHeight + extent * 0.75, extent * 1.2],
      [0, characterHeight * 0.4, 0],
      extent * 10,
    );
    return extent * 1.1;
  }

  /**
   * Street-level view from one edge of a square crowd of side `size`, looking across it, so the
   * crowd spans every LOD band from a few metres to the far side.
   */
  frameStreet(size: number, characterHeight: number): number {
    const extent = Math.max(size, characterHeight * 4);
    this.place(
      [0, characterHeight * 4, extent / 2 + characterHeight * 2],
      [0, characterHeight * 0.5, extent / 4],
      extent * 3,
    );
    return extent * 2;
  }

  /** Front view of a lineup `width` metres wide, at roughly eye height. */
  frameLineup(width: number, characterHeight: number): number {
    const distance = Math.max(4, width * 1.25);
    // Offset left so the lineup clears the debug panel on the left of the viewport.
    const offset = -width * 0.12;
    this.place(
      [offset, characterHeight * 0.8, distance],
      [offset, characterHeight * 0.5, -width * 0.2],
      distance * 20,
    );
    return width * 4 + 10;
  }

  setAspect(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(): void {
    this.controls.update();
    this.camera.updateMatrixWorld();
  }

  dispose(): void {
    this.controls.dispose();
  }

  private place(
    position: [number, number, number],
    target: [number, number, number],
    far: number,
  ): void {
    this.camera.position.set(...position);
    this.controls.target.set(...target);
    this.camera.far = far;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
}
