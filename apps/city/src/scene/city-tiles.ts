import { TilesRenderer } from '3d-tiles-renderer';
import {
  CesiumIonAuthPlugin,
  GLTFExtensionsPlugin,
  UnloadTilesPlugin,
} from '3d-tiles-renderer/plugins';
import {
  type Material,
  Matrix3,
  Matrix4,
  Mesh,
  type Object3D,
  PerspectiveCamera,
  Raycaster,
  type Texture,
  Vector3,
} from 'three';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import type { BaseMap } from '../map/base-map.ts';
import type { GeoFrame } from '../map/geo-frame.ts';
import type { CityView } from './city-view.ts';

/** Cesium ion assets (see docs/3d-tiles-plan.md). */
export const ION_TILESETS = { photorealistic: 2275207 } as const;
export type TilesetId = keyof typeof ION_TILESETS;

export interface CityTiles {
  /** Opacity of the tiles, 0–1 (the panel's building transparency). */
  setOpacity(opacity: number): void;
  /** The tileset's credits (Google requires them on screen), plain text. */
  attributions(): string[];
  /** The tiles' ground at the focus, metres above the WGS84 ellipsoid (null until measured). */
  groundHeight(): number | null;
  /**
   * The tiles drawn now (for tests): how many, how many are leaves (the tileset has nothing
   * finer), their deepest level and smallest geometric error (metres), and downloads in flight.
   */
  stats(): { visible: number; leaves: number; depth: number; minErrorM: number; loading: number };
  dispose(): void;
}

/** First guess at the ground above the ellipsoid in London (measured 46.3 m at Canary Wharf). */
const GROUND_GUESS_M = 46;
/** Ordnance Datum Newlyn above the WGS84 ellipsoid in London (OSGM15 geoid, about 45–47 m). */
const GEOID_LONDON_M = 46;
/** Refit the frame when the focus has moved this far (keeps curvature error under ~1 cm). */
const REFIT_M = 400;
/** How often the ground is probed until it settles. */
const PROBE_MS = 1500;
/** Plausible ground in London, metres above the WGS84 ellipsoid; probes outside are ignored. */
const GROUND_MIN_M = 20;
const GROUND_MAX_M = 200;
/** A probe may move the ground at most this far at once (coarse tiles can give wild heights). */
const PROBE_STEP_MAX_M = 60;
const ERROR_TARGET = 8;

// WGS84 geodetic → earth-centred, earth-fixed (metres).
const A = 6378137;
const E2 = 6.69437999014e-3;
function ecef(lngDeg: number, latDeg: number, h: number): Vector3 {
  const lon = (lngDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const n = A / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  return new Vector3(
    (n + h) * Math.cos(lat) * Math.cos(lon),
    (n + h) * Math.cos(lat) * Math.sin(lon),
    (n * (1 - E2) + h) * Math.sin(lat),
  );
}

/**
 * The matrix taking the tiles' ECEF coordinates to the city's Three frame (X east, Y up, Z south
 * in region metres), exact at (fx, fy): three points 500 m apart on the ground and one 100 m up
 * are projected region → lon/lat with the GeoFrame (the same proj4 definition as the base map
 * and the pipeline) → ECEF at `ground` metres above the ellipsoid, and the affine map between
 * the two sets is solved in float64.
 */
function fitFrame(frame: GeoFrame, fx: number, fy: number, ground: number): Matrix4 {
  const local = [
    new Vector3(fx, 0, -fy),
    new Vector3(fx + 500, 0, -fy),
    new Vector3(fx, 0, -(fy + 500)),
    new Vector3(fx, 100, -fy),
  ];
  const world = local.map((p) => {
    const [lng, lat] = frame.toLngLat(p.x, -p.z);
    return ecef(lng, lat, ground + p.y);
  });
  // Differences from the first point, so the solve stays well conditioned at ECEF magnitudes.
  const e = new Matrix3();
  const l = new Matrix3();
  const dw = [1, 2, 3].map((i) => world[i].clone().sub(world[0]));
  const dl = [1, 2, 3].map((i) => local[i].clone().sub(local[0]));
  // prettier-ignore
  e.set(
    dw[0].x, dw[1].x, dw[2].x,
    dw[0].y, dw[1].y, dw[2].y,
    dw[0].z, dw[1].z, dw[2].z,
  );
  // prettier-ignore
  l.set(
    dl[0].x, dl[1].x, dl[2].x,
    dl[0].y, dl[1].y, dl[2].y,
    dl[0].z, dl[1].z, dl[2].z,
  );
  const solved = l.multiply(e.invert());
  // BNG's scale factor (about 0.9996) applies across the ground but not up, so the solve is very
  // slightly non-uniform; 3d-tiles-renderer's screen-space error wants a uniform scale. Use the
  // nearest rotation times the mean scale (under 0.2 m off at 500 m, and refitted at the focus).
  const linear = uniformScaled(solved);
  const m = new Matrix4().setFromMatrix3(linear);
  const t = local[0].clone().sub(world[0].clone().applyMatrix3(linear));
  m.setPosition(t);
  return m;
}

/** Nearest rotation (Gram–Schmidt on the columns) times the mean column length. */
function uniformScaled(m: Matrix3): Matrix3 {
  const e = m.elements;
  const x = new Vector3(e[0], e[1], e[2]);
  const y = new Vector3(e[3], e[4], e[5]);
  const z = new Vector3(e[6], e[7], e[8]);
  const scale = (x.length() + y.length() + z.length()) / 3;
  x.normalize();
  y.sub(x.clone().multiplyScalar(y.dot(x))).normalize();
  z.sub(x.clone().multiplyScalar(z.dot(x)))
    .sub(y.clone().multiplyScalar(z.dot(y)))
    .normalize();
  return new Matrix3().set(x.x, y.x, z.x, x.y, y.y, z.y, x.z, y.z, z.z).multiplyScalar(scale);
}

function applyOpacity(root: Object3D, opacity: number): void {
  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    const materials = (
      Array.isArray(node.material) ? node.material : [node.material]
    ) as Material[];
    for (const material of materials) {
      const transparent = opacity < 1;
      if (material.transparent !== transparent) material.needsUpdate = true;
      material.transparent = transparent;
      material.opacity = opacity;
      material.depthWrite = !transparent;
    }
  });
}

/**
 * Photorealistic 3D Tiles (Cesium ion) in the city scene, under and around the crowd and the
 * cars. The tileset stays in ECEF; its group carries fitFrame's matrix, refitted at the camera's
 * focus. The ground height is probed from the tiles themselves (lowest third of rays round the
 * focus), so the region's flat streets (y = 0) meet the tiles' streets there.
 */
export function startCityTiles(
  view: CityView,
  frame: GeoFrame,
  baseMap: BaseMap | null,
  options: {
    token: string;
    tileset: TilesetId;
    opacity: number;
    /**
     * With terrain (manifest `terrain`): the region's zero in metres above Ordnance Datum, and
     * the walking graph's points round a place (region frame, z = height above that zero). The
     * tiles are then levelled on the graph: each point's nearest tile surface, median offset.
     */
    terrain?: {
      zeroM: number;
      points: (x: number, y: number) => { x: number; y: number; z: number }[];
    };
  },
): CityTiles {
  const tiles = new TilesRenderer();
  tiles.registerPlugin(
    new CesiumIonAuthPlugin({
      apiToken: options.token,
      assetId: String(ION_TILESETS[options.tileset]),
      autoRefreshToken: true,
      // Its "recommended settings" set Google's tiles to errorTarget 20: too coarse up close.
      useRecommendedSettings: false,
    }),
  );
  const draco = new DRACOLoader().setDecoderPath('/draco/');
  const ktx2 = new KTX2Loader().setTranscoderPath('/basis/');
  ktx2.detectSupport(view.renderer);
  tiles.registerPlugin(
    new GLTFExtensionsPlugin({
      dracoLoader: draco,
      ktxLoader: ktx2,
      meshoptDecoder: MeshoptDecoder,
    }),
  );
  tiles.registerPlugin(new UnloadTilesPlugin());
  // Screen-space error in pixels before a finer tile loads (lower is sharper; 6 held 60 fps on an
  // M1 Pro in the Phase 0 spike), and a 1 GB cache so dense areas are not held at coarse levels.
  tiles.errorTarget = ERROR_TARGET;
  tiles.lruCache.minBytesSize = 0.8 * 2 ** 30;
  tiles.lruCache.maxBytesSize = 1 * 2 ** 30;
  const anisotropy = view.renderer.getMaxAnisotropy();

  let opacity = options.opacity;
  (
    tiles as unknown as { addEventListener(t: string, f: (e: { scene: Object3D }) => void): void }
  ).addEventListener('load-model', (event) => {
    // Tiles arrive without bounding volumes, and in the city view (the map's overlay camera)
    // such meshes were not drawn until they had them: compute them on load.
    event.scene.traverse((node) => {
      if (!(node instanceof Mesh)) return;
      const mesh = node as Mesh;
      mesh.geometry.computeBoundingBox();
      mesh.geometry.computeBoundingSphere();
      // Most of the view is seen at a slant: anisotropic filtering keeps those textures sharp.
      const map = (mesh.material as Material & { map?: Texture | null }).map;
      if (map != null && map.anisotropy !== anisotropy) {
        map.anisotropy = anisotropy;
        map.needsUpdate = true;
      }
    });
    applyOpacity(event.scene, opacity);
  });

  const group = tiles.group;
  group.matrixAutoUpdate = false;
  view.scene.add(group);

  // With a base map, the overlay camera keeps its rotation in the projection matrix, which the
  // tiles' level-of-detail maths cannot read: they get a plain camera at MapLibre's pose.
  const tilesCamera = new PerspectiveCamera(36.87, 1, 1, 200_000);
  tiles.setCamera(tilesCamera);

  let ground =
    options.terrain === undefined ? GROUND_GUESS_M : options.terrain.zeroM + GEOID_LONDON_M;
  let measured: number | null = null;
  let fitAt: { x: number; y: number } | null = null;
  let lastProbe = 0;
  let settled = 0;
  const raycaster = new Raycaster();
  const down = new Vector3(0, -1, 0);
  const refit = (x: number, y: number) => {
    fitAt = { x, y };
    group.matrix.copy(fitFrame(frame, x, y, ground));
    group.matrixWorldNeedsUpdate = true;
    group.updateMatrixWorld(true);
  };

  /** Ground at the focus in the city frame (y), from the lowest third of 25 rays 60 m apart. */
  /**
   * How far the tiles' ground sits above where it should (y), at the focus. With terrain: at the
   * walking graph's points, the tile surface nearest each point's height (skipping roofs and
   * trees above it), median of the differences. Without: the lowest third of 25 rays 60 m apart.
   */
  const probe = (x: number, y: number): number | null => {
    if (options.terrain !== undefined) {
      const offsets: number[] = [];
      for (const p of options.terrain.points(x, y)) {
        raycaster.set(new Vector3(p.x, p.z + 400, -p.y), down);
        let best: number | null = null;
        for (const hit of raycaster.intersectObject(group, true)) {
          const d = hit.point.y - p.z;
          if (best === null || Math.abs(d) < Math.abs(best)) best = d;
        }
        if (best !== null && Math.abs(best) < 15) offsets.push(best);
      }
      if (offsets.length < 5) return null;
      offsets.sort((a, b) => a - b);
      return offsets[Math.floor(offsets.length / 2)] ?? null;
    }
    const hits: number[] = [];
    for (let i = -2; i <= 2; i++)
      for (let j = -2; j <= 2; j++) {
        raycaster.set(new Vector3(x + i * 60, 600, -(y + j * 60)), down);
        const hit = raycaster.intersectObject(group, true);
        if (hit.length > 0) hits.push(hit[0].point.y);
      }
    if (hits.length < 5) return null;
    hits.sort((a, b) => a - b);
    return hits[Math.floor(hits.length / 3)];
  };

  const remove = view.addFrameHook((camera, _height, _dt, focus) => {
    const canvas = view.renderer.domElement;
    if (baseMap === null) {
      tilesCamera.copy(camera);
    } else {
      baseMap.poseCamera(tilesCamera, canvas.width / Math.max(1, canvas.height));
    }
    tilesCamera.updateMatrixWorld();
    const fx = focus.x;
    const fy = -focus.z;
    if (fitAt === null || Math.hypot(fx - fitAt.x, fy - fitAt.y) > REFIT_M) {
      refit(fx, fy);
      settled = 0;
    }
    const now = performance.now();
    if (settled < 3 && now - lastProbe > PROBE_MS) {
      lastProbe = now;
      const offset = probe(fx, fy);
      const next = offset === null ? null : ground + offset;
      if (
        offset !== null &&
        next !== null &&
        Math.abs(offset) <= PROBE_STEP_MAX_M &&
        next >= GROUND_MIN_M &&
        next <= GROUND_MAX_M
      ) {
        // The tiles' ground sits `offset` above y = 0: move the frame so it lands on it.
        ground = next;
        measured = ground;
        settled = Math.abs(offset) < 0.3 ? settled + 1 : 0;
        refit(fx, fy);
      }
    }
    tiles.setResolution(tilesCamera, canvas.width, canvas.height);
    tiles.update();
  });

  return {
    setOpacity(next) {
      opacity = next;
      applyOpacity(group, next);
    },
    attributions() {
      const text: string[] = [];
      for (const a of tiles.getAttributions()) {
        if (a.type === 'string') text.push(String(a.value));
        else if (a.type === 'html') {
          const plain = new DOMParser().parseFromString(String(a.value), 'text/html').body
            .textContent;
          if (plain.trim() !== '') text.push(plain.trim());
        }
      }
      return [...new Set(text)];
    },
    groundHeight: () => measured,
    stats() {
      const t = tiles as unknown as {
        visibleTiles: Set<{
          children: unknown[];
          geometricError: number;
          content?: { uri?: string };
          internal?: { depth?: number };
        }>;
        stats: { downloading: number; parsing: number };
      };
      let leaves = 0;
      let depth = 0;
      let minErrorM = Infinity;
      for (const tile of t.visibleTiles) {
        // A child tileset (.json) still to load is not a leaf.
        if (tile.children.length === 0 && !(tile.content?.uri ?? '').includes('.json')) leaves++;
        depth = Math.max(depth, tile.internal?.depth ?? 0);
        minErrorM = Math.min(minErrorM, tile.geometricError);
      }
      return {
        visible: t.visibleTiles.size,
        leaves,
        depth,
        minErrorM,
        loading: t.stats.downloading + t.stats.parsing,
      };
    },
    dispose() {
      remove();
      view.scene.remove(group);
      tiles.dispose();
      draco.dispose();
      ktx2.dispose();
    },
  };
}
