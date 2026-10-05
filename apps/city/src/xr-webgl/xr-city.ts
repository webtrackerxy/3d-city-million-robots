import {
  BufferGeometry,
  Color,
  DataTexture,
  DirectionalLight,
  Float32BufferAttribute,
  FloatType,
  FrontSide,
  Group,
  HemisphereLight,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
  MeshStandardMaterial,
  NearestFilter,
  PerspectiveCamera,
  PlaneGeometry,
  RGBAFormat,
  Scene,
  type Texture,
  type Vector3,
  WebGLRenderer,
} from 'three';
import type { AgentPose, CrowdLayer } from '../crowd/crowd-layer.ts';
import type { CityView } from '../scene/city-view.ts';
import { GROUND_DEPTH_CELL_M, groundDepthHeights } from '../scene/ground-depth.ts';
import { loadVehicle } from '../traffic/load-vehicle.ts';
import { createXrControls } from './xr-controls.ts';
import type { TrafficLayer } from '../traffic/traffic-layer.ts';

/**
 * Map XR on WebGL: for headset browsers that offer WebXR only with WebGL (the Quest Browser has
 * no WebXR–WebGPU binding). The simulation is the one already running; this draws a lighter city
 * around the viewer with WebGL 2: the buildings near the place, the ground (with its terrain),
 * the nearest people and robots (one instanced draw per model part, skinned in the vertex shader
 * from the same baked bone matrices the WebGPU crowd uses) and the nearest cars.
 */
export interface XrCityOptions {
  view: CityView;
  crowd: CrowdLayer | null;
  traffic: TrafficLayer | null;
  /** The region graph's nodes, for the ground's heights (regions built with terrain). */
  nodes: { x: Float32Array; y: Float32Array; z: Float32Array; level: Int8Array } | null;
  /** People and robots drawn at once (the nearest), and cars. */
  maxPeople: number;
  maxCars: number;
  /**
   * Desktop check: draw the same scene on a page overlay from eye height instead of a headset
   * (`?xrPreview=1`); Escape closes it.
   */
  preview?: boolean;
}

/** Buildings within this distance of the place are drawn. */
const BUILDING_RADIUS_M = 700;
interface Tier {
  /** At most this many (nearest first, counted per kind)… */
  count: number;
  /** …within this distance get this LOD. */
  withinM: number;
  lod: number;
}
/**
 * Levels of detail by nearness, per kind. Humans: 10k / 4k / 1k triangles. The robot's LODs are
 * 120k / 50k / 7.8k / 3k / 0.7k, and its LOD2 (from the simplifier's sloppy pass, the robot being
 * many separate parts) looks rough up close, so the nearest few get its LOD1. Together under about
 * 1M triangles for 300 people, inside a Quest 2's budget at 72 fps.
 */
const HUMAN_TIERS: readonly Tier[] = [
  { count: 16, withinM: 12, lod: 1 },
  { count: 64, withinM: 40, lod: 2 },
  { count: Infinity, withinM: Infinity, lod: 3 },
];
const ROBOT_TIERS: readonly Tier[] = [
  { count: 4, withinM: 10, lod: 1 },
  { count: 24, withinM: 25, lod: 2 },
  { count: 60, withinM: 60, lod: 3 },
  { count: Infinity, withinM: Infinity, lod: 4 },
];
/** The ground and buildings are refreshed round the viewer after a walk this long. */
const AREA_STEP_M = 250;
/** The visible ground sits this far above the depth grid (0.3 m under each cell's lowest node). */
const GROUND_LIFT_M = 0.25;
/** Agents and cars are looked for within these distances. */
const PEOPLE_RADIUS_M = 150;
const CAR_RADIUS_M = 250;
/** The nearest set is refreshed this often (poses update every frame). */
const REFRESH_MS = 500;
const SKY = 0x9fb7cc;

/**
 * Enters an immersive-vr session drawn with WebGL, standing in the street at the view's focus;
 * resolves once the session has started, with a promise that settles when it ends. Call it from
 * the click that asked for XR (the browser needs that user gesture).
 */
export async function enterXrCity(options: XrCityOptions): Promise<{ ended: Promise<void> }> {
  const preview = options.preview === true;
  if (!preview && navigator.xr === undefined) throw new Error('This browser has no WebXR.');
  // The session first, while the click still counts as a user gesture; the scene fills in after.
  const session = preview
    ? null
    : await navigator.xr?.requestSession('immersive-vr', { optionalFeatures: ['local-floor'] });
  const canvas = document.createElement('canvas');
  if (preview) {
    canvas.className = 'xr-preview';
    document.body.append(canvas);
  }
  const renderer = new WebGLRenderer({ canvas, antialias: true });
  if (preview) {
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.setSize(innerWidth, innerHeight, false);
  }
  renderer.xr.enabled = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  // Some foveation saves fill on the Quest; at 1 the edges of the view went visibly soft.
  renderer.xr.setFoveation(0.5);

  const { view, crowd, traffic } = options;
  const focus = view.focusPoint();
  // The terrain's 8 m grid (regions built with terrain), for the ground and the viewer's height.
  const grid = options.nodes === null ? null : groundDepthHeights(options.nodes);
  const flat = view.streetGround()?.(focus.x, -focus.z) ?? 0;
  const groundAt = (x: number, z: number) => (grid === null ? flat : sampleGround(grid, x, -z));
  const ground = groundAt(focus.x, focus.z);

  const scene = new Scene();
  scene.background = new Color(SKY);
  scene.add(new HemisphereLight(0xdfe8ff, 0x3a3f46, 1.6));
  const sun = new DirectionalLight(0xffffff, 2.2);
  sun.position.set(-600, 900, 400);
  scene.add(sun);
  const camera = new PerspectiveCamera(70, 1, 0.05, 3000);
  const rig = new Group();
  rig.position.set(focus.x, ground, focus.z);
  rig.add(camera);
  if (preview) {
    // A standing viewer's eyes, looking along the street a little downwards.
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    camera.position.set(0, 1.6, 0);
    camera.rotation.set(-0.08, 0.6, 0);
  }
  scene.add(rig);

  const disposers: (() => void)[] = [];
  // Ground and buildings round where the viewer is, refreshed after a walk of AREA_STEP_M.
  let groundPatch = groundMesh(grid, focus, flat);
  scene.add(groundPatch);
  disposers.push(() => {
    groundPatch.geometry.dispose();
    (groundPatch.material as Material).dispose();
  });
  const buildings = createBuildings(scene, view, disposers);
  buildings.add(focus);
  const areaCentre = focus.clone();
  const refreshArea = () => {
    if (Math.hypot(rig.position.x - areaCentre.x, rig.position.z - areaCentre.z) < AREA_STEP_M)
      return;
    areaCentre.copy(rig.position);
    scene.remove(groundPatch);
    groundPatch.geometry.dispose();
    (groundPatch.material as Material).dispose();
    groundPatch = groundMesh(grid, areaCentre, flat);
    scene.add(groundPatch);
    buildings.add(areaCentre);
  };
  const people = crowd === null ? null : createPeople(scene, crowd, options, disposers);
  const cars = traffic === null ? null : await createCars(scene, traffic, options, disposers);

  let exit: () => void = () => {
    // Set once the session (or the preview) is up.
  };
  const controls = createXrControls({
    renderer,
    rig,
    camera,
    groundAt,
    onExit: () => {
      exit();
    },
    preview,
  });
  disposers.push(() => {
    controls.dispose();
  });

  view.setSuspended(true);
  let previous = performance.now();
  let lastRefresh = -Infinity;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = now - previous;
    previous = now;
    controls.update(dt);
    refreshArea();
    crowd?.advance(dt, rig.position);
    const refresh = now - lastRefresh > REFRESH_MS;
    if (refresh) lastRefresh = now;
    people?.update(rig.position, refresh);
    cars?.update(rig.position, refresh);
    renderer.render(scene, camera);
  });
  if (session !== null && session !== undefined) await renderer.xr.setSession(session);

  const ended = new Promise<void>((resolve) => {
    const finish = () => {
      renderer.setAnimationLoop(null);
      for (const dispose of disposers) dispose();
      renderer.dispose();
      canvas.remove();
      view.setSuspended(false);
      resolve();
    };
    if (session !== null && session !== undefined) {
      session.addEventListener('end', finish);
      exit = () => {
        void session.end();
      };
    } else {
      const onKey = (e: KeyboardEvent) => {
        if (e.key !== 'Escape') return;
        removeEventListener('keydown', onKey);
        finish();
      };
      addEventListener('keydown', onKey);
      exit = () => {
        removeEventListener('keydown', onKey);
        finish();
      };
    }
  });
  return { ended };
}

type GroundGrid = NonNullable<ReturnType<typeof groundDepthHeights>>;

/** The visible ground's height at region (x, y): the depth grid, bilinear, raised to sit on it. */
function sampleGround(grid: GroundGrid, x: number, y: number): number {
  const cell = GROUND_DEPTH_CELL_M;
  const gx = Math.min(grid.width - 1.001, Math.max(0, (x - grid.minX) / cell - 0.5));
  const gy = Math.min(grid.height - 1.001, Math.max(0, (y - grid.minY) / cell - 0.5));
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const at = (cx: number, cy: number) => grid.heights[cy * grid.width + cx] ?? 0;
  const top = at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx;
  const bottom = at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx;
  return top * (1 - fy) + bottom * fy + GROUND_LIFT_M;
}

/** The ground round `centre`: the terrain's 8 m grid where the region has one, else flat. */
function groundMesh(grid: GroundGrid | null, centre: Vector3, flatY: number): Mesh {
  const material = new MeshLambertMaterial({ color: 0x8a8f96 });
  let geometry: BufferGeometry;
  if (grid === null) {
    geometry = new PlaneGeometry(4000, 4000);
    geometry.rotateX(-Math.PI / 2);
    geometry.translate(centre.x, flatY - 0.02, centre.z);
  } else {
    const cell = GROUND_DEPTH_CELL_M;
    const half = Math.ceil(BUILDING_RADIUS_M / cell);
    const cx = Math.floor((centre.x - grid.minX) / cell);
    const cy = Math.floor((-centre.z - grid.minY) / cell);
    const x0 = Math.max(0, cx - half);
    const x1 = Math.min(grid.width - 1, cx + half);
    const y0 = Math.max(0, cy - half);
    const y1 = Math.min(grid.height - 1, cy + half);
    const w = x1 - x0 + 1;
    const positions: number[] = [];
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++)
        // The depth grid sits 0.3 m under the lowest node; the visible ground sits on it.
        positions.push(
          grid.minX + (x + 0.5) * cell,
          (grid.heights[y * grid.width + x] ?? flatY) + GROUND_LIFT_M,
          -(grid.minY + (y + 0.5) * cell),
        );
    const index: number[] = [];
    for (let y = 0; y + 1 <= y1 - y0; y++)
      for (let x = 0; x + 1 < w; x++) {
        const a = y * w + x;
        // Rows run north (−z): this winding faces up.
        index.push(a, a + 1, a + w, a + 1, a + w + 1, a + w);
      }
    geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setIndex(index);
    geometry.computeVertexNormals();
  }
  return new Mesh(geometry, material);
}

/** The city's own building meshes round the viewer (the same geometry, drawn by WebGL). */
function createBuildings(scene: Scene, view: CityView, disposers: (() => void)[]) {
  const material = new MeshLambertMaterial({ vertexColors: true });
  const added = new Set<string>();
  disposers.push(() => {
    material.dispose();
  });
  return {
    /** Adds the tiles within BUILDING_RADIUS_M of `centre` not added yet. */
    add(centre: Vector3) {
      for (const tile of view.buildingTiles()) {
        const key = `${tile.x},${tile.z}`;
        if (added.has(key)) continue;
        if (Math.hypot(tile.x + 128 - centre.x, tile.z - 128 - centre.z) > BUILDING_RADIUS_M)
          continue;
        added.add(key);
        const mesh = new Mesh(tile.geometry, material);
        mesh.position.set(tile.x, 0, tile.z);
        scene.add(mesh);
      }
    },
  };
}

const SKIN_HEADER = /* glsl */ `
uniform highp sampler2D uBones;
attribute vec4 aPose;
attribute vec3 aFrame;
// Integer joints (as the WebGPU crowd binds them), so an integer input.
attribute uvec4 skinIndex;
attribute vec4 skinWeight;
vec4 boneRow(int bone, int row) {
  return mix(
    texelFetch(uBones, ivec2(bone * 3 + row, int(aFrame.x)), 0),
    texelFetch(uBones, ivec2(bone * 3 + row, int(aFrame.y)), 0),
    aFrame.z
  );
}
`;
// Linear blend skinning with the two baked frames blended, as the WebGPU crowd does.
const SKIN_ROWS = /* glsl */ `
vec4 r0 = vec4(0.0);
vec4 r1 = vec4(0.0);
vec4 r2 = vec4(0.0);
for (int k = 0; k < 4; k++) {
  float w = skinWeight[k];
  if (w <= 0.0) continue;
  int b = int(skinIndex[k]);
  r0 += boneRow(b, 0) * w;
  r1 += boneRow(b, 1) * w;
  r2 += boneRow(b, 2) * w;
}
float yawC = cos(aPose.w);
float yawS = sin(aPose.w);
vec3 skinnedN = vec3(dot(r0.xyz, normal), dot(r1.xyz, normal), dot(r2.xyz, normal));
vec3 objectNormal = normalize(vec3(yawC * skinnedN.x + yawS * skinnedN.z, skinnedN.y, -yawS * skinnedN.x + yawC * skinnedN.z));
#ifdef USE_TANGENT
vec3 objectTangent = vec3(tangent.xyz);
#endif
`;
const SKIN_POSITION = /* glsl */ `
vec4 bind = vec4(position, 1.0);
vec3 local = vec3(dot(r0, bind), dot(r1, bind), dot(r2, bind));
vec3 transformed = vec3(yawC * local.x + yawS * local.z, local.y, -yawS * local.x + yawC * local.z) + aPose.xyz;
`;

interface PeopleGroup {
  update(at: Vector3, refresh: boolean): void;
}

/** One instanced draw per (model, part) at a light LOD, posed every frame from the simulation. */
function createPeople(
  scene: Scene,
  crowd: CrowdLayer,
  options: XrCityOptions,
  disposers: (() => void)[],
): PeopleGroup {
  const families = crowd.families();
  const capacity = options.maxPeople;
  // Per family: the baked bones, and one material per model part (shared by the tiers).
  const groups = families.map((family, f) => {
    const baked = family.baked.baked;
    const frames = baked.matrices.length / (baked.boneCount * 12);
    const bones = new DataTexture(
      baked.matrices,
      baked.boneCount * 3,
      frames,
      RGBAFormat,
      FloatType,
    );
    bones.minFilter = NearestFilter;
    bones.magFilter = NearestFilter;
    bones.needsUpdate = true;
    const robot = f === families.length - 1;
    const chain = family.lodChain;
    const parts = family.source.meshes.length;
    const materials = Array.from({ length: parts }, (_, sub) => {
      const original = family.source.meshes[sub]?.material as Material | Material[] | undefined;
      const first = (Array.isArray(original) ? original[0] : original) as
        (Material & { map?: Texture | null; color?: Color }) | undefined;
      const material = new MeshLambertMaterial({
        map: first?.map ?? null,
        color: first?.color?.clone() ?? new Color(0xffffff),
        side: FrontSide,
        alphaTest: first?.alphaTest ?? 0,
      });
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uBones = { value: bones };
        shader.vertexShader = SKIN_HEADER + shader.vertexShader;
        shader.vertexShader = shader.vertexShader
          .replace('#include <beginnormal_vertex>', SKIN_ROWS)
          .replace('#include <begin_vertex>', SKIN_POSITION);
      };
      material.customProgramCacheKey = () => `xr-crowd-${f}`;
      return material;
    });
    // One instanced draw per (tier, part): nearer tiers use finer LODs.
    const kindTiers = robot ? ROBOT_TIERS : HUMAN_TIERS;
    const tiers = kindTiers.map((tier) => {
      const lod = tier.lod;
      const level = chain?.geometries[Math.min(lod, chain.geometries.length - 1)] ?? [];
      const pose = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      const frame = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
      const meshes = level.map((source, sub) => {
        const geometry = new InstancedBufferGeometry();
        for (const name of ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'])
          if (source.hasAttribute(name)) geometry.setAttribute(name, source.getAttribute(name));
        geometry.setIndex(source.index);
        geometry.setAttribute('aPose', pose);
        geometry.setAttribute('aFrame', frame);
        geometry.instanceCount = 0;
        const mesh = new Mesh(geometry, materials[sub] ?? materials[0]);
        mesh.frustumCulled = false;
        scene.add(mesh);
        return { mesh, geometry };
      });
      return { pose, frame, meshes, count: 0, spec: tier };
    });
    disposers.push(() => {
      bones.dispose();
      for (const tier of tiers)
        for (const m of tier.meshes) {
          scene.remove(m.mesh);
          m.geometry.dispose();
        }
      for (const material of materials) material.dispose();
    });
    return tiers;
  });

  let nearest: number[] = [];
  const out: AgentPose = { x: 0, y: 0, z: 0, yaw: 0, family: 0, frame0: 0, frame1: 0, alpha: 0 };
  return {
    update(at, refresh) {
      if (refresh) {
        // The nearest agents to the viewer, within the radius.
        const found: [number, number][] = [];
        const r2 = PEOPLE_RADIUS_M * PEOPLE_RADIUS_M;
        for (let agent = 0; agent < crowd.agents; agent++) {
          if (!crowd.agentPose(agent, out)) continue;
          const dx = out.x - at.x;
          const dz = out.z - at.z;
          const d2 = dx * dx + dz * dz;
          if (d2 < r2) found.push([d2, agent]);
        }
        found.sort((a, b) => a[0] - b[0]);
        nearest = found.slice(0, capacity).map(([, agent]) => agent);
      }
      for (const tiers of groups) for (const tier of tiers) tier.count = 0;
      // Nearest first, ranked per kind (humans together, robots apart): the first tier's count
      // within its distance get the finest LOD, and so on.
      let humanRank = 0;
      let robotRank = 0;
      const robotFamily = groups.length - 1;
      for (const agent of nearest) {
        if (!crowd.agentPose(agent, out)) continue;
        if (out.family >= groups.length) continue;
        const distance = Math.hypot(out.x - at.x, out.z - at.z);
        // agentPose's family is within `families`, so `groups` has it.
        const tiers = groups[out.family];
        const robot = out.family === robotFamily;
        const rank = robot ? robotRank++ : humanRank++;
        let t = 0;
        let before = 0;
        while (
          t < tiers.length - 1 &&
          (rank >= before + tiers[t].spec.count || distance > tiers[t].spec.withinM)
        ) {
          before += tiers[t].spec.count;
          t++;
        }
        const tier = tiers[t];
        if (tier.count >= capacity) continue;
        tier.pose.setXYZW(tier.count, out.x, out.y, out.z, out.yaw);
        tier.frame.setXYZ(tier.count, out.frame0, out.frame1, out.alpha);
        tier.count++;
      }
      for (const tiers of groups)
        for (const tier of tiers) {
          tier.pose.needsUpdate = true;
          tier.frame.needsUpdate = true;
          for (const m of tier.meshes) m.geometry.instanceCount = tier.count;
        }
    },
  };
}

interface CarGroup {
  update(at: Vector3, refresh: boolean): void;
}

/** The nearest cars, as the Porsche's lightest LOD, one instanced mesh per material part. */
async function createCars(
  scene: Scene,
  traffic: TrafficLayer,
  options: XrCityOptions,
  disposers: (() => void)[],
): Promise<CarGroup> {
  const vehicle = await loadVehicle('/vehicles/porsche');
  const parts = vehicle.lods[vehicle.lods.length - 1] ?? [];
  const capacity = options.maxCars;
  const meshes = parts.map((part) => {
    const source = part.source as Material & { color?: Color; map?: Texture | null };
    const material = new MeshStandardMaterial({
      color: source.color?.clone() ?? new Color(0xcccccc),
      map: source.map ?? null,
      roughness: 0.5,
      metalness: part.material === 'paint' ? 0.4 : 0.1,
    });
    const mesh = new InstancedMesh(part.geometry, material, capacity);
    mesh.count = 0;
    mesh.frustumCulled = false;
    scene.add(mesh);
    return { mesh, material, paint: part.material === 'paint' };
  });
  disposers.push(() => {
    for (const m of meshes) {
      scene.remove(m.mesh);
      m.mesh.dispose();
      m.material.dispose();
    }
  });
  let nearest: number[] = [];
  const pose = { x: 0, y: 0, z: 0, yaw: 0 };
  const matrix = new Matrix4();
  const colour = new Color();
  return {
    update(at, refresh) {
      if (refresh) nearest = traffic.carsNear(at.x, at.z, CAR_RADIUS_M, capacity);
      let n = 0;
      for (const car of nearest) {
        if (!traffic.carPose(car, pose)) continue;
        matrix.makeRotationY(pose.yaw).setPosition(pose.x, pose.y, pose.z);
        const [r, g, b] = traffic.carPaint(car);
        for (const m of meshes) {
          m.mesh.setMatrixAt(n, matrix);
          if (m.paint) m.mesh.setColorAt(n, colour.setRGB(r, g, b));
        }
        n++;
      }
      for (const m of meshes) {
        m.mesh.count = n;
        m.mesh.instanceMatrix.needsUpdate = true;
        if (m.mesh.instanceColor !== null) m.mesh.instanceColor.needsUpdate = true;
      }
    },
  };
}

/** True when the browser can put the WebGPU city in a headset; else Map XR uses this WebGL view. */
export function hasWebgpuXr(): boolean {
  return 'XRGPUBinding' in window;
}
