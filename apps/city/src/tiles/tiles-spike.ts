import { TilesRenderer } from '3d-tiles-renderer';
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  ReorientationPlugin,
  UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins';
import {
  Color,
  DirectionalLight,
  HemisphereLight,
  MathUtils,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { WebGPURenderer } from 'three/webgpu';

/** Cesium ion assets: Google Photorealistic 3D Tiles (through ion) and Cesium OSM Buildings. */
export const ION_ASSETS = { photorealistic: 2275207, osmBuildings: 96188 } as const;
export type TilesAsset = keyof typeof ION_ASSETS;

/** One Canada Square, Canary Wharf: the Docklands region's origin is about 60 m from here. */
const ORIGIN = { lat: 51.5049, lon: -0.0195 };

export interface TilesStats {
  fps: number;
  frameMs: number;
  triangles: number;
  drawCalls: number;
  /** Tiles downloading, parsing, visible, and failed loads (3d-tiles-renderer's counters). */
  downloading: number;
  parsing: number;
  visible: number;
  failed: number;
  /** Errors reported by the tiles renderer (load or parse), newest last. */
  errors: string[];
  tilesetLoaded: boolean;
  /** Geometry and textures the renderer holds (bytes, from renderer.info.memory where present). */
  gpuGeometries: number;
  gpuTextures: number;
}

export interface TilesSpike {
  setErrorTarget(target: number): void;
  /**
   * Ground height probe for Phase 1: casts rays down on a 3 × 3 grid (100 m apart) round the
   * origin and returns the lowest hit (metres above the WGS84 ellipsoid), or null if none hit.
   */
  probeGround(): number | null;
  dispose(): void;
}

/**
 * The 3D Tiles plan's Phase 0 spike (/tiles, internal): a Cesium ion tileset rendered by
 * 3d-tiles-renderer inside the city's WebGPURenderer, reoriented so Canary Wharf is at the origin
 * (+Y up, ellipsoid height 0 at y = 0). It answers: does it render under WebGPU, do the tiles
 * load under cross-origin isolation, and at what cost.
 */
export async function startTilesSpike(
  canvas: HTMLCanvasElement,
  options: { token: string; asset: TilesAsset; errorTarget: number },
  onStats: (stats: TilesStats) => void,
): Promise<TilesSpike> {
  const renderer = new WebGPURenderer({ canvas, antialias: true });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

  const scene = new Scene();
  scene.background = new Color(0x9fb7cc);
  scene.add(new HemisphereLight(0xffffff, 0x444444, 2));
  const sun = new DirectionalLight(0xffffff, 1.5);
  sun.position.set(-1, 2, 1);
  scene.add(sun);

  const camera = new PerspectiveCamera(50, 1, 1, 40_000);
  // The ellipsoid lies about 45 m below London's ground: look at ~50 m from 400 m up.
  camera.position.set(0, 450, 700);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 50, 0);
  controls.update();

  const errors: string[] = [];
  const tiles = new TilesRenderer();
  tiles.registerPlugin(
    new CesiumIonAuthPlugin({
      apiToken: options.token,
      assetId: String(ION_ASSETS[options.asset]),
      autoRefreshToken: true,
      useRecommendedSettings: true,
    }),
  );
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  try {
    ktx2.detectSupport(renderer);
  } catch (e) {
    errors.push(`KTX2 support detection: ${e instanceof Error ? e.message : String(e)}`);
  }
  tiles.registerPlugin(
    new GLTFExtensionsPlugin({
      dracoLoader: draco,
      ktxLoader: ktx2,
      meshoptDecoder: MeshoptDecoder,
    }),
  );
  tiles.registerPlugin(
    new ReorientationPlugin({
      lat: ORIGIN.lat * MathUtils.DEG2RAD,
      lon: ORIGIN.lon * MathUtils.DEG2RAD,
      height: 0,
      up: '+y',
      recenter: true,
    }),
  );
  tiles.registerPlugin(new UnloadTilesPlugin());
  tiles.errorTarget = options.errorTarget;
  tiles.setCamera(camera);
  let tilesetLoaded = false;
  const events = tiles as unknown as {
    addEventListener(
      type: string,
      listener: (event: { error?: unknown; url?: unknown }) => void,
    ): void;
  };
  events.addEventListener('load-root-tileset', () => {
    tilesetLoaded = true;
  });
  events.addEventListener('load-error', (event) => {
    const message = event.error instanceof Error ? event.error.message : String(event.error);
    errors.push(`${message}${typeof event.url === 'string' ? ` (${event.url.slice(0, 80)})` : ''}`);
    if (errors.length > 20) errors.shift();
  });
  scene.add(tiles.group);

  const resize = () => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    tiles.setResolutionFromRenderer(camera, renderer as never);
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  let windowStart = performance.now();
  let frames = 0;
  let frameMsSum = 0;
  let last = windowStart;
  void renderer.setAnimationLoop(() => {
    const now = performance.now();
    controls.update();
    camera.updateMatrixWorld();
    tiles.update();
    renderer.render(scene, camera);
    frames++;
    frameMsSum += now - last;
    last = now;
    if (now - windowStart >= 1000) {
      // Counters 3d-tiles-renderer keeps at run time but leaves out of its type declarations.
      const s = (tiles as unknown as { stats: Partial<Record<string, number>> }).stats;
      const memory = (
        renderer.info as unknown as { memory?: { geometries?: number; textures?: number } }
      ).memory;
      onStats({
        fps: (frames * 1000) / (now - windowStart),
        frameMs: frameMsSum / frames,
        triangles: renderer.info.render.triangles,
        drawCalls: renderer.info.render.drawCalls,
        downloading: s.downloading ?? 0,
        parsing: s.parsing ?? 0,
        visible: s.visible ?? 0,
        failed: s.failed ?? 0,
        errors: [...errors],
        tilesetLoaded,
        gpuGeometries: memory?.geometries ?? 0,
        gpuTextures: memory?.textures ?? 0,
      });
      windowStart = now;
      frames = 0;
      frameMsSum = 0;
    }
  });

  const raycaster = new Raycaster();
  return {
    setErrorTarget(target) {
      tiles.errorTarget = target;
    },
    probeGround() {
      let lowest: number | null = null;
      for (let i = -1; i <= 1; i++)
        for (let j = -1; j <= 1; j++) {
          raycaster.set(new Vector3(i * 100, 3000, j * 100), new Vector3(0, -1, 0));
          const hits = raycaster.intersectObject(tiles.group, true);
          if (hits.length === 0) continue;
          const y = hits[0].point.y;
          if (lowest === null || y < lowest) lowest = y;
        }
      return lowest;
    },
    dispose() {
      void renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      tiles.dispose();
      draco.dispose();
      ktx2.dispose();
      void renderer.dispose();
    },
  };
}
