import {
  AnimationMixer,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  FloatType,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  type Material,
  Mesh,
  MeshLambertMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { simplifyGeometry } from '@city/assets-runtime';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

export interface WebglStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
}

export interface WebglInfo {
  gpu: string;
  maxTextureSize: number;
  /** Robot vertices and triangles, and the baked walk cycle's frames. */
  vertices: number;
  triangles: number;
  frames: number;
  vr: boolean;
}

export interface WebglCrowd {
  readonly info: WebglInfo;
  /** The WebXR "Enter VR" button (shows "VR not supported" where there is no WebXR). */
  readonly vrButton: HTMLElement;
  setCount(count: number): void;
  dispose(): void;
}

export const MAX_ROBOTS = 50_000;
/** The city's robot (Tesla Optimus, rigged by tools/auto-rig), simplified for a crowd. */
const MODEL_URL = '/models/optimus.glb';
const CLIP = 'walk';
/** Triangles per robot after simplification (the city crowd's LOD3 for the robot). */
const TARGET_TRIANGLES = 3_000;
/** Baked frames of the walk cycle, played at the clip's own speed. */
const FRAMES = 32;
const HEIGHT_M = 1.75;
const WALK_MPS = 1.3;
/** Each robot walks back and forth along a 40 m line (wrapping), so they spread out evenly. */
const HALF_WALK_M = 20;
/** Width of the baked textures (texels); rows follow from vertices × frames. */
const TEXTURE_WIDTH = 2048;

/** One robot, merged into a single geometry, and its walk cycle baked per vertex. */
interface Baked {
  geometry: BufferGeometry;
  positions: DataTexture;
  normals: DataTexture;
  vertices: number;
  triangles: number;
  fps: number;
}

/**
 * WebGL 2 crowd test (/webgl): the Optimus robot simplified to ~3k triangles, its walk cycle baked into vertex
 * animation textures, drawn as one instanced mesh. Each robot animates and walks in the vertex
 * shader, so the CPU does no per-robot work: this measures what the GPU can draw. No WebGPU, so
 * it runs on older iPhones and in the Quest Browser, and WebXR can take it into VR.
 */
export async function startWebglCrowd(
  canvas: HTMLCanvasElement,
  onStats: (stats: WebglStats) => void,
): Promise<WebglCrowd> {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');

  const scene = new Scene();
  scene.background = new Color(0x9fb7cc);
  scene.add(new HemisphereLight(0xdfe8ff, 0x3a3f46, 1.8));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-60, 90, 40);
  scene.add(sun);
  const ground = new Mesh(
    new PlaneGeometry(2000, 2000),
    new MeshLambertMaterial({ color: 0x6b7480 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const camera = new PerspectiveCamera(60, 1, 0.1, 3000);
  camera.position.set(0, 25, 70);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.update();

  const baked = await bakeRobot();
  const instances = new Float32Array(MAX_ROBOTS * 4);
  const geometry = new InstancedBufferGeometry();
  geometry.index = baked.geometry.index;
  for (const name of ['position', 'normal', 'color', 'aVid'])
    geometry.setAttribute(name, baked.geometry.getAttribute(name));
  const inst = new InstancedBufferAttribute(instances, 4);
  geometry.setAttribute('aInst', inst);

  const time = { value: 0 };
  const material = new MeshLambertMaterial({ vertexColors: true });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      uVatPos: { value: baked.positions },
      uVatNrm: { value: baked.normals },
      uTime: time,
      uVerts: { value: baked.vertices },
      uFrames: { value: FRAMES },
      uFps: { value: baked.fps },
      uWidth: { value: TEXTURE_WIDTH },
      uSpeed: { value: WALK_MPS },
      uHalf: { value: HALF_WALK_M },
    });
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D uVatPos;
uniform sampler2D uVatNrm;
uniform float uTime;
uniform int uVerts;
uniform int uFrames;
uniform float uFps;
uniform int uWidth;
uniform float uSpeed;
uniform float uHalf;
attribute float aVid;
// x, z (metres), heading (radians), phase (0–1)
attribute vec4 aInst;`,
      )
      .replace(
        '#include <beginnormal_vertex>',
        `float vatTime = uTime * uFps + aInst.w * float(uFrames);
int vatIndex = int(mod(vatTime, float(uFrames))) * uVerts + int(aVid);
ivec2 vatCoord = ivec2(vatIndex % uWidth, vatIndex / uWidth);
float vatC = cos(aInst.z);
float vatS = sin(aInst.z);
mat3 vatRot = mat3(vatC, 0.0, -vatS, 0.0, 1.0, 0.0, vatS, 0.0, vatC);
vec3 objectNormal = vatRot * texelFetch(uVatNrm, vatCoord, 0).xyz;`,
      )
      .replace(
        '#include <begin_vertex>',
        `float walk = 2.0 * uHalf;
float along = mod(uTime * uSpeed + aInst.w * walk, walk) - uHalf;
vec3 transformed = vatRot * texelFetch(uVatPos, vatCoord, 0).xyz
  + vec3(aInst.x + vatS * along, 0.0, aInst.y + vatC * along);`,
      );
  };
  material.customProgramCacheKey = () => 'webgl-crowd-vat';
  const crowd = new Mesh(geometry, material);
  // Robots walk anywhere in the square and animate in the shader: no bounds to cull against.
  crowd.frustumCulled = false;
  scene.add(crowd);

  const setCount = (count: number) => {
    const n = Math.max(0, Math.min(MAX_ROBOTS, Math.round(count)));
    // About one robot per 6 m² of a square, at least 60 m across.
    const side = Math.max(60, Math.sqrt(n * 6));
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    for (let i = 0; i < n; i++) {
      instances[i * 4] = (random() - 0.5) * side;
      instances[i * 4 + 1] = (random() - 0.5) * side;
      instances[i * 4 + 2] = random() * Math.PI * 2;
      instances[i * 4 + 3] = random();
    }
    inst.needsUpdate = true;
    geometry.instanceCount = n;
  };
  setCount(5_000);

  const resize = () => {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  const start = performance.now();
  let windowStart = start;
  let frames = 0;
  let frameMsSum = 0;
  let last = start;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    time.value = (now - start) / 1000;
    if (!renderer.xr.isPresenting) controls.update();
    renderer.render(scene, camera);
    frames++;
    frameMsSum += now - last;
    last = now;
    if (now - windowStart >= 1000) {
      onStats({
        fps: (frames * 1000) / (now - windowStart),
        frameMs: frameMsSum / frames,
        drawCalls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      });
      windowStart = now;
      frames = 0;
      frameMsSum = 0;
    }
  });

  const gl = renderer.getContext();
  const debug = gl.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(
    debug === null ? gl.getParameter(gl.RENDERER) : gl.getParameter(debug.UNMASKED_RENDERER_WEBGL),
  );
  const vr =
    'xr' in navigator &&
    (await navigator.xr?.isSessionSupported('immersive-vr').catch(() => false)) === true;

  return {
    info: {
      gpu,
      maxTextureSize: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)),
      vertices: baked.vertices,
      triangles: baked.triangles,
      frames: FRAMES,
      vr,
    },
    vrButton: VRButton.createButton(renderer),
    setCount,
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      geometry.dispose();
      baked.geometry.dispose();
      baked.positions.dispose();
      baked.normals.dispose();
      material.dispose();
      ground.geometry.dispose();
      (ground.material as Material).dispose();
      renderer.dispose();
    },
  };
}

/**
 * Loads the robot, simplifies each part (meshoptimizer, about TARGET_TRIANGLES in all, each part
 * keeping its share) and keeps only the vertices the simplified triangles use, merges the parts
 * into one geometry with the material colours as vertex colours, and bakes FRAMES poses of the
 * walk cycle: world positions and normals per vertex, scaled to HEIGHT_M with the feet on y = 0.
 */
async function bakeRobot(): Promise<Baked> {
  const gltf = await new GLTFLoader().loadAsync(MODEL_URL);
  const root = gltf.scene;
  const clip = gltf.animations.find((a) => a.name === CLIP);
  if (clip === undefined) throw new Error(`${MODEL_URL} has no "${CLIP}" clip`);

  const meshes: Mesh[] = [];
  root.traverse((object) => {
    if (object instanceof Mesh) meshes.push(object as Mesh);
  });
  const triangleCount = (g: BufferGeometry) =>
    (g.index?.count ?? g.getAttribute('position').count) / 3;
  const total = meshes.reduce((sum, mesh) => sum + triangleCount(mesh.geometry), 0);
  // Per part: the simplified triangle list, and the source vertices it uses (in order).
  const parts: { mesh: Mesh; used: number[]; index: number[] }[] = [];
  for (const mesh of meshes) {
    const share = triangleCount(mesh.geometry) / Math.max(1, total);
    const simplified = await simplifyGeometry(mesh.geometry, Math.max(4, TARGET_TRIANGLES * share));
    const source = simplified.geometry.index;
    const remap = new Map<number, number>();
    const used: number[] = [];
    const local: number[] = [];
    const n = source?.count ?? simplified.geometry.getAttribute('position').count;
    for (let k = 0; k < n; k++) {
      const v = source === null ? k : source.getX(k);
      let to = remap.get(v);
      if (to === undefined) {
        to = used.length;
        remap.set(v, to);
        used.push(v);
      }
      local.push(to);
    }
    parts.push({ mesh, used, index: local });
  }
  const vertices = parts.reduce((sum, part) => sum + part.used.length, 0);
  const indices = parts.reduce((sum, part) => sum + part.index.length, 0);

  // Merged topology and colours (pose-independent).
  const index = new Uint32Array(indices);
  const colours = new Float32Array(vertices * 3);
  const vid = new Float32Array(vertices);
  {
    let v0 = 0;
    let i0 = 0;
    const colour = new Color();
    for (const part of parts) {
      const material = (
        Array.isArray(part.mesh.material) ? part.mesh.material[0] : part.mesh.material
      ) as (Material & { color?: Color }) | undefined;
      colour.copy(material?.color ?? new Color(0xcccccc));
      for (let v = 0; v < part.used.length; v++) colour.toArray(colours, (v0 + v) * 3);
      for (let k = 0; k < part.index.length; k++) index[i0 + k] = v0 + (part.index[k] ?? 0);
      i0 += part.index.length;
      v0 += part.used.length;
    }
    for (let v = 0; v < vertices; v++) vid[v] = v;
  }

  // Poses: every vertex in world space, frame by frame.
  const mixer = new AnimationMixer(root);
  mixer.clipAction(clip).play();
  const poses: Float32Array[] = [];
  const p = new Vector3();
  for (let f = 0; f < FRAMES; f++) {
    mixer.setTime((f / FRAMES) * clip.duration);
    root.updateMatrixWorld(true);
    const pose = new Float32Array(vertices * 3);
    let v0 = 0;
    for (const part of parts) {
      for (let v = 0; v < part.used.length; v++) {
        part.mesh.getVertexPosition(part.used[v] ?? 0, p);
        // getVertexPosition skins a SkinnedMesh into its own space; both kinds then go to world.
        p.applyMatrix4(part.mesh.matrixWorld);
        p.toArray(pose, (v0 + v) * 3);
      }
      v0 += part.used.length;
    }
    poses.push(pose);
  }

  // Scale to HEIGHT_M, feet on the ground, centred over the origin (from the first pose).
  const box = new Box3().setFromArray(poses[0] ?? new Float32Array(3));
  const scale = HEIGHT_M / Math.max(1e-6, box.max.y - box.min.y);
  const cx = (box.min.x + box.max.x) / 2;
  const cz = (box.min.z + box.max.z) / 2;

  const rows = Math.ceil((vertices * FRAMES) / TEXTURE_WIDTH);
  const posData = new Float32Array(TEXTURE_WIDTH * rows * 4);
  const nrmData = new Float32Array(TEXTURE_WIDTH * rows * 4);
  const work = new BufferGeometry();
  work.setIndex(new BufferAttribute(index, 1));
  poses.forEach((pose, f) => {
    for (let v = 0; v < vertices; v++) {
      pose[v * 3] = (pose[v * 3] - cx) * scale;
      pose[v * 3 + 1] = (pose[v * 3 + 1] - box.min.y) * scale;
      pose[v * 3 + 2] = (pose[v * 3 + 2] - cz) * scale;
    }
    work.setAttribute('position', new BufferAttribute(pose, 3));
    work.computeVertexNormals();
    const normals = work.getAttribute('normal').array as Float32Array;
    const base = f * vertices * 4;
    for (let v = 0; v < vertices; v++) {
      for (let k = 0; k < 3; k++) {
        posData[base + v * 4 + k] = pose[v * 3 + k];
        nrmData[base + v * 4 + k] = normals[v * 3 + k];
      }
    }
  });
  work.dispose();

  const texture = (data: Float32Array) => {
    const t = new DataTexture(data, TEXTURE_WIDTH, rows, RGBAFormat, FloatType);
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };

  // Bind-pose attributes (the shader replaces them; kept so the geometry is complete).
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.setAttribute(
    'position',
    new BufferAttribute(poses[0]?.slice() ?? new Float32Array(0), 3),
  );
  geometry.setAttribute(
    'normal',
    new BufferAttribute(
      nrmData.filter((_, i) => i < vertices * 4 && i % 4 !== 3),
      3,
    ),
  );
  geometry.setAttribute('color', new BufferAttribute(colours, 3));
  geometry.setAttribute('aVid', new BufferAttribute(vid, 1));

  return {
    geometry,
    positions: texture(posData),
    normals: texture(nrmData),
    vertices,
    triangles: indices / 3,
    fps: FRAMES / clip.duration,
  };
}
