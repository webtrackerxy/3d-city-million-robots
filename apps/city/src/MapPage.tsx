import { EdgeFlag, EdgeType, NodeType } from '@city/core-types';
import { appendRoofs, type RoofZone } from '@city/buildings';
import { type NavTile, writeNavTile } from '@city/formats';
import { simGraphFromTile } from '@city/nav';
import { LodPreset } from '@city/render';
import { AgentState, type FollowKind } from '@city/sim';
import type { FollowState } from '@city/sim-worker';
import type { FollowLog } from './crowd/follow-log.ts';
import { type BaseMap, startBaseMap } from './map/base-map.ts';
import { type CityTiles, startCityTiles } from './scene/city-tiles.ts';
import {
  type BuildingLabel,
  type BuildingLabels,
  startBuildingLabels,
} from './scene/building-labels.ts';
import { type MapCameraView, PLACES, placesIn, placeView, type PlaceView } from './map/places.ts';
import { type BasemapId, isBasemapId } from './map/basemaps.ts';
import { GeoFrame } from './map/geo-frame.ts';
import {
  loadRegionGraph,
  withOutlines,
  type StreamedArea,
  TileStreamer,
} from './region/tile-streamer.ts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { type CrowdLayer, type CrowdStats, startCrowd } from './crowd/crowd-layer.ts';
import { startTraffic, type TrafficLayer, type TrafficStats } from './traffic/traffic-layer.ts';
import {
  fetchManifest,
  type LoadedRegion,
  type LoadStats,
  regionExtent,
  streamRegion,
} from './region/load-region.ts';
import type { ProfileName, RouteResult } from './routing/protocol.ts';
import { NEEDS_WEBGPU, PHONE } from './device.ts';
import { RouteClient } from './routing/route-client.ts';
import {
  type CityView,
  type Layers,
  OCCLUDER_LAYER,
  startCityView,
  type ViewStats,
} from './scene/city-view.ts';
import { routePolyline } from './scene/route-geometry.ts';
import { LOAD_STEPS, type LoadStep, type LoadStepId, LoadingPanel } from './ui/LoadingPanel.tsx';
import { type CrowdMix, type MapView, Panel, type RouteSummary } from './ui/Panel.tsx';
import { regionTitle } from './ui/region-title.ts';
import {
  compass,
  MODEL_CREDITS,
  type Selected,
  SelectionCard,
  type SelectionDetails,
} from './ui/SelectionCard.tsx';
import { createSelectionMarker } from './scene/selection-marker.ts';
import { enterXrCity, hasWebgpuXr } from './xr-webgl/xr-city.ts';
import { Matrix4 } from 'three';
import { groundDepthMesh } from './scene/ground-depth.ts';
import { streetGround } from './scene/street-ground.ts';
import { groundGrid } from './scene/ground-grid.ts';

const PARAMS = new URLSearchParams(location.search);
/**
 * `?region=`: london (default; 20 km, built in chunks), central, docklands, canary-wharf. A build
 * can change the default with `VITE_DEFAULT_REGION` (the demo deploy opens on central, a tenth of
 * London's data, and leaves London out to stay small).
 */
const REGION =
  PARAMS.get('region') ?? (import.meta.env.VITE_DEFAULT_REGION as string | undefined) ?? 'london';
/**
 * `?showcase=1`: two million people and robots on the streets — every agent has a row, walks from
 * the start and never goes indoors; half robots unless `robots` says otherwise (a million robots,
 * and the people split evenly between the human models); no interiors;
 * four simulation workers. London and central open in it (`?showcase=0` for the plain simulation,
 * where most people start indoors and a city this size looks empty), central with one million on
 * its tenth of London's streets. Each default can be overridden.
 */
/**
 * Map XR (/map-xr, a full page load): the city without MapLibre (it cannot draw in a headset), a
 * crowd a headset can carry, and an Enter XR button that stands the viewer in the street.
 */
const XR = location.pathname.startsWith('/map-xr');
/** Map XR on WebGL: people and cars drawn at once (the nearest), `?xrPeople=` / `?xrCars=`. */
const XR_PEOPLE = Math.max(0, Number(PARAMS.get('xrPeople') ?? 300) || 0);
const XR_CARS = Math.max(0, Number(PARAMS.get('xrCars') ?? 60) || 0);
/** `?xrPreview=1`: Enter XR shows the WebGL headset view on the page instead (desktop check). */
const XR_PREVIEW = PARAMS.get('xrPreview') === '1';
const SHOWCASE =
  PARAMS.get('showcase') === '1' ||
  (PARAMS.get('showcase') !== '0' && (REGION === 'london' || REGION === 'central'));
/** Large regions stream their buildings within this distance of the view (a square). */
const STREAM_RADIUS_M = 1500;
const AGENTS = Math.max(
  0,
  Number(
    PARAMS.get('agents') ??
      (XR
        ? 20_000
        : SHOWCASE
          ? REGION === 'london'
            ? 2_000_000
            : 1_000_000
          : PHONE
            ? 2_000
            : 10_000),
  ) || 0,
);
/** `?population=N`: people in the region (default: the rows); the rest wait in building aggregates. */
const POPULATION = Math.max(0, Number(PARAMS.get('population') ?? 0) || 0);
/** `?workers=N`: simulation workers (default: about a third of the cores, at most 4; 1 on a phone). */
const WORKERS = Math.max(
  1,
  Number(PARAMS.get('workers') ?? (SHOWCASE ? 4 : PHONE ? 1 : 0)) ||
    Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 3)),
);
/** `?lod=density|brief`: LOD thresholds (default brief; density in the showcase). */
const LOD_PRESET =
  (PARAMS.get('lod') ?? (SHOWCASE ? 'density' : 'brief')) === 'density'
    ? LodPreset.Density
    : LodPreset.Brief;
/** `?minPx=N`: agents projected under N pixels tall are not drawn (plan §20.5; default 0). */
const MIN_PX = Math.max(0, Number(PARAMS.get('minPx') ?? 0) || 0);
/** `?timeScale=S`: simulated seconds per real second at the start (default 1). */
const TIME_SCALE = Math.max(0, Number(PARAMS.get('timeScale') ?? 1));
/** `?startHour=H`: time of day at the start (default 8). */
const START_HOUR = Number(PARAMS.get('startHour') ?? 8) || 8;
const ROBOT_SHARE = Math.min(
  1,
  Math.max(0, Number(PARAMS.get('robots') ?? (SHOWCASE ? 0.5 : 0.2)) || 0),
);
/** The robots, then the people split evenly between the two human models. */
const INITIAL_MIX: CrowdMix = (() => {
  const robots = Math.round(AGENTS * ROBOT_SHARE);
  const women = Math.floor((AGENTS - robots) / 2);
  return { robots, women, men: AGENTS - robots - women };
})();
const SEED = Number(PARAMS.get('seed') ?? 1) >>> 0;
/** Hi-Z occlusion of the crowd by buildings (`?occlusion=0` turns it off, for comparison). */
// Off in XR: the Hi-Z depth pre-pass is not stereo-aware.
const OCCLUSION = PARAMS.get('occlusion') !== '0' && !XR;
/** Debug: `?lodCaps=N` caps every mesh LOD band at N agents (0 = all impostors). */
const LOD_CAP_OVERRIDE = PARAMS.has('lodCaps') ? Number(PARAMS.get('lodCaps')) : undefined;
/** `?cars=N`: cars on the region's roads (default: ~60 per km of road, at most 50k, 5k on a phone; 0 = none). */
const CARS = PARAMS.has('cars') ? Math.max(0, Number(PARAMS.get('cars')) || 0) : XR ? 2_000 : null;
/**
 * `?roofs=S`: share of the people and robots walking at the start who walk on roofs (default 0.01:
 * enough to follow one, few enough that roofs do not look crowded).
 */
const ROOF_SHARE = Math.min(1, Math.max(0, Number(PARAMS.get('roofs') ?? 0.01) || 0));

declare global {
  interface Window {
    /** Measurement hooks for scripted runs (Playwright). */
    __city?: {
      frameTimes: () => number[];
      gpuTimes: () => number[];
      crowd: () => CrowdStats | null;
      load: () => LoadStats | null;
      /** The base map's camera (bearing, pitch, zoom), for scripted views. */
      camera: (view: { bearing?: number; pitch?: number; zoom?: number }) => void;
      /** The photorealistic tiles drawn now (null when off). */
      tiles: () => ReturnType<CityTiles['stats']> | null;
    };
  }
}
/** `?at=x,y,height[,distance]`: start looking at a tile point (shareable QA views). */
/**
 * `?place=<id>`: start at a place (see map/places.ts), e.g. `canary-wharf`; `?at` wins. The
 * showcase opens low over Trafalgar Square, where people and robots are large enough to see.
 */
const PLACE = PARAMS.get('place') ?? (SHOWCASE ? 'trafalgar-square' : null);
/** Cesium ion token for 3D Tiles (apps/city/.env.local; the demo build leaves it empty). */
const TILES_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) ?? '';
/** `?tiles=photorealistic`: start with Google Photorealistic 3D Tiles (needs the token). */
const INITIAL_TILES: TilesMode =
  PARAMS.get('tiles') === 'photorealistic' && TILES_TOKEN !== '' ? 'photorealistic' : 'off';
/** The demo build sets another default region and leaves London's data out. */
const LONDON_AVAILABLE = (import.meta.env.VITE_DEFAULT_REGION ?? 'london') === 'london';
type TilesMode = 'off' | 'photorealistic';
const AT = (() => {
  const parts = (PARAMS.get('at') ?? '').split(',').map(Number);
  if (parts.length < 2 || !parts.slice(0, 2).every(Number.isFinite)) return undefined;
  const [x = 0, y = 0, height = 250, distance = 0] = parts;
  return {
    x,
    y,
    height: Number.isFinite(height) ? height : 250,
    distance: Number.isFinite(distance) ? distance : 0,
  };
})();
/**
 * `?basemap=vector|satellite|imagery|none`: the map under the city (default vector: OpenFreeMap
 * Liberty, as in the cars project), on a globe; `none` is the plain orbit view.
 */
const BASEMAP: BasemapId | null = (() => {
  if (XR) return null;
  const id = PARAMS.get('basemap') ?? 'vector';
  return isBasemapId(id) ? id : null;
})();
const INITIAL_LAYERS: Layers = {
  buildings: true,
  buildingOpacity: 1,
  labels: true,
  // Over a base map the streets are already drawn.
  network: BASEMAP === null,
  colouring: 'source',
  showOtherLevels: true,
  deadEnds: false,
  entrances: true,
};

export function MapPage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const mapContainer = useRef<HTMLDivElement>(null);
  const view = useRef<CityView | null>(null);
  const router = useRef<RouteClient | null>(null);
  const [region, setRegion] = useState<LoadedRegion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadSteps, setLoadSteps] = useState(LOAD_STEPS);
  /** Advances a start-up step (the loading panel); logs each step's time when it finishes. */
  const loadStep = useCallback((id: LoadStepId, patch: Partial<LoadStep>) => {
    setLoadSteps((previous) => {
      const current = previous[id];
      const now = performance.now();
      const next = { ...current, ...patch };
      if (patch.state === 'active' && current.startedAt === null) next.startedAt = now;
      if (patch.state === 'done' && current.state !== 'done') {
        next.startedAt ??= now;
        next.ms = now - next.startedAt;
        console.info(`[load] ${current.label}: ${(next.ms / 1000).toFixed(1)} s`);
      }
      return { ...previous, [id]: next };
    });
  }, []);
  const [layers, setLayers] = useState(INITIAL_LAYERS);
  /** The layers for code outside render (the labels' start). */
  const layersRef = useRef(INITIAL_LAYERS);
  const [basemap, setBasemap] = useState<BasemapId | null>(BASEMAP);
  const baseMapRef = useRef<BaseMap | null>(null);
  const labelsLayer = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<BuildingLabels | null>(null);
  const frameRef = useRef<GeoFrame | null>(null);
  const [tilesMode, setTilesMode] = useState<TilesMode>(INITIAL_TILES);
  const tilesRef = useRef<CityTiles | null>(null);
  const tilesControlRef = useRef<((photorealistic: boolean) => void) | null>(null);
  const [tilesCredit, setTilesCredit] = useState('');
  const [tilesGround, setTilesGround] = useState<number | null>(null);
  const [stats, setStats] = useState<ViewStats | null>(null);
  const [mapView, setMapView] = useState<MapView | null>(null);
  /**
   * The places the panel offers: those in this region fly there (`view`); Trafalgar Square, when
   * the region does not reach it, opens the London region there instead (`href`).
   */
  const [places, setPlaces] = useState<
    { id: string; name: string; view?: PlaceView; camera?: MapCameraView; href?: string }[]
  >([]);
  /** The start view: `?at`, else `?place`, resolved once the manifest is known. */
  const startAtRef = useRef<PlaceView | undefined>(AT);
  const [profile, setProfile] = useState<ProfileName>('pedestrian');
  const [viewReady, setViewReady] = useState(false);
  const [mix, setMix] = useState<CrowdMix>(INITIAL_MIX);
  const agents = mix.robots + mix.women + mix.men;
  const [timeScale, setTimeScale] = useState(TIME_SCALE);
  const [crowdStatus, setCrowdStatus] = useState('');
  /** Map XR: in a headset session, and why entering failed (if it did). */
  const [xrActive, setXrActive] = useState(false);
  const [xrError, setXrError] = useState('');
  /** A population change being built (the old crowd walks meanwhile): the new size, or null. */
  const [crowdUpdating, setCrowdUpdating] = useState<number | null>(null);
  const [crowdStats, setCrowdStats] = useState<CrowdStats | null>(null);
  const crowd = useRef<CrowdLayer | null>(null);
  /** The clicked person, robot or car, its details card and whether the camera follows it. */
  const [selected, setSelected] = useState<Selected | null>(null);
  const selectedRef = useRef<Selected | null>(null);
  const [selectionDetails, setSelectionDetails] = useState<SelectionDetails | null>(null);
  const [selectionFollowed, setSelectionFollowed] = useState(false);
  const traffic = useRef<TrafficLayer | null>(null);
  const [cars, setCars] = useState<number | null>(CARS);
  const [trafficStatus, setTrafficStatus] = useState('');
  const [trafficStats, setTrafficStats] = useState<TrafficStats | null>(null);
  const loadStats = useRef<LoadStats | null>(null);
  const [follow, setFollow] = useState<FollowLog | null>(null);
  const followRef = useRef<FollowLog | null>(null);
  /** Where streamed buildings are (null: all loaded), for drawing roof walkers. */
  const streamedRef = useRef<StreamedArea | null>(null);
  const [route, setRoute] = useState<RouteSummary>({
    origin: null,
    destination: null,
    result: null,
  });
  // Read by the pick callback, which the view holds from start-up; written with the state.
  const routeRef = useRef(route);
  const profileRef = useRef(profile);
  const regionRef = useRef(region);

  const showRoute = useCallback(
    (origin: number | null, destination: number | null, result: RouteResult | null) => {
      routeRef.current = { origin, destination, result };
      setRoute(routeRef.current);
      const tile = regionRef.current?.tile;
      const points =
        tile !== undefined && result?.found === true ? routePolyline(tile, result.halfEdges) : null;
      view.current?.setRoute(points, origin, destination);
    },
    [],
  );

  const requestRoute = useCallback(
    (origin: number, destination: number, name: ProfileName) => {
      showRoute(origin, destination, null);
      void router.current?.route(origin, destination, name).then((result) => {
        const current = routeRef.current;
        if (current.origin === origin && current.destination === destination)
          showRoute(origin, destination, result);
      });
    },
    [showRoute],
  );

  const pick = useCallback(
    (node: number) => {
      const { origin, destination } = routeRef.current;
      if (origin === null || destination !== null) showRoute(node, null, null);
      else requestRoute(origin, node, profileRef.current);
    },
    [showRoute, requestRoute],
  );

  useEffect(() => {
    let cancelled = false;
    const isCancelled = () => cancelled;
    let started: CityView | null = null;
    let baseMap: BaseMap | null = null;
    let streamer: TileStreamer | null = null;
    (async () => {
      if (!('gpu' in navigator)) throw new Error(NEEDS_WEBGPU);
      loadStep('map', { state: 'active' });
      const manifest = await fetchManifest(REGION);
      if (isCancelled() || canvas.current === null) return;
      const extent = regionExtent(manifest);
      frameRef.current = new GeoFrame(manifest.origin);
      const place = PLACE === null ? undefined : PLACES.find((p) => p.id === PLACE);
      const at = AT ?? (place === undefined ? undefined : placeView(place, manifest));
      startAtRef.current = at;
      const startView =
        at ??
        (manifest.graph === undefined
          ? { x: 0, y: 0, height: extent * 0.45, distance: extent * 0.75 }
          : { x: 0, y: 0, height: 700, distance: 1100 });
      const offered: {
        id: string;
        name: string;
        view?: PlaceView;
        camera?: MapCameraView;
        href?: string;
      }[] = placesIn(manifest).map(({ place: p, view }) => ({
        id: p.id,
        name: p.name,
        view,
        ...(p.camera === undefined ? {} : { camera: p.camera }),
      }));
      // Places outside this region open the London region there (every place is in London),
      // unless this build has no London (the demo build). PLACES' order is kept.
      if (REGION !== 'london' && LONDON_AVAILABLE)
        for (const [i, p] of PLACES.entries())
          if (!offered.some((o) => o.id === p.id))
            offered.splice(i, 0, { id: p.id, name: p.name, href: `?region=london&place=${p.id}` });
      setPlaces(offered);
      if (BASEMAP !== null && mapContainer.current !== null) {
        const size = manifest.tileSizeM;
        const xs = manifest.tiles.map((t) => t.x);
        const ys = manifest.tiles.map((t) => t.y);
        const [x0, x1] = [Math.min(...xs) * size, (Math.max(...xs) + 1) * size];
        const [y0, y1] = [Math.min(...ys) * size, (Math.max(...ys) + 1) * size];
        const { x: gx, y: gy } = manifest.gridOrigin;
        baseMap = await startBaseMap(mapContainer.current, {
          basemap: BASEMAP,
          frame: frameRef.current,
          outline: [
            [gx + x0, gy + y0],
            [gx + x1, gy + y0],
            [gx + x1, gy + y1],
            [gx + x0, gy + y1],
          ],
          title: `${regionTitle(manifest.region)}${SHOWCASE ? ` · ${INITIAL_MIX.robots.toLocaleString()} robots and ${(INITIAL_MIX.women + INITIAL_MIX.men).toLocaleString()} people` : ''}`,
          view: startView,
          // A place's hand-picked camera, unless `?at` sets the view.
          camera: AT === undefined ? place?.camera : undefined,
        });
        if (isCancelled()) {
          baseMap.dispose();
          return;
        }
        baseMapRef.current = baseMap;
        // The OSM / Photo buildings switch in the map controls (with a Cesium ion token).
        if (TILES_TOKEN !== '') {
          tilesControlRef.current = baseMap.addTilesControl((photo) => {
            setTilesMode(photo ? 'photorealistic' : 'off');
          });
          tilesControlRef.current(INITIAL_TILES === 'photorealistic');
        }
        // The panel's live view readout, at most once per frame while the map moves.
        const map = baseMap.map;
        let pending = false;
        const readView = () => {
          pending = false;
          const centre = map.getCenter();
          setMapView({
            zoom: map.getZoom(),
            pitch: map.getPitch(),
            bearing: map.getBearing(),
            lng: centre.lng,
            lat: centre.lat,
          });
        };
        map.on('move', () => {
          if (pending) return;
          pending = true;
          requestAnimationFrame(readView);
        });
        readView();
      }
      loadStep('map', { state: BASEMAP === null ? 'skipped' : 'done' });
      // The view starts empty; tiles stream in nearest the camera first.
      started = await startCityView(
        canvas.current,
        extent,
        INITIAL_LAYERS,
        setStats,
        pick,
        at,
        baseMap ?? undefined,
        XR,
      );
      if (isCancelled()) {
        started.dispose();
        return;
      }
      const current = started;
      view.current = current;
      // Building names (labels.json from tools/osm-pipeline labels; a region without one has none).
      void fetch(`${import.meta.env.BASE_URL}regions/${encodeURIComponent(REGION)}/labels.json`)
        .then((response) =>
          response.ok ? (response.json() as Promise<{ labels: BuildingLabel[] }>) : null,
        )
        .then((data) => {
          if (data === null || isCancelled() || labelsLayer.current === null) return;
          labelsRef.current = startBuildingLabels(labelsLayer.current, data.labels, current, () =>
            [...document.querySelectorAll('.app .panel')].map((e) => e.getBoundingClientRect()),
          );
          labelsRef.current.setVisible(layersRef.current.labels);
        })
        .catch(() => undefined);
      let loaded: LoadedRegion;
      loadStep('graph', { state: 'active' });
      if (manifest.graph === undefined) {
        // Small regions: every tile, buildings included, then stitched.
        let tiles = 0;
        const own = new Set<number>();
        loaded = await streamRegion(REGION, manifest, { x: at?.x ?? 0, y: at?.y ?? 0 }, (t) => {
          tiles++;
          for (const id of buildingOsmIds(t.tile.buildings)) own.add(id);
          if (tiles % 16 === 0)
            loadStep('graph', {
              fraction: tiles / manifest.tiles.length,
              detail: `${tiles} / ${manifest.tiles.length} tiles`,
            });
          return current.addTileBuildings(
            t.tile.buildings,
            t.originX,
            t.originY,
            t.entry.buildingOffset,
          );
        });
        baseMap?.setOwnBuildings(own);
        loadStep('buildings', { state: 'skipped' });
      } else {
        // A city: the whole graph from one file, buildings streamed around the view.
        const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(0);
        const graph = await loadRegionGraph(REGION, manifest.graph.file, (received, total) => {
          loadStep('graph', {
            fraction: received / total,
            detail: `${mb(received)} / ${mb(total)} MB`,
          });
        });
        // Building outlines live in the tiles only: fill in the ones round the start view, where
        // the crowd's roof walks are built (the streamer then finds those tiles in the cache).
        const start = startAtRef.current ?? { x: 0, y: 0 };
        const graphTile =
          manifest.graph.buildingOutlines === 'tiles'
            ? await withOutlines(REGION, manifest, graph.tile, {
                minX: start.x - STREAM_RADIUS_M,
                minY: start.y - STREAM_RADIUS_M,
                maxX: start.x + STREAM_RADIUS_M,
                maxY: start.y + STREAM_RADIUS_M,
              })
            : graph.tile;
        loadStep('buildings', { state: 'active' });
        const owned = baseMap;
        // The streamed tiles' building ids, handed to the base map once per frame of changes.
        const ownByTile = new Map<string, number[]>();
        let ownPending = false;
        const updateOwn = () => {
          if (ownPending) return;
          ownPending = true;
          requestAnimationFrame(() => {
            ownPending = false;
            owned?.setOwnBuildings(new Set([...ownByTile.values()].flat()));
          });
        };
        streamer = new TileStreamer(REGION, manifest, STREAM_RADIUS_M, {
          progress: (tiles, wanted) => {
            loadStep('buildings', {
              fraction: tiles / Math.max(1, wanted),
              detail: `${tiles} / ${wanted} tiles`,
              ...(tiles >= wanted ? { state: 'done' as const } : {}),
            });
          },
          add: (tile, ox, oy, first) => {
            ownByTile.set(`${ox},${oy}`, buildingOsmIds(tile.buildings));
            updateOwn();
            return current.addTileBuildings(tile.buildings, ox, oy, first);
          },
          remove: (ox, oy) => {
            ownByTile.delete(`${ox},${oy}`);
            updateOwn();
            current.removeTileBuildings(ox, oy);
          },
          area: (a) => {
            streamedRef.current = a;
            crowd.current?.setRoofArea(a);
          },
        });
        const stream = streamer;
        current.addFrameHook((_camera, _height, _dt, focus) => {
          stream.update(focus.x, -focus.z);
        });
        loaded = {
          manifest,
          tile: graphTile,
          // Routing needs no outlines.
          files: writeNavTile(graph.tile),
          bytes: graph.bytes,
          load: {
            tiles: 1,
            totalMs: graph.ms,
            meanTileMs: 0,
            maxTileMs: 0,
            stitchMs: 0,
            meanTileBytes: graph.bytes,
            maxTileBytes: graph.bytes,
          },
        };
      }
      if (isCancelled()) return;
      loadStep('graph', { state: 'done' });
      current.setGraph(loaded.tile);
      if (loaded.manifest.terrain !== undefined) {
        // Walls of buildings on slopes start at the street beside them, not their lowest ground.
        current.setStreetGround(streetGround(loaded.tile.nodes));
        // What still reaches below the street is hidden by an invisible ground. Not over the
        // photorealistic tiles: they have their own ground, which ours would cut into.
        const groundDepth = groundDepthMesh(loaded.tile.nodes);
        if (groundDepth !== null) {
          current.scene.add(groundDepth);
          current.addFrameHook(() => {
            groundDepth.visible = tilesRef.current === null;
          });
        }
      }
      if (loaded.manifest.terrain !== undefined && baseMap !== null) {
        // The map's camera stands on its flat ground: lower the city (and the photorealistic
        // tiles with it, which keep their terrain relative to the city) so the street at the
        // focus meets that ground, gliding as the view moves. Without it a close view's camera
        // ends up below a street higher than the region's zero.
        const ground = groundGrid(loaded.tile.nodes);
        let offset = 0;
        current.addFrameHook((_camera, _height, dt, focus) => {
          const target = ground.sample(focus.x, -focus.z) ?? offset;
          offset += (target - offset) * Math.min(1, dt / 300);
          current.setGroundOffset(offset);
        });
      }
      router.current = new RouteClient(loaded.files);
      regionRef.current = loaded;
      loadStats.current = loaded.load;
      setRegion(loaded);
      setViewReady(true);
      window.__city = {
        frameTimes: () => view.current?.frameTimes() ?? [],
        gpuTimes: () => view.current?.gpuTimes() ?? [],
        crowd: () => crowd.current?.stats() ?? null,
        load: () => loadStats.current,
        camera: (next) => {
          baseMap?.map.jumpTo(next);
        },
        tiles: () => tilesRef.current?.stats() ?? null,
      };
    })().catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
    });
    return () => {
      cancelled = true;
      labelsRef.current?.dispose();
      labelsRef.current = null;
      streamer?.dispose();
      started?.dispose();
      baseMap?.dispose();
      baseMapRef.current = null;
      router.current?.dispose();
      router.current = null;
      view.current = null;
    };
  }, [pick, loadStep]);

  /** Journey log of the followed roof walker. */
  const trackFollow = (state: FollowState | null, at: number) => {
    let log = followRef.current;
    if (log === null || state?.agent !== log.agent) return;
    // The seed identifies the person: taken from the first report.
    if (log.seed < 0) log = { ...log, seed: state.seed };
    let text: string;
    if (state.seed !== log.seed || !state.roof) {
      // Roof walkers stay up for good; this would be a bug, so say so rather than follow someone else.
      text = 'lost sight of them';
      crowd.current?.setFollow(-1);
      view.current?.setFollowTarget(null);
    } else {
      const roof = `the roof of building #${state.building}`;
      text = state.state === AgentState.Pause ? `standing on ${roof}` : `walking on ${roof}`;
    }
    if (text === log.last) return;
    const next = { ...log, last: text, lines: [...log.lines, { at, text }].slice(-12) };
    followRef.current = next;
    setFollow(next);
  };

  /** Selects a person, robot or car (null clears), stopping any follow (Roof view's too). */
  const select = useCallback((next: Selected | null) => {
    followRef.current = null;
    setFollow(null);
    view.current?.setFollowTarget(null);
    setSelectionFollowed(false);
    selectedRef.current = next;
    setSelected(next);
    // The simulation reports the selected agent's state (as for Roof view).
    crowd.current?.setFollow(next?.type === 'agent' ? next.id : -1);
    if (next === null) setSelectionDetails(null);
  }, []);
  /** Where the selected one is now (Three coordinates), or null. */
  const selectedPosition = useCallback(() => {
    const s = selectedRef.current;
    if (s === null) return null;
    return s.type === 'agent'
      ? (crowd.current?.agentPosition(s.id) ?? null)
      : (traffic.current?.carInfo(s.id)?.position ?? null);
  }, []);

  // The crowd on screen while a new one builds (a population change), dropped once it is ready.
  const retiringCrowd = useRef<{ layer: CrowdLayer; removeHook: () => void } | null>(null);
  const dropRetiringCrowd = () => {
    retiringCrowd.current?.removeHook();
    retiringCrowd.current?.layer.dispose();
    retiringCrowd.current = null;
  };
  useEffect(() => dropRetiringCrowd, []);

  // The crowd: restarted when the population changes.
  useEffect(() => {
    const current = view.current;
    const loaded = regionRef.current;
    if (agents === 0) dropRetiringCrowd();
    if (!viewReady || current === null || loaded === null || agents === 0) {
      setCrowdUpdating(null);
      return;
    }
    // A change after the first crowd (the first has the loading panel).
    if (retiringCrowd.current !== null || crowd.current !== null) setCrowdUpdating(agents);
    let cancelled = false;
    let layer: CrowdLayer | null = null;
    let removeHook: (() => void) | null = null;
    // Roof walks, appended to the region graph the crowd walks: every roof in a small region; in
    // a city, the roofs around the start view (where buildings stream in first).
    const roofZone: RoofZone | undefined =
      loaded.manifest.graph === undefined
        ? undefined
        : {
            minX: (startAtRef.current?.x ?? 0) - STREAM_RADIUS_M,
            minY: (startAtRef.current?.y ?? 0) - STREAM_RADIUS_M,
            maxX: (startAtRef.current?.x ?? 0) + STREAM_RADIUS_M,
            maxY: (startAtRef.current?.y ?? 0) + STREAM_RADIUS_M,
          };
    const roofs =
      ROOF_SHARE > 0
        ? appendRoofs(loaded.tile, roofZone)
        : { tile: loaded.tile, firstRoofEdge: loaded.tile.edges.from.length };
    const graph = simGraphFromTile(roofs.tile);
    startCrowd(
      current.renderer,
      current.scene,
      writeNavTile(roofs.tile),
      graph,
      {
        agents,
        firstRoofEdge: roofs.firstRoofEdge,
        roofShare: ROOF_SHARE,
        ...(roofZone === undefined ? {} : { roofZone }),
        population: Math.max(agents, POPULATION),
        workers: WORKERS,
        showcase: SHOWCASE,
        ...(loaded.manifest.graph === undefined
          ? {}
          : {
              // City scale: walks of up to 1 km (their route tables build fast enough to spawn a
              // million in seconds), and each worker keeps to its own strip.
              scale: {
                tripRadiusM: 1000,
                clusterM: 400,
                tableBytes: (PHONE ? 32 : 160) * 2 ** 20,
              },
              areas: workerStrips(loaded.tile, WORKERS),
            }),
        lodPreset: LOD_PRESET,
        minPx: MIN_PX,
        startHour: START_HOUR,
        robotShare: agents === 0 ? 0 : mix.robots / agents,
        // In the order of humanModels.
        humanShares: [mix.men, mix.women],
        seed: SEED,
        humanModels: ['/models/man.glb', '/models/woman.glb'],
        ...(OCCLUSION ? { occluderLayer: OCCLUDER_LAYER } : {}),
        ...(LOD_CAP_OVERRIDE === undefined ? {} : { lodCapOverride: LOD_CAP_OVERRIDE }),
        robotModel: '/models/optimus.glb',
      },
      (message) => {
        setCrowdStatus(message);
        if (message.startsWith('Starting the simulation')) {
          loadStep('crowd', { state: 'done' });
          loadStep('simulation', {
            state: 'active',
            detail: `${agents.toLocaleString()} ${SHOWCASE ? 'walking' : 'in the region'}`,
          });
        } else loadStep('crowd', { state: 'active', detail: message.replace(/…$/, '') });
      },
    )
      .then((started) => {
        if (cancelled) {
          started.dispose();
          return;
        }
        // The new crowd replaces the one kept on screen while it built.
        dropRetiringCrowd();
        setCrowdUpdating(null);
        // Agent numbers belong to the old crowd.
        if (selectedRef.current?.type === 'agent') select(null);
        layer = started;
        crowd.current = started;
        started.setRoofArea(streamedRef.current);
        started.setTimeScale(TIME_SCALE);
        removeHook = current.addFrameHook((camera, height, dt, focus) => {
          started.frame(camera, height, dt, focus);
        });
        setCrowdStatus('');
        loadStep('crowd', { state: 'done' });
        loadStep('simulation', { state: 'done' });
      })
      .catch((e: unknown) => {
        setCrowdStatus(`Crowd failed: ${e instanceof Error ? e.message : String(e)}`);
        setCrowdUpdating(null);
      });
    const poll = setInterval(() => {
      const stats = crowd.current?.stats() ?? null;
      setCrowdStats(stats);
      trackFollow(stats?.follow ?? null, stats?.simSeconds ?? 0);
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(poll);
      current.setFollowTarget(null);
      followRef.current = null;
      setFollow(null);
      // Keep this crowd walking until the next one is ready, so the city is never empty while
      // a new population spawns (it can take tens of seconds for a million).
      if (layer !== null && removeHook !== null) {
        dropRetiringCrowd();
        retiringCrowd.current = { layer, removeHook };
      } else removeHook?.();
    };
  }, [viewReady, agents, mix.robots, mix.women, mix.men, loadStep, select]);

  // Clicks pick the person, robot or car under the cursor; the marker and card follow it.
  useEffect(() => {
    const current = view.current;
    if (!viewReady || current === null) return;
    const marker = createSelectionMarker(current.scene);
    const viewProjection = new Matrix4();
    current.setClickPicker((ndcX, ndcY, camera) => {
      const canvasEl = current.renderer.domElement;
      const width = canvasEl.clientWidth;
      const height = canvasEl.clientHeight;
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const agent = crowd.current?.pickAgent(viewProjection, ndcX, ndcY, width, height, 24) ?? null;
      const car = traffic.current?.pickCar(viewProjection, ndcX, ndcY, width, height, 30) ?? null;
      if (agent === null && car === null) {
        // A click on empty ground clears the selection, and still picks entrances for routes.
        if (selectedRef.current !== null) select(null);
        return false;
      }
      select(
        car !== null && (agent === null || car.px < agent.px)
          ? { type: 'car', id: car.car }
          : { type: 'agent', id: agent?.agent ?? 0 },
      );
      return true;
    });
    const removeHook = current.addFrameHook((camera) => {
      const s = selectedRef.current;
      const position = selectedPosition();
      if (s === null || position === null) marker.hide();
      else {
        const distance = camera.position.distanceTo(position);
        if (s.type === 'car') marker.show(position, 2.6, 1.5, distance);
        else marker.show(position, 0.6, 1.9, distance);
      }
    });
    // The card's numbers, four times a second.
    const poll = setInterval(() => {
      const s = selectedRef.current;
      if (s === null) return;
      const frame = frameRef.current;
      const position = selectedPosition();
      const where =
        position === null || frame === null
          ? '—'
          : frame
              .toLngLat(position.x, -position.z)
              .map((v, i) => v.toFixed(5) + (i === 0 ? '° E' : '° N'))
              .reverse()
              .join(', ');
      const kmh = (mps: number) => `${(mps * 3.6).toFixed(1)} km/h`;
      if (s.type === 'car') {
        const info = traffic.current?.carInfo(s.id);
        if (info === undefined || info === null) return;
        setSelectionDetails({
          title: `Car #${s.id.toLocaleString()}`,
          model: MODEL_CREDITS.car,
          rows: [
            ['Paint', info.colour],
            ['Speed', kmh(info.speedMps)],
            ['Heading', compass(info.headingRad)],
            ['Where', where],
          ],
        });
        return;
      }
      const layer = crowd.current;
      const info = layer?.agentInfo(s.id) ?? null;
      if (layer === null || info === null) return;
      const follow = layer.stats()?.follow ?? null;
      const state =
        follow?.agent !== s.id
          ? info.indoor
            ? 'inside a building'
            : 'walking'
          : follow.state === AgentState.Wait
            ? 'waiting to cross'
            : follow.state === AgentState.Indoor
              ? 'inside a building'
              : follow.roof
                ? follow.state === AgentState.Pause
                  ? `standing on the roof of building #${follow.building}`
                  : `walking on the roof of building #${follow.building}`
                : 'walking';
      const who = info.robot ? 'Robot' : info.humanModel === 1 ? 'Woman' : 'Man';
      setSelectionDetails({
        title: `${who} #${s.id.toLocaleString()}`,
        model: info.robot
          ? MODEL_CREDITS.robot
          : info.humanModel === 1
            ? MODEL_CREDITS.woman
            : MODEL_CREDITS.man,
        rows: [
          ['Doing', state],
          [
            'Speed',
            state === 'walking' || state.startsWith('walking') ? kmh(info.speedMps) : '0 km/h',
          ],
          ['Heading', compass(info.headingRad)],
          ['Where', where],
        ],
      });
    }, 250);
    return () => {
      clearInterval(poll);
      removeHook();
      current.setClickPicker(null);
      marker.dispose();
    };
  }, [viewReady, select, selectedPosition]);

  const toggleSelectionFollow = () => {
    if (selectionFollowed) {
      view.current?.setFollowTarget(null);
      setSelectionFollowed(false);
    } else {
      view.current?.setFollowTarget(selectedPosition);
      setSelectionFollowed(true);
    }
  };

  // Traffic: restarted when the number of cars changes.
  useEffect(() => {
    const current = view.current;
    const manifest = regionRef.current?.manifest;
    if (!viewReady || current === null || manifest === undefined) return;
    if (manifest.roads === undefined) {
      setTrafficStatus('This region has no road network; run the pipeline with --roads-only.');
      loadStep('traffic', { state: 'skipped' });
      return;
    }
    // About 60 per km of road, at most 50k by default (a London-wide network would ask for 300k;
    // 5k on a phone).
    const count = cars ?? Math.min(PHONE ? 5_000 : 50_000, Math.round(manifest.roads.km * 60));
    if (count === 0) {
      loadStep('traffic', { state: 'skipped' });
      return;
    }
    let cancelled = false;
    let layer: TrafficLayer | null = null;
    let removeHook: (() => void) | null = null;
    startTraffic(
      current.renderer,
      current.scene,
      `${import.meta.env.BASE_URL}regions/${encodeURIComponent(REGION)}/${manifest.roads.file}`,
      { count, seed: SEED },
      (message) => {
        setTrafficStatus(message);
        loadStep('traffic', {
          state: 'active',
          detail: `${count.toLocaleString()} cars · ${message.replace(/…$/, '').toLowerCase()}`,
        });
      },
    )
      .then((started) => {
        if (cancelled) {
          started.dispose();
          return;
        }
        layer = started;
        traffic.current = started;
        started.setTimeScale(TIME_SCALE);
        removeHook = current.addFrameHook((camera, height) => {
          started.frame(camera, height);
        });
        setTrafficStatus('');
        loadStep('traffic', { state: 'done' });
      })
      .catch((e: unknown) => {
        setTrafficStatus(`Traffic failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    const poll = setInterval(() => {
      setTrafficStats(traffic.current?.stats() ?? null);
    }, 500);
    return () => {
      cancelled = true;
      clearInterval(poll);
      removeHook?.();
      layer?.dispose();
      traffic.current = null;
      if (selectedRef.current?.type === 'car') select(null);
      setTrafficStats(null);
    };
  }, [viewReady, cars, loadStep, select]);

  /** Follows a person or a robot walking on a roof near the view. */
  const followSomeone = (kind: FollowKind) => {
    const layer = crowd.current;
    if (layer === null) return;
    stopFollowing();
    void layer.pickFollow(kind).then((agent) => {
      if (agent < 0) {
        const who = kind === 'robot' ? 'No robot' : 'Nobody';
        setCrowdStatus(`${who} is walking on a roof in this region.`);
        return;
      }
      setCrowdStatus('');
      layer.setFollow(agent);
      view.current?.setFollowTarget(() => layer.agentPosition(agent));
      const log: FollowLog = { agent, kind, seed: -1, lines: [], last: '' };
      followRef.current = log;
      setFollow(log);
    });
  };

  const stopFollowing = () => {
    crowd.current?.setFollow(-1);
    view.current?.setFollowTarget(null);
    followRef.current = null;
    setFollow(null);
  };
  /** Flies the camera to a place in this region, or opens the region that has it. */
  const flyToPlace = (id: string) => {
    const place = places.find((p) => p.id === id);
    if (place?.href !== undefined) {
      location.assign(place.href);
      return;
    }
    if (place?.view === undefined) return;
    stopFollowing();
    if (baseMapRef.current === null) view.current?.lookAt(place.view);
    else baseMapRef.current.flyTo(place.view, place.camera);
  };

  const changeTimeScale = (scale: number) => {
    setTimeScale(scale);
    crowd.current?.setTimeScale(scale);
    traffic.current?.setTimeScale(scale);
  };

  /**
   * Applies the layers to the scene. With 3D tiles on, the tiles stand in for the city's own
   * buildings and the base map's: those are hidden, and the transparency slider fades the tiles.
   */
  const applyLayers = (next: Layers, tiles: boolean) => {
    view.current?.setLayers(tiles ? { ...next, buildings: false } : next);
    labelsRef.current?.setVisible(next.labels);
    // The base map's own 3D buildings (outside the region) fade with the city's.
    baseMapRef.current?.setBuildingOpacity(tiles ? 0 : next.buildingOpacity);
    tilesRef.current?.setOpacity(next.buildingOpacity);
  };

  const changeLayers = (next: Layers) => {
    setLayers(next);
    layersRef.current = next;
    applyLayers(next, tilesRef.current !== null);
  };

  // 3D tiles: started over the loaded view, stopped when switched off.
  useEffect(() => {
    const current = view.current;
    const frame = frameRef.current;
    if (!viewReady || tilesMode === 'off' || current === null || frame === null) return;
    const loaded = regionRef.current;
    const zeroM = loaded?.manifest.terrain?.zeroM;
    const graph = loaded?.tile;
    const tiles = startCityTiles(current, frame, baseMapRef.current, {
      token: TILES_TOKEN,
      tileset: tilesMode,
      opacity: layersRef.current.buildingOpacity,
      ...(zeroM === undefined || graph === undefined
        ? {}
        : {
            terrain: {
              zeroM,
              // Up to 40 ground nodes within 200 m (every nth, so a dense graph stays cheap).
              points: (x: number, y: number) => {
                const near: { x: number; y: number; z: number }[] = [];
                const { nodes } = graph;
                for (let n = 0; n < nodes.x.length && near.length < 400; n++) {
                  if (nodes.level[n] !== 0) continue;
                  if (Math.abs(nodes.x[n] - x) > 200 || Math.abs(nodes.y[n] - y) > 200) continue;
                  near.push({ x: nodes.x[n], y: nodes.y[n], z: nodes.z[n] });
                }
                const step = Math.max(1, Math.floor(near.length / 40));
                return near.filter((_, i) => i % step === 0);
              },
            },
          }),
    });
    tilesRef.current = tiles;
    tilesControlRef.current?.(true);
    applyLayers(layersRef.current, true);
    const credit = setInterval(() => {
      setTilesCredit(tiles.attributions().join(' · '));
      setTilesGround(tiles.groundHeight());
    }, 1000);
    return () => {
      clearInterval(credit);
      tiles.dispose();
      tilesRef.current = null;
      tilesControlRef.current?.(false);
      setTilesCredit('');
      setTilesGround(null);
      applyLayers(layersRef.current, false);
    };
  }, [viewReady, tilesMode]);

  const changeBasemap = (next: BasemapId) => {
    setBasemap(next);
    baseMapRef.current?.setBasemap(next);
  };

  const changeProfile = (next: ProfileName) => {
    profileRef.current = next;
    setProfile(next);
    const { origin, destination } = route;
    if (origin !== null && destination !== null) requestRoute(origin, destination, next);
  };

  const randomRoute = () => {
    const tile = region?.tile;
    if (tile === undefined) return;
    const entrances: number[] = [];
    for (let n = 0; n < tile.nodes.type.length; n++)
      if (tile.nodes.type[n] === NodeType.Entrance) entrances.push(n);
    const any = () => entrances[Math.floor(Math.random() * entrances.length)] ?? 0;
    requestRoute(any(), any(), profile);
  };

  return (
    <div className="app">
      {BASEMAP !== null && <div ref={mapContainer} className="base-map" />}
      <canvas ref={canvas} className={BASEMAP === null ? 'stage' : 'stage overlay'} />
      <div ref={labelsLayer} className="building-labels" />
      {tilesMode !== 'off' && (
        <div className="tiles-credit">
          {/* Google's logo and the tiles' data credits are required with these tiles. */}
          <img
            src={`${import.meta.env.BASE_URL}attribution/google-maps-logo.svg`}
            alt="Google Maps"
          />
          <span>{tilesCredit === '' ? 'Google' : tilesCredit}</span>
        </div>
      )}
      {selected !== null && selectionDetails !== null && (
        <SelectionCard
          details={selectionDetails}
          following={selectionFollowed}
          onFollow={toggleSelectionFollow}
          onClose={() => {
            select(null);
          }}
        />
      )}
      {XR && viewReady && !xrActive && (
        <div className="xr-enter">
          <button
            type="button"
            onClick={() => {
              setXrError('');
              view.current?.onXrEnded(() => {
                setXrActive(false);
              });
              const current = view.current;
              if (current === null) return;
              // The WebGPU city where the browser can present it in XR; elsewhere (the Quest
              // Browser) a lighter WebGL city round the same simulation.
              if (hasWebgpuXr() && !XR_PREVIEW) {
                current
                  .enterXr()
                  .then(() => {
                    setXrActive(true);
                  })
                  .catch((e: unknown) => {
                    setXrError(e instanceof Error ? e.message : String(e));
                  });
                return;
              }
              enterXrCity({
                view: current,
                crowd: crowd.current,
                traffic: traffic.current,
                nodes:
                  regionRef.current?.manifest.terrain === undefined
                    ? null
                    : regionRef.current.tile.nodes,
                maxPeople: XR_PEOPLE,
                maxCars: XR_CARS,
                preview: XR_PREVIEW,
              })
                .then(({ ended }) => {
                  setXrActive(true);
                  void ended.then(() => {
                    setXrActive(false);
                  });
                })
                .catch((e: unknown) => {
                  setXrError(e instanceof Error ? e.message : String(e));
                });
            }}
          >
            Enter XR
          </button>
          <p>
            You will stand in the street at the centre of the view, among the crowd. Left
            thumbstick: walk (hold grip or trigger to go faster) · right thumbstick: turn · B: leave
            VR.
          </p>
          {xrError !== '' && <p className="xr-error">Could not enter XR: {xrError}</p>}
        </div>
      )}
      {crowdUpdating !== null && (
        <div className="crowd-updating" role="status">
          <span className="spinner" aria-hidden="true" />
          <span>
            Updating the crowd to {crowdUpdating.toLocaleString()} people and robots
            {crowdStatus !== '' && (
              <span className="crowd-updating-step"> · {crowdStatus.replace(/…$/, '')}</span>
            )}
            …
          </span>
        </div>
      )}
      {error !== null && <div className="error">{error}</div>}
      <LoadingPanel
        steps={
          agents === 0
            ? {
                ...loadSteps,
                crowd: { ...loadSteps.crowd, state: 'skipped' },
                simulation: { ...loadSteps.simulation, state: 'skipped' },
              }
            : loadSteps
        }
        title={regionTitle(REGION)}
      />
      {region !== null && (
        <Panel
          manifest={region.manifest}
          tile={region.tile}
          bytes={region.bytes}
          layers={layers}
          stats={stats}
          profile={profile}
          route={route}
          routeBreakdown={route.result === null ? null : breakdown(region, route.result)}
          onLayers={changeLayers}
          basemap={basemap}
          onBasemap={changeBasemap}
          mapView={mapView}
          tilesGround={tilesMode === 'off' ? undefined : tilesGround}
          places={places}
          onPlace={flyToPlace}
          crowd={{
            mix,
            timeScale,
            status: crowdStatus,
            stats: crowdStats,
            onMix: setMix,
            onTimeScale: changeTimeScale,
            follow,
            onFollow: followSomeone,
            onStopFollowing: stopFollowing,
          }}
          traffic={{
            cars,
            status: trafficStatus,
            stats: trafficStats,
            onCars: setCars,
          }}
          onProfile={changeProfile}
          onRandomRoute={randomRoute}
          onClearRoute={() => {
            showRoute(null, null, null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Strips of the region (tile x), one per worker, each holding as many entrances as the others:
 * every worker's agents then find destinations as densely as anyone's.
 */
function workerStrips(tile: NavTile, workers: number): { minX: number; maxX: number }[] {
  const xs: number[] = [];
  for (let n = 0; n < tile.nodes.type.length; n++)
    if (tile.nodes.type[n] === NodeType.Entrance) xs.push(tile.nodes.x[n]);
  xs.sort((a, b) => a - b);
  const cuts = Array.from({ length: workers - 1 }, (_, i) =>
    xs.length === 0 ? 0 : xs[Math.floor(((i + 1) * xs.length) / workers)],
  );
  return Array.from({ length: workers }, (_, i) => ({
    minX: i === 0 ? -Infinity : cuts[i - 1],
    maxX: i === workers - 1 ? Infinity : cuts[i],
  }));
}

/** "canary-wharf" → "Canary Wharf". */
/**
 * A tile's buildings' OSM ids, way or relation (bit 31 of `osmIdHi` marks a relation), for the base
 * map to hide its own copies of them.
 */
function buildingOsmIds(buildings: { osmIdLo: Uint32Array; osmIdHi: Uint32Array }): number[] {
  return Array.from(
    buildings.osmIdLo,
    (lo, i) => ((buildings.osmIdHi[i] ?? 0) & 0x7fffffff) * 2 ** 32 + lo,
  );
}

/** Crossings (a run of consecutive crossing edges is one) and flights of steps along a route. */
function breakdown(region: LoadedRegion, result: RouteResult) {
  const { edges } = region.tile;
  let mapped = 0;
  let implicit = 0;
  let steps = 0;
  let previous = -1;
  for (const half of result.halfEdges) {
    const e = half >>> 1;
    const type = edges.type[e];
    if (type === EdgeType.Crossing && previous !== EdgeType.Crossing) {
      if ((edges.flags[e] & EdgeFlag.Implicit) !== 0) implicit++;
      else mapped++;
    }
    if (type === EdgeType.Steps && previous !== EdgeType.Steps) steps++;
    previous = type;
  }
  return { mappedCrossings: mapped, implicitCrossings: implicit, steps };
}
