import {
  Color,
  FloatType,
  type Layers,
  Matrix4,
  NoBlending,
  type PerspectiveCamera,
  RedFormat,
  type Scene,
  Vector4,
} from 'three';
import {
  cameraProjectionMatrix,
  ceil,
  float,
  floor,
  Fn,
  If,
  instancedArray,
  instanceIndex,
  int,
  ivec2,
  log2,
  max,
  min,
  positionView,
  select,
  textureLoad,
  uint,
  uniform,
  uniformArray,
  vec4,
} from 'three/tsl';
import {
  type ComputeNode,
  MeshBasicNodeMaterial,
  type Node,
  RenderTarget,
  type WebGPURenderer,
} from 'three/webgpu';

/**
 * Hi-Z occlusion (implementation plan §20.4): the static city is drawn depth-only into a small
 * float target (linear view depth), compute passes reduce it to a max-depth pyramid in a storage
 * buffer, and `occluded()` tests a bounding sphere against the pyramid level where the sphere
 * covers at most 2 × 2 texels. Buildings are static and the pyramid is rebuilt every frame from
 * the current camera, so there is no frame of latency.
 */
const MAX_LEVELS = 12;
/** Pyramid base width; height follows the aspect ratio. */
const BASE_WIDTH = 512;
const FAR = 1e9;

export interface HiZ {
  /** Renders the occluder layer and rebuilds the pyramid. Call before the crowd's passes. */
  update(renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera): void;
  /** TSL: is the sphere (world centre, radius) fully hidden behind occluders? */
  occluded(centre: Node<'vec3'>, radius: Node<'float'>): Node<'bool'>;
  /**
   * Switches occlusion on or off without rebuilding the crowd. Off, `update` does nothing and
   * nothing is occluded (from high above little is hidden, and the prepass is not free).
   */
  setActive(active: boolean): void;
  /** Base resolution, for diagnostics. */
  readonly size: { width: number; height: number };
  dispose(): void;
}

export function createHiZ(occluderLayer: number): HiZ {
  const size = { width: BASE_WIDTH, height: BASE_WIDTH };
  const target = new RenderTarget(BASE_WIDTH, BASE_WIDTH, {
    type: FloatType,
    format: RedFormat,
    depthBuffer: true,
  });
  // Opaque, single-channel output: no blending (the red-only target has no alpha to blend).
  const depthMaterial = new MeshBasicNodeMaterial({ blending: NoBlending, transparent: false });
  // Distance along the view direction: clip w. (Not −positionView.z: under the map overlay the
  // camera's view matrix is only a translation and the rotation lives in its projection, so view
  // z is a world axis there, and occlusion would hide agents depending on the heading.)
  depthMaterial.colorNode = vec4(cameraProjectionMatrix.mul(vec4(positionView, 1)).w, 0, 0, 1);

  // Level k: width, height, offset into the buffer (texels), unused.
  const levelValues = Array.from({ length: MAX_LEVELS }, () => new Vector4());
  const levels = uniformArray(levelValues, 'vec4' as const);
  const levelCount = uniform(1, 'uint');
  let capacity = 0;
  for (let k = 0, w = BASE_WIDTH, h = BASE_WIDTH; k < MAX_LEVELS; k++) {
    capacity += w * h;
    w = Math.max(1, Math.ceil(w / 2));
    h = Math.max(1, Math.ceil(h / 2));
  }
  const pyramid = instancedArray(new Float32Array(capacity), 'float');
  const viewProjection = uniform(new Matrix4());
  /** Projection's y scale (P[1][1]), for the sphere's size in texels. */
  const projectionY = uniform(1);
  const enabled = uniform(1, 'uint');
  let active = true;

  const copyBase = Fn(() => {
    const base = levels.element(0);
    const x = instanceIndex.mod(uint(base.x));
    const y = instanceIndex.div(uint(base.x));
    If(y.lessThan(uint(base.y)), () => {
      pyramid.element(instanceIndex).assign(textureLoad(target.texture, ivec2(int(x), int(y))).x);
    });
  })().compute(BASE_WIDTH * BASE_WIDTH);

  const reduce: ComputeNode[] = [];
  for (let k = 1; k < MAX_LEVELS; k++) {
    const dst = levels.element(k);
    const src = levels.element(k - 1);
    reduce.push(
      Fn(() => {
        const width = uint(dst.x);
        const x = instanceIndex.mod(width);
        const y = instanceIndex.div(width);
        If(y.lessThan(uint(dst.y)), () => {
          const sw = uint(src.x);
          const sh = uint(src.y);
          const umin = (a: Node<'uint'>, b: Node<'uint'>) => select(a.lessThan(b), a, b);
          const at = (dx: number, dy: number) =>
            pyramid.element(
              uint(src.z)
                .add(umin(y.mul(2).add(uint(dy)), sh.sub(1)).mul(sw))
                .add(umin(x.mul(2).add(uint(dx)), sw.sub(1))),
            );
          pyramid
            .element(uint(dst.z).add(instanceIndex))
            .assign(max(max(at(0, 0), at(1, 0)), max(at(0, 1), at(1, 1))));
        });
      })().compute(Math.ceil(BASE_WIDTH / 2 ** k) ** 2),
    );
  }

  const occluded = (centre: Node<'vec3'>, radius: Node<'float'>): Node<'bool'> => {
    const clip = viewProjection.mul(vec4(centre, 1));
    // Linear depth of the sphere's nearest point; spheres through the near plane are visible.
    const nearest = clip.w.sub(radius);
    const base = levels.element(0);
    const ndcX = clip.x.div(clip.w);
    const ndcY = clip.y.div(clip.w);
    const px = ndcX.mul(0.5).add(0.5).mul(base.x);
    const py = float(0.5).sub(ndcY.mul(0.5)).mul(base.y);
    const pr = radius.mul(projectionY).mul(base.y).mul(0.5).div(clip.w).add(1);
    // Level where the sphere's square spans at most two texels per axis.
    const level = min(max(ceil(log2(pr.mul(2))), float(0)), float(levelCount.sub(1)));
    const scale = float(1).div(float(2).pow(level));
    const params = levels.element(uint(level));
    const x0 = uint(max(floor(px.sub(pr).mul(scale)), float(0)));
    const y0 = uint(max(floor(py.sub(pr).mul(scale)), float(0)));
    const x1 = uint(min(floor(px.add(pr).mul(scale)), params.x.sub(1)));
    const y1 = uint(min(floor(py.add(pr).mul(scale)), params.y.sub(1)));
    const read = (x: Node<'uint'>, y: Node<'uint'>) =>
      pyramid.element(
        uint(params.z)
          .add(y.mul(uint(params.x)))
          .add(x),
      );
    const farthest = max(max(read(x0, y0), read(x1, y0)), max(read(x0, y1), read(x1, y1)));
    return enabled
      .equal(uint(1))
      .and(clip.w.greaterThan(radius))
      .and(px.add(pr).greaterThan(0))
      .and(py.add(pr).greaterThan(0))
      .and(nearest.greaterThan(farthest));
  };

  const clearColour = new Color(FAR, 0, 0);
  const saved = new Color();
  let layersMask = 0;
  return {
    size,
    setActive(next) {
      active = next;
      enabled.value = next ? 1 : 0;
    },
    update(renderer, scene, camera) {
      if (!active) return;
      const aspect = camera.aspect > 0 ? camera.aspect : 1;
      const height = Math.max(1, Math.min(BASE_WIDTH, Math.round(BASE_WIDTH / aspect)));
      if (height !== size.height) {
        size.height = height;
        target.setSize(BASE_WIDTH, height);
        let offset = 0;
        let w = BASE_WIDTH;
        let h = height;
        let count = 0;
        for (let k = 0; k < MAX_LEVELS; k++) {
          levelValues[k]?.set(w, h, offset, 0);
          offset += w * h;
          count++;
          if (w === 1 && h === 1) break;
          w = Math.max(1, Math.ceil(w / 2));
          h = Math.max(1, Math.ceil(h / 2));
        }
        levelCount.value = count;
      }
      camera.updateMatrixWorld();
      viewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      // 1 / tan(fov / 2): P[1][1] of a plain perspective, but also right for cameras whose
      // projection carries the view rotation (the map overlay).
      projectionY.value = 1 / Math.tan((camera.fov * Math.PI) / 360);

      // Depth-only pass over the occluder layer.
      const background = scene.background;
      const override = scene.overrideMaterial;
      const layers: Layers = camera.layers;
      layersMask = layers.mask;
      renderer.getClearColor(saved);
      const alpha = renderer.getClearAlpha();
      scene.background = null;
      scene.overrideMaterial = depthMaterial;
      layers.set(occluderLayer);
      renderer.setRenderTarget(target);
      renderer.setClearColor(clearColour, 1);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);
      renderer.setClearColor(saved, alpha);
      layers.mask = layersMask;
      scene.overrideMaterial = override;
      scene.background = background;

      void renderer.compute([copyBase, ...reduce.slice(0, levelCount.value - 1)]);
    },
    occluded,
    dispose() {
      target.dispose();
      depthMaterial.dispose();
      for (const pass of [copyBase, ...reduce]) pass.dispose();
    },
  };
}
