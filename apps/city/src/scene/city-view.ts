import { NodeFlag, NodeType } from '@city/core-types';
import type { NavBuildings, NavTile } from '@city/formats';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  Group,
  HemisphereLight,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  type Quaternion,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { WebGPURenderer } from 'three/webgpu';
import { NEEDS_WEBGPU, PHONE } from '../device.ts';
import type { BaseMap } from '../map/base-map.ts';
import { buildingGeometry } from './buildings-geometry.ts';
import type { StreetGround } from './street-ground.ts';
import { type NetworkColouring, networkGeometry } from './network-geometry.ts';
import { ribbon } from './route-geometry.ts';

export interface Layers {
  buildings: boolean;
  /** 1 = solid; below 1 the city's buildings are see-through and stop hiding the crowd. */
  buildingOpacity: number;
  /** Names over named buildings (drawn by scene/building-labels.ts, not here). */
  labels: boolean;
  network: boolean;
  colouring: NetworkColouring;
  showOtherLevels: boolean;
  deadEnds: boolean;
  entrances: boolean;
}

export interface ViewStats {
  fps: number;
  buildingsDrawn: number;
  networkSegments: number;
  deadEnds: number;
}

/** Called every frame before the scene is drawn (the crowd dispatches its passes here). */
export type FrameHook = (
  camera: PerspectiveCamera,
  drawingBufferHeight: number,
  dtMs: number,
  focus: Vector3,
) => void;

export interface CityView {
  readonly renderer: WebGPURenderer;
  readonly scene: Scene;
  /** Runs `hook` every frame before the scene is drawn; returns its removal. */
  addFrameHook(hook: FrameHook): () => void;
  /** Recent frame intervals in ms (newest last), for measurement. */
  frameTimes(): number[];
  /** Recent GPU frame times in ms (render + compute timestamps; empty without timestamp-query). */
  gpuTimes(): number[];
  setLayers(layers: Layers): void;
  /**
   * Over a flat base map: lowers the whole city by `metres` (the ground at the focus), so its
   * terrain meets the map there. 0 keeps true heights (the photorealistic tiles have terrain).
   */
  setGroundOffset(metres: number): void;
  /**
   * Adds one streamed tile's buildings (tile-local coordinates, tile corner at ox, oy in the
   * region frame). Returns the main-thread milliseconds it took.
   */
  addTileBuildings(buildings: NavBuildings, ox: number, oy: number, firstBuilding: number): number;
  /** Drops the buildings added for the tile at (ox, oy) (streaming: the camera moved away). */
  removeTileBuildings(ox: number, oy: number): void;
  /** Keeps the orbit target on this point (e.g. a followed agent) every frame; null releases. */
  setFollowTarget(target: (() => Vector3 | null) | null): void;
  /** The stitched region graph: network lines, entrances, dead ends, picking. */
  setGraph(tile: NavTile): void;
  /**
   * Asked first on a click (normalised device coordinates and the camera): true if it took the
   * click (a person or car was picked), so no entrance is picked.
   */
  setClickPicker(
    picker: ((ndcX: number, ndcY: number, camera: PerspectiveCamera) => boolean) | null,
  ): void;
  /**
   * The street's height for wall feet on slopes (regions built with terrain); rebuilds the
   * buildings already added.
   */
  setStreetGround(ground: StreetGround): void;
  /**
   * Without a base map: looks at (x, y) from `height` metres up and `distance` metres south (a
   * place's view; with a base map the map flies instead).
   */
  lookAt(view: { x: number; y: number; height: number; distance: number }): void;
  /** The buildings' meshes drawn now (geometry and where it sits), for Map XR on WebGL. */
  buildingTiles(): { geometry: BufferGeometry; x: number; z: number }[];
  /** The street's height sampler, once the graph is in (regions built with terrain). */
  streetGround(): StreetGround | undefined;
  /** The point the view looks at (Three coordinates, ground level). */
  focusPoint(): Vector3;
  /** Stops drawing (and the frame hooks) while Map XR on WebGL has the headset. */
  setSuspended(suspended: boolean): void;
  /** Map XR: enters an immersive-vr session standing in the street at the focus. */
  enterXr(): Promise<void>;
  /** Called when the XR session ends (the headset was taken off or the session closed). */
  onXrEnded(handler: (() => void) | null): void;
  /** Route polyline (tile coordinates and height) with its end nodes; null clears it. */
  setRoute(
    points: [number, number, number][] | null,
    origin: number | null,
    destination: number | null,
  ): void;
  dispose(): void;
}

/** Layer of the static occluders (buildings) for Hi-Z. */
export const OCCLUDER_LAYER = 1;

/** Clicks select the entrance nearest the ground point, within this distance. */
const PICK_RADIUS_M = 40;

/**
 * Region viewer: extruded buildings (one mesh per streamed tile, so Three culls whole tiles), the
 * pedestrian network as coloured lines,
 * entrance and dead-end markers, a route ribbon, orbit camera. Tile frame (x east, y north, z up)
 * → Three (X = x, Y = z, Z = −y).
 *
 * With a base map the canvas is a transparent overlay on it: the map owns the camera and the
 * input, and each map frame draws the city with the map's view-projection.
 */
export async function startCityView(
  canvas: HTMLCanvasElement,
  /** Region size in metres (ground plane, camera range). */
  size: number,
  initial: Layers,
  onStats: (stats: ViewStats) => void,
  onPickEntrance: (node: number) => void,
  /**
   * Optional start view: looking at tile (x, y) from `height` metres up and `distance` metres
   * south (small distance = top-down).
   */
  at?: { x: number; y: number; height: number; distance: number },
  baseMap?: BaseMap,
  /** Map XR: the renderer is made XR-compatible and `enterXr` stands the viewer in the street. */
  xr = false,
): Promise<CityView> {
  // Two million agents need storage buffers past WebGPU's 128 MiB default (the crowd's visible
  // list is agents × buckets × 4 bytes): ask for what the adapter offers. A phone's lighter crowd
  // fits the defaults.
  const adapter = await navigator.gpu.requestAdapter();
  if (adapter === null) throw new Error(NEEDS_WEBGPU);
  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    trackTimestamp: true,
    alpha: true,
    ...(PHONE
      ? {}
      : {
          requiredLimits: {
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
            maxBufferSize: adapter.limits.maxBufferSize,
          },
        }),
  });
  // Before init: three asks for an XR-compatible adapter when XR is enabled.
  if (xr) renderer.xr.enabled = true;
  await renderer.init();
  renderer.setPixelRatio(PHONE ? 1 : Math.min(devicePixelRatio, 2));

  const scene = new Scene();
  if (baseMap === undefined) scene.background = new Color(0x9fb7cc);
  else renderer.setClearColor(0x000000, 0);
  scene.add(new HemisphereLight(0xdfe8ff, 0x3a3f46, 1.6));
  const sun = new DirectionalLight(0xffffff, 2.4);
  sun.position.set(-600, 900, 400);
  scene.add(sun);

  const ground = new Mesh(
    new PlaneGeometry(size * 1.4, size * 1.4),
    new MeshStandardMaterial({ color: 0x5b6470 }),
  );
  ground.rotation.x = -Math.PI / 2;
  if (baseMap === undefined) scene.add(ground);

  const buildings = new Group();
  const buildingMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
  /** Solid buildings occlude the crowd (Hi-Z); see-through ones do not. */
  let solidBuildings = true;
  scene.add(buildings);
  let buildingsDrawn = 0;
  interface TileMesh {
    buildings: NavBuildings;
    ox: number;
    oy: number;
    firstBuilding: number;
    mesh: Mesh;
    drawn: number;
  }
  const tileMeshes: TileMesh[] = [];
  let suspended = false;
  let streetGroundAt: StreetGround | undefined;
  const buildTileMesh = (tileBuildings: NavBuildings, ox: number, oy: number) => {
    const arrays = buildingGeometry(tileBuildings, streetGroundAt, ox, oy);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(arrays.positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(arrays.normals, 3));
    geometry.setAttribute('color', new BufferAttribute(arrays.colours, 3));
    geometry.setIndex(new BufferAttribute(arrays.indices, 1));
    geometry.computeBoundingSphere();
    const mesh = new Mesh(geometry, buildingMaterial);
    mesh.position.set(ox, 0, -oy);
    // Also on the occluder layer, which the crowd's Hi-Z depth pass renders.
    if (solidBuildings) mesh.layers.enable(OCCLUDER_LAYER);
    return { mesh, drawn: arrays.drawn };
  };
  const addTileBuildings = (
    tileBuildings: NavBuildings,
    ox: number,
    oy: number,
    firstBuilding: number,
  ): number => {
    const begin = performance.now();
    const { mesh, drawn } = buildTileMesh(tileBuildings, ox, oy);
    buildings.add(mesh);
    tileMeshes.push({ buildings: tileBuildings, ox, oy, firstBuilding, mesh, drawn });
    buildingsDrawn += drawn;
    return performance.now() - begin;
  };
  const removeTileBuildings = (ox: number, oy: number): void => {
    const index = tileMeshes.findIndex((t) => t.ox === ox && t.oy === oy);
    if (index < 0) return;
    const entry = tileMeshes[index];
    buildings.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    buildingsDrawn -= entry.drawn;
    tileMeshes.splice(index, 1);
  };

  let followTarget: (() => Vector3 | null) | null = null;
  const followDelta = new Vector3();
  let tile: NavTile | null = null;

  const lineMaterial = new LineBasicMaterial({ vertexColors: true });
  let network = new LineSegments(new BufferGeometry(), lineMaterial);
  scene.add(network);
  let networkSegments = 0;

  // Posts: dead ends (red, 4 m) and entrances (magenta, 7 m; synthetic ones paler).
  const posts = (points: number[], colours: number[] | null, colour: number) => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(points), 3));
    if (colours !== null)
      geometry.setAttribute('color', new BufferAttribute(new Float32Array(colours), 3));
    const mesh = new LineSegments(
      geometry,
      colours !== null
        ? new LineBasicMaterial({ vertexColors: true })
        : new LineBasicMaterial({ color: colour }),
    );
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  };
  let deadEnds = posts([], null, 0xff3030);
  let entrances = posts([], [], 0);
  let deadEndCount = 0;
  let entranceNodes: number[] = [];
  let layers = initial;

  // Route: a ribbon above the network (a new mesh per route), and pins at both ends.
  const routeMaterial = new MeshBasicMaterial({ color: 0xff8a1f });
  let routeMesh: Mesh | null = null;
  const pin = (colour: number) => {
    const mesh = new Mesh(
      new CylinderGeometry(1.5, 1.5, 40, 12),
      new MeshBasicMaterial({ color: colour }),
    );
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  };
  const originPin = pin(0x35d46a);
  const destinationPin = pin(0xff4040);
  const placePin = (mesh: Mesh, node: number | null) => {
    mesh.visible = node !== null;
    if (node !== null && tile !== null)
      mesh.position.set(tile.nodes.x[node], tile.nodes.z[node] + 20, -tile.nodes.y[node]);
  };

  // In XR people walk past within arm's reach: a near plane of 5 cm, not 50.
  const camera = new PerspectiveCamera(50, 1, xr ? 0.05 : 0.5, size * 6);
  /** In XR the camera is moved into this rig, which stands on the street at the focus. */
  const rig = new Group();
  camera.position.set(size * 0.35, size * 0.45, size * 0.75);
  // On the map the camera's matrices are set from the map's every frame.
  const controls = baseMap === undefined ? new OrbitControls(camera, canvas) : null;
  /** The point the view looks at (orbit target, or the map centre); ground level. */
  const focus = new Vector3();
  if (at !== undefined) {
    focus.set(at.x, 0, -at.y);
    camera.position.set(at.x, at.height, -at.y + Math.max(at.distance, at.height * 0.05));
  }
  if (controls !== null) {
    controls.target.copy(focus);
    controls.enableDamping = true;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.update();
  } else {
    camera.matrixAutoUpdate = false;
    camera.matrixWorldAutoUpdate = false;
    camera.coordinateSystem = renderer.coordinateSystem;
  }

  /** Selects the entrance nearest a ground point (tile frame), if one is close. */
  const pickAt = (x: number, y: number) => {
    let best = -1;
    let bestDistance = PICK_RADIUS_M;
    if (tile === null) return;
    for (const n of entranceNodes) {
      const d = Math.hypot(tile.nodes.x[n] - x, tile.nodes.y[n] - y);
      if (d < bestDistance) {
        bestDistance = d;
        best = n;
      }
    }
    if (best >= 0) onPickEntrance(best);
  };
  let saved: { position: Vector3; quaternion: Quaternion } | null = null;
  let onXrEnd: (() => void) | null = null;
  let clickPicker: ((ndcX: number, ndcY: number, camera: PerspectiveCamera) => boolean) | null =
    null;
  // Click (not drag) → a person or car under it, else ground point → nearest entrance.
  const raycaster = new Raycaster();
  const groundPlane = new Plane(new Vector3(0, 1, 0), 0);
  const hit = new Vector3();
  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    down = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    if (down === null || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    down = null;
    const rect = canvas.getBoundingClientRect();
    const ndc = new Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    if (clickPicker?.(ndc.x, ndc.y, camera) === true) return;
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(groundPlane, hit) === null) return;
    pickAt(hit.x, -hit.z);
  };
  if (baseMap === undefined) {
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);
  } else {
    baseMap.onClick((x, y, screen) => {
      const ndcX = (screen.x / Math.max(1, canvas.clientWidth)) * 2 - 1;
      const ndcY = 1 - (screen.y / Math.max(1, canvas.clientHeight)) * 2;
      if (clickPicker?.(ndcX, ndcY, camera) === true) return;
      pickAt(x, y);
    });
  }

  let networkKey = '';
  const setBuildingOpacity = (opacity: number): void => {
    buildingMaterial.opacity = opacity;
    const solid = opacity >= 1;
    if (solid === solidBuildings) return;
    solidBuildings = solid;
    buildingMaterial.transparent = !solid;
    buildingMaterial.depthWrite = solid;
    buildingMaterial.needsUpdate = true;
    for (const entry of tileMeshes) {
      if (solid) entry.mesh.layers.enable(OCCLUDER_LAYER);
      else entry.mesh.layers.disable(OCCLUDER_LAYER);
    }
  };
  const setLayers = (next: Layers): void => {
    layers = next;
    buildings.visible = layers.buildings;
    setBuildingOpacity(layers.buildingOpacity);
    // No graph yet (tiles still streaming): nothing to draw.
    network.visible = false;
    if (tile === null) return;
    deadEnds.visible = layers.deadEnds;
    entrances.visible = layers.entrances;
    // The line geometry is built only when shown, and only again when its look changes (a whole
    // city's network is millions of segments).
    const key = `${layers.colouring}|${layers.showOtherLevels}|${tile.nodes.x.length}`;
    if (!layers.network || key === networkKey) {
      network.visible = layers.network;
      return;
    }
    networkKey = key;
    const lines = networkGeometry(tile, {
      colouring: layers.colouring,
      showOtherLevels: layers.showOtherLevels,
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(lines.positions, 3));
    geometry.setAttribute('color', new BufferAttribute(lines.colours, 3));
    scene.remove(network);
    network.geometry.dispose();
    network = new LineSegments(geometry, lineMaterial);
    network.visible = layers.network;
    scene.add(network);
    networkSegments = lines.segments;
  };
  setLayers(initial);

  const setGraph = (graph: NavTile): void => {
    tile = graph;
    const deadEndPoints: number[] = [];
    const entrancePoints: number[] = [];
    const entranceColours: number[] = [];
    entranceNodes = [];
    for (let n = 0; n < graph.nodes.x.length; n++) {
      const x = graph.nodes.x[n];
      const y = graph.nodes.y[n];
      const z = graph.nodes.z[n];
      if (graph.nodes.type[n] === NodeType.End) deadEndPoints.push(x, z, -y, x, z + 4, -y);
      if (graph.nodes.type[n] === NodeType.Entrance) {
        entranceNodes.push(n);
        entrancePoints.push(x, z, -y, x, z + 7, -y);
        const c =
          (graph.nodes.flags[n] & NodeFlag.SyntheticEntrance) !== 0
            ? [0.75, 0.55, 0.8]
            : [1, 0.2, 0.9];
        entranceColours.push(...c, ...c);
      }
    }
    for (const old of [deadEnds, entrances]) {
      scene.remove(old);
      old.geometry.dispose();
    }
    deadEnds = posts(deadEndPoints, null, 0xff3030);
    entrances = posts(entrancePoints, entranceColours, 0);
    deadEndCount = deadEndPoints.length / 6;
    setLayers(layers);
  };

  const setRoute: CityView['setRoute'] = (points, origin, destination) => {
    if (routeMesh !== null) {
      scene.remove(routeMesh);
      routeMesh.geometry.dispose();
      routeMesh = null;
    }
    if (points !== null && points.length >= 2) {
      const strip = ribbon(points, 3, 0.8);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(strip.positions, 3));
      geometry.setIndex(new BufferAttribute(strip.indices, 1));
      routeMesh = new Mesh(geometry, routeMaterial);
      scene.add(routeMesh);
    }
    placePin(originPin, origin);
    placePin(destinationPin, destination);
  };

  let frames = 0;
  let last = performance.now();
  let width = 0;
  let height = 0;
  const hooks = new Set<FrameHook>();
  let previousFrame = performance.now();
  const intervals: number[] = [];
  const gpu: number[] = [];
  let resolving = false;
  // Resolved a few frames late; one resolve in flight at a time.
  const resolveGpuTime = () => {
    if (resolving || !renderer.hasFeature('timestamp-query')) return;
    resolving = true;
    void Promise.all([
      renderer.resolveTimestampsAsync('render'),
      renderer.resolveTimestampsAsync('compute'),
    ])
      .then(([render, compute]) => {
        const total = (render ?? 0) + (compute ?? 0);
        if (total > 0) {
          gpu.push(total);
          if (gpu.length > 600) gpu.shift();
        }
      })
      .finally(() => {
        resolving = false;
      });
  };
  const eyeTranslation = new Matrix4();
  let groundOffset = 0;
  const renderFrame = () => {
    if (suspended) return;
    const frameStart = performance.now();
    const dt = frameStart - previousFrame;
    previousFrame = frameStart;
    intervals.push(dt);
    if (intervals.length > 600) intervals.shift();
    if (canvas.clientWidth !== width || canvas.clientHeight !== height) {
      width = canvas.clientWidth;
      height = canvas.clientHeight;
      renderer.setSize(width, height, false);
      camera.aspect = width / Math.max(1, height);
      if (controls !== null) camera.updateProjectionMatrix();
    }
    if (followTarget !== null) {
      const target = followTarget();
      if (target !== null) {
        // Glide the view (orbit target and camera, or the map centre) towards the agent.
        followDelta
          .subVectors(target, focus)
          .setY(0)
          .multiplyScalar(Math.min(1, dt / 250));
        focus.add(followDelta);
        if (controls !== null) {
          controls.target.add(followDelta);
          camera.position.add(followDelta);
        } else baseMap?.setCentre(focus.x, -focus.z);
      }
    }
    const presenting = renderer.xr.isPresenting;
    if (controls !== null && !presenting) {
      controls.update();
      focus.copy(controls.target);
    }
    // In XR the crowd culls and picks levels of detail for the headset's view (both eyes).
    const viewCamera = presenting ? renderer.xr.getCamera() : camera;
    for (const hook of hooks) hook(viewCamera, renderer.domElement.height, dt, focus);
    renderer.render(scene, camera);
    resolveGpuTime();
    frames++;
    const now = performance.now();
    if (now - last >= 500) {
      onStats({
        fps: (frames * 1000) / (now - last),
        buildingsDrawn,
        networkSegments,
        deadEnds: deadEndCount,
      });
      frames = 0;
      last = now;
    }
  };
  if (baseMap === undefined) void renderer.setAnimationLoop(renderFrame);
  else
    baseMap.setDraw((mapCamera) => {
      canvas.style.visibility = mapCamera.visible ? 'visible' : 'hidden';
      if (!mapCamera.visible) return;
      // projection · view = the map's view-projection, with the view a pure translation to the
      // eye: camera.position and the frustum stay meaningful for the crowd's LOD and culling.
      // The ground offset raises the eye in the city only, which lowers the city under the map.
      const eye = mapCamera.eye;
      const eyeY = eye.y + groundOffset;
      camera.position.set(eye.x, eyeY, eye.z);
      camera.matrix.makeTranslation(eye.x, eyeY, eye.z);
      camera.matrixWorld.copy(camera.matrix);
      camera.matrixWorldInverse.makeTranslation(-eye.x, -eyeY, -eye.z);
      camera.projectionMatrix.multiplyMatrices(
        mapCamera.viewProjection,
        eyeTranslation.makeTranslation(eye.x, eye.y, eye.z),
      );
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
      camera.fov = mapCamera.fovDeg;
      const [cx, cy] = baseMap.centre();
      if (followTarget === null) focus.set(cx, 0, -cy);
      renderFrame();
    });

  return {
    renderer,
    scene,
    addFrameHook(hook) {
      hooks.add(hook);
      return () => {
        hooks.delete(hook);
      };
    },
    frameTimes: () => [...intervals],
    gpuTimes: () => [...gpu],
    setLayers,
    setClickPicker(picker) {
      clickPicker = picker;
    },
    setStreetGround(ground) {
      streetGroundAt = ground;
      for (const entry of tileMeshes) {
        buildings.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh = buildTileMesh(entry.buildings, entry.ox, entry.oy).mesh;
        buildings.add(entry.mesh);
      }
    },
    setGroundOffset(metres) {
      groundOffset = metres;
    },
    addTileBuildings,
    removeTileBuildings,
    setFollowTarget(target) {
      followTarget = target;
      const start = target?.() ?? null;
      if (start === null) return;
      if (controls === null) {
        focus.copy(start).setY(0);
        baseMap?.map.easeTo({
          center: baseMap.frame.toLngLat(start.x, -start.z),
          zoom: 18.5,
          pitch: 60,
        });
        return;
      }
      // Frame the followed agent from ~60 m out and 25 m above, on the camera's current side.
      const away = camera.position.clone().sub(controls.target).setY(0);
      if (away.lengthSq() < 1) away.set(0, 0, 1);
      away.setLength(60);
      controls.target.copy(start);
      camera.position
        .copy(start)
        .add(away)
        .add(new Vector3(0, 25, 0));
      controls.update();
    },
    setGraph,
    setRoute,
    buildingTiles: () =>
      tileMeshes.map((t) => ({
        geometry: t.mesh.geometry,
        x: t.mesh.position.x,
        z: t.mesh.position.z,
      })),
    streetGround: () => streetGroundAt,
    focusPoint: () => focus.clone(),
    setSuspended(next) {
      suspended = next;
    },
    lookAt(next) {
      if (controls === null) return;
      controls.target.set(next.x, 0, -next.y);
      focus.copy(controls.target);
      camera.position.set(
        next.x,
        next.height,
        -next.y + Math.max(next.distance, next.height * 0.05),
      );
      controls.update();
    },
    async enterXr() {
      if (!xr) throw new Error('This view was not started for XR.');
      if (navigator.xr === undefined) throw new Error('This browser has no WebXR.');
      const session = await navigator.xr.requestSession('immersive-vr', {
        requiredFeatures: ['webgpu'],
        optionalFeatures: ['local-floor'],
      });
      // Stand on the street at the focus, facing the way the view faced; the headset adds the
      // viewer's own height and movement (local-floor).
      const ground = streetGroundAt?.(focus.x, -focus.z) ?? 0;
      const away = camera.position.clone().sub(focus);
      saved = { position: camera.position.clone(), quaternion: camera.quaternion.clone() };
      rig.position.set(focus.x, ground, focus.z);
      rig.rotation.set(0, Math.atan2(away.x, away.z), 0);
      scene.add(rig);
      rig.add(camera);
      camera.position.set(0, 0, 0);
      camera.quaternion.identity();
      session.addEventListener('end', () => {
        rig.remove(camera);
        scene.remove(rig);
        if (saved !== null) {
          camera.position.copy(saved.position);
          camera.quaternion.copy(saved.quaternion);
        }
        saved = null;
        onXrEnd?.();
      });
      await renderer.xr.setSession(session);
    },
    onXrEnded(handler) {
      onXrEnd = handler;
    },
    dispose() {
      void renderer.setAnimationLoop(null);
      baseMap?.setDraw(null);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      controls?.dispose();
      for (const child of buildings.children) (child as Mesh).geometry.dispose();
      network.geometry.dispose();
      deadEnds.geometry.dispose();
      entrances.geometry.dispose();
      routeMesh?.geometry.dispose();
      void renderer.dispose();
    },
  };
}
