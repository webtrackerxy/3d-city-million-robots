import 'maplibre-gl/dist/maplibre-gl.css';
import {
  type CustomLayerInterface,
  type CustomRenderMethodInput,
  type FilterSpecification,
  GlobeControl,
  type IControl,
  Map as MapLibreMap,
  NavigationControl,
  ScaleControl,
  setWorkerUrl,
  type SymbolLayerSpecification,
} from 'maplibre-gl';
// MapLibre resolves its worker relative to its own module, which Vite's pre-bundling moves;
// `?worker&url` bundles the worker with its shared chunk and gives its URL.
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import { Matrix4, type PerspectiveCamera, Vector3, Vector4 } from 'three';
import { PHONE } from '../device.ts';
import type { MapCameraView } from './places.ts';
import { basemapStyle, type BasemapId, IMAGERY_LAYER, LABELS_OVER_IMAGERY } from './basemaps.ts';
import type { GeoFrame } from './geo-frame.ts';

setWorkerUrl(maplibreWorkerUrl);

/** The map's camera for the city overlay, in Three world coordinates (metres, Y up). */
export interface MapCamera {
  /** World → WebGPU clip space (z in [0, 1]). */
  viewProjection: Matrix4;
  eye: Vector3;
  /** Vertical field of view, degrees. */
  fovDeg: number;
  /**
   * False while the map is (partly) a globe: the overlay's flat Mercator frame would not line up,
   * so it is hidden; the region outline marks the city instead.
   */
  visible: boolean;
}

export interface BaseMap {
  readonly map: MapLibreMap;
  readonly frame: GeoFrame;
  /** Draws the overlay; called inside every map frame, so both canvases show the same camera. */
  setDraw(draw: ((camera: MapCamera) => void) | null): void;
  /** Map centre in the region frame (metres). */
  centre(): [number, number];
  setCentre(x: number, y: number): void;
  /** Clicks on the map (not drags): the ground point in the region frame, and the screen point. */
  onClick(handler: (x: number, y: number, screen: { x: number; y: number }) => void): void;
  /**
   * The OSM ids of the buildings the city draws itself: the base map's 3D buildings with those ids
   * are hidden, and every other one is shown (outside the region, and where the city has none).
   */
  setOwnBuildings(osmIds: ReadonlySet<number>): void;
  /** Switches the map type in place (the region outline and the city layer stay). */
  setBasemap(basemap: BasemapId): void;
  /** Opacity of the base map's own 3D buildings (outside the region), 0–1. */
  setBuildingOpacity(opacity: number): void;
  /** Flies the camera to a view (region frame), facing north, or to an exact camera. */
  flyTo(view: BaseMapOptions['view'], camera?: MapCameraView): void;
  /**
   * Sets a plain perspective camera (region frame, Three axes) to MapLibre's current pose:
   * position, look-at centre and field of view. For code that needs a conventional camera; the
   * overlay's own camera keeps the rotation in its projection matrix.
   */
  poseCamera(camera: PerspectiveCamera, aspect: number): void;
  /**
   * Adds the buildings switch to the map controls: OSM (the city's own buildings) or Photo
   * (photorealistic 3D tiles). Returns a setter that keeps the buttons in step with the app.
   */
  addTilesControl(onChange: (photorealistic: boolean) => void): (photorealistic: boolean) => void;
  dispose(): void;
}

export interface BaseMapOptions {
  basemap: BasemapId;
  frame: GeoFrame;
  /** Region outline (region-frame metres), drawn by MapLibre so it shows on the globe too. */
  outline: [number, number][];
  title: string;
  /** Start view: looking at (x, y) from `height` metres up and `distance` metres south. */
  view: { x: number; y: number; height: number; distance: number };
  /** An exact start camera instead of `view` (a place's hand-picked view). */
  camera?: MapCameraView | undefined;
}

const LABEL_KEYS = Object.keys(LABELS_OVER_IMAGERY) as (keyof typeof LABELS_OVER_IMAGERY)[];

/** Depth scale for the overlay's projection: below 1 / (1 + near / far), the far plane is gone. */
const FAR_DEPTH_SCALE = 0.9;
/** MapLibre's default vertical field of view. */
const MAP_FOV_DEG = 36.87;
/** The orbit view's field of view (city-view), which `?at=` views were chosen with. */
const ORBIT_FOV_DEG = 50;
const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/**
 * MapLibre base map (OpenFreeMap Liberty or Esri imagery) on a globe, under the WebGPU city
 * canvas. WebGPU cannot draw into MapLibre's WebGL context, so a no-op custom layer reads the
 * map's float64 Mercator view-projection each frame and hands the overlay a camera for it.
 */
export async function startBaseMap(
  container: HTMLElement,
  options: BaseMapOptions,
): Promise<BaseMap> {
  const { frame, view } = options;
  /** The map camera for a view (x, y, height, distance) at the container's current size. */
  const cameraFor = (v: BaseMapOptions['view']) => {
    const [lng, lat] = frame.toLngLat(v.x, v.y);
    // Back off so the view frames what the orbit camera's 50° lens showed from `v`.
    const range =
      Math.max(20, Math.hypot(v.height, v.distance)) *
      (Math.tan((ORBIT_FOV_DEG * Math.PI) / 360) / Math.tan((MAP_FOV_DEG * Math.PI) / 360));
    const pitch = Math.min(80, (Math.atan2(v.distance, v.height) * 180) / Math.PI);
    // Camera-to-centre distance is (viewport height / 2) / tan(fov / 2) pixels.
    const halfHeightPx = Math.max(1, container.clientHeight) / 2;
    const metresPerPixel = range / (halfHeightPx / Math.tan((MAP_FOV_DEG * Math.PI) / 360));
    const zoom = Math.log2(
      (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / (512 * metresPerPixel),
    );
    return { center: [lng, lat] as [number, number], zoom, pitch };
  };
  const start =
    options.camera === undefined
      ? { ...cameraFor(view), bearing: 0 }
      : {
          center: [options.camera.lng, options.camera.lat] as [number, number],
          zoom: options.camera.zoom,
          pitch: options.camera.pitch,
          bearing: options.camera.bearing,
        };
  const {
    center: [lng, lat],
    zoom,
    pitch,
    bearing,
  } = start;

  const map = new MapLibreMap({
    container,
    style: await basemapStyle(),
    center: [lng, lat],
    zoom,
    pitch,
    bearing,
    maxPitch: 80,
    attributionControl: { compact: true },
    // A phone's 3× screen would triple the map's buffers again: 2× and no MSAA there.
    canvasContextAttributes: { antialias: !PHONE },
    ...(PHONE ? { pixelRatio: Math.min(devicePixelRatio, 2) } : {}),
  });
  map.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new GlobeControl(), 'top-right');
  map.addControl(new ViewControl(), 'top-right');
  map.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');

  let draw: ((camera: MapCamera) => void) | null = null;
  const vp = new Matrix4();
  const model = new Matrix4().fromArray(frame.model);
  const camera: MapCamera = {
    viewProjection: new Matrix4(),
    eye: new Vector3(),
    fovDeg: MAP_FOV_DEG,
    visible: false,
  };
  const eye4 = new Vector4();
  const inverse = new Matrix4();
  const overlay: CustomLayerInterface = {
    id: 'city-overlay',
    type: 'custom',
    renderingMode: '3d',
    render(_gl, input: CustomRenderMethodInput) {
      const data = input.defaultProjectionData;
      camera.visible = !(data.projectionTransition > 0);
      // Mercator [0..1] → GL clip, times region → Mercator; Three's Matrix4 keeps float64.
      vp.fromArray(data.mainMatrix).multiply(model);
      eye4.set(0, 0, 1, 0).applyMatrix4(inverse.copy(vp).invert());
      camera.eye.set(eye4.x / eye4.w, eye4.y / eye4.w, eye4.z / eye4.w);
      // GL clip z ∈ [−w, w] → WebGPU z ∈ [0, w]: z' = (z + w) / 2, times FAR_DEPTH_SCALE. MapLibre
      // puts its far plane just past its own flat ground, so anything below that (the
      // photorealistic tiles' ground, a little lower) was cut off where the view is farthest;
      // scaling depth by just under 1 keeps the near plane and moves the far one to infinity.
      const e = camera.viewProjection.copy(vp).elements;
      for (let c = 0; c < 4; c++)
        e[c * 4 + 2] = FAR_DEPTH_SCALE * 0.5 * (e[c * 4 + 2] + e[c * 4 + 3]);
      camera.fovDeg =
        ((input.fov > Math.PI ? (input.fov * Math.PI) / 180 : input.fov) * 180) / Math.PI;
      draw?.(camera);
      // The crowd moves every frame.
      map.triggerRepaint();
    },
  };

  /** fill-extrusion layers and their own filters. */
  const extrusions = new Map<string, FilterSpecification | null | undefined>();
  /** The vector style's ground layers (hidden over imagery), and its labels' own paint. */
  const groundLayers: string[] = [];
  const labelPaint = new Map<string, SymbolLayerSpecification['paint']>();
  const setBasemap = (basemap: BasemapId) => {
    const imagery = basemap !== 'vector';
    map.setLayoutProperty(IMAGERY_LAYER, 'visibility', imagery ? 'visible' : 'none');
    for (const id of groundLayers)
      map.setLayoutProperty(id, 'visibility', imagery ? 'none' : 'visible');
    for (const [id, own] of labelPaint) {
      map.setLayoutProperty(id, 'visibility', basemap === 'imagery' ? 'none' : 'visible');
      for (const key of LABEL_KEYS)
        map.setPaintProperty(id, key, imagery ? LABELS_OVER_IMAGERY[key] : own?.[key]);
    }
  };
  // A `within` filter cannot do this: MapLibre evaluates it for points and lines only, so every
  // building polygon passed. OpenMapTiles feature ids are the OSM id × 10 plus a type digit.
  const setOwnBuildings = (osmIds: ReadonlySet<number>) => {
    const notOwn =
      osmIds.size === 0
        ? null
        : ([
            'match',
            ['floor', ['/', ['id'], 10]],
            [...osmIds],
            false,
            true,
          ] as unknown as FilterSpecification);
    for (const [id, own] of extrusions) {
      const filter = notOwn === null ? own : own == null ? notOwn : ['all', own, notOwn];
      map.setFilter(id, (filter ?? null) as FilterSpecification | null, { validate: false });
    }
  };
  const [cx, cy] = [
    options.outline.reduce((s, p) => s + p[0], 0) / options.outline.length,
    options.outline.reduce((s, p) => s + p[1], 0) / options.outline.length,
  ];
  await new Promise<void>((resolve) => {
    map.once('style.load', () => {
      map.setProjection({ type: 'globe' });
      map.setSky({
        'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
      });
      const ring = [...options.outline, options.outline[0] ?? [0, 0]].map(([x, y]) =>
        frame.toLngLat(x, y),
      );
      map.addSource('city-region', {
        type: 'geojson',
        data: {
          type: 'FeatureCollection',
          features: [
            {
              type: 'Feature',
              properties: {},
              geometry: { type: 'Polygon', coordinates: [ring] },
            },
            {
              type: 'Feature',
              properties: { title: options.title },
              geometry: { type: 'Point', coordinates: frame.toLngLat(cx, cy) },
            },
          ],
        },
      });
      map.addLayer({
        id: 'city-region-fill',
        type: 'fill',
        source: 'city-region',
        maxzoom: 13,
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': '#4dd9e6', 'fill-opacity': 0.25 },
      });
      map.addLayer({
        id: 'city-region-line',
        type: 'line',
        source: 'city-region',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'line-color': '#4dd9e6', 'line-width': 2 },
      });
      map.addLayer({
        id: 'city-region-label',
        type: 'symbol',
        source: 'city-region',
        maxzoom: 12,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: {
          'text-field': ['get', 'title'],
          'text-font': ['Noto Sans Bold'],
          'text-size': 15,
          'text-offset': [0, 1.4],
        },
        paint: {
          'text-color': '#ffffff',
          'text-halo-color': 'rgba(0, 0, 0, 0.8)',
          'text-halo-width': 1.5,
        },
      });
      for (const layer of map.getStyle().layers) {
        if (layer.id === IMAGERY_LAYER || layer.id.startsWith('city-region')) continue;
        if (layer.type === 'fill-extrusion')
          extrusions.set(layer.id, map.getFilter(layer.id) as FilterSpecification | undefined);
        else if (layer.type === 'symbol') {
          if (layer.layout?.['text-field'] === undefined) continue;
          labelPaint.set(layer.id, layer.paint);
        } else groundLayers.push(layer.id);
      }
      setBasemap(options.basemap);
      map.addLayer(overlay);
      resolve();
    });
  });

  return {
    map,
    frame,
    flyTo(next, camera) {
      map.flyTo({
        ...(camera === undefined
          ? { ...cameraFor(next), bearing: 0 }
          : {
              center: [camera.lng, camera.lat] as [number, number],
              zoom: camera.zoom,
              pitch: camera.pitch,
              bearing: camera.bearing,
            }),
        duration: 3000,
        essential: true,
      });
    },
    poseCamera(camera, aspect) {
      // From public state only: the camera sits (viewport height / 2) / tan(fov / 2) pixels
      // from the centre, back along the heading and up by the pitch (cameraFor in reverse).
      const centre = map.getCenter();
      const [tx, ty] = frame.toLocal(centre.lng, centre.lat);
      const metresPerPixel =
        (EARTH_CIRCUMFERENCE_M * Math.cos((centre.lat * Math.PI) / 180)) /
        (512 * 2 ** map.getZoom());
      const halfFov = (MAP_FOV_DEG * Math.PI) / 360;
      const distance =
        (Math.max(1, container.clientHeight) / 2 / Math.tan(halfFov)) * metresPerPixel;
      const pitch = (map.getPitch() * Math.PI) / 180;
      const bearing = (map.getBearing() * Math.PI) / 180;
      // Heading on the ground in Three axes (north is −Z).
      const hx = Math.sin(bearing);
      const hz = -Math.cos(bearing);
      const back = distance * Math.sin(pitch);
      camera.fov = MAP_FOV_DEG;
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
      camera.position.set(tx - hx * back, distance * Math.cos(pitch), -ty - hz * back);
      // No roll: world up, except looking straight down, where the heading is up.
      if (map.getPitch() < 1) camera.up.set(hx, 0, hz);
      else camera.up.set(0, 1, 0);
      camera.lookAt(tx, 0, -ty);
    },
    addTilesControl(onChange) {
      const control = new TilesControl(onChange);
      map.addControl(control, 'top-right');
      return (photorealistic) => {
        control.set(photorealistic);
      };
    },
    setBasemap,
    setBuildingOpacity(opacity) {
      for (const id of extrusions.keys())
        map.setPaintProperty(id, 'fill-extrusion-opacity', opacity);
    },
    setDraw(next) {
      draw = next;
      map.triggerRepaint();
    },
    centre() {
      const c = map.getCenter();
      return frame.toLocal(c.lng, c.lat);
    },
    setCentre(x, y) {
      // Not while the user drags or an ease runs: they own the camera then.
      if (!map.isMoving()) map.setCenter(frame.toLngLat(x, y));
    },
    setOwnBuildings,
    onClick(handler) {
      map.on('click', (e) => {
        const [x, y] = frame.toLocal(e.lngLat.lng, e.lngLat.lat);
        handler(x, y, { x: e.point.x, y: e.point.y });
      });
    },
    dispose() {
      draw = null;
      map.remove();
    },
  };
}

const NORTH_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 2.5 16 13 12 11 8 13Z" fill="#d6423a"/><path d="M9 21.5v-6.5l6 6.5v-6.5" fill="none" stroke="#333" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/></svg>';
const TOP_DOWN_ICON =
  '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="#333" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5v8M8.5 7.5 12 11l3.5-3.5"/><rect x="4.5" y="14" width="15" height="7" rx="1"/><path d="M4.5 14 19.5 21M19.5 14 4.5 21" stroke-width="1" opacity="0.5"/></svg>';

/**
 * Two view buttons under the zoom and globe controls: face north (keeping the tilt), and look
 * straight down at a right angle to the ground (again: back to the tilt it had).
 */
/** OSM / Photo: which buildings the map shows (the city's own, or photorealistic 3D tiles). */
class TilesControl implements IControl {
  private container: HTMLElement | null = null;
  private readonly buttons: { osm: HTMLButtonElement; photo: HTMLButtonElement };
  private readonly onChange: (photorealistic: boolean) => void;
  private photorealistic = false;

  constructor(onChange: (photorealistic: boolean) => void) {
    this.onChange = onChange;
    const make = (label: string, title: string, photorealistic: boolean) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = label;
      element.title = title;
      element.setAttribute('aria-label', title);
      element.className = 'tiles-control-button';
      element.addEventListener('click', () => {
        this.set(photorealistic);
        this.onChange(photorealistic);
      });
      return element;
    };
    this.buttons = {
      osm: make('OSM', 'Buildings from OpenStreetMap', false),
      photo: make('Photo', 'Photorealistic 3D tiles', true),
    };
  }

  set(photorealistic: boolean): void {
    this.photorealistic = photorealistic;
    this.buttons.osm.setAttribute('aria-pressed', String(!photorealistic));
    this.buttons.photo.setAttribute('aria-pressed', String(photorealistic));
  }

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group tiles-control';
    container.setAttribute('role', 'group');
    container.setAttribute('aria-label', 'Buildings');
    container.append(this.buttons.osm, this.buttons.photo);
    this.set(this.photorealistic);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}

class ViewControl implements IControl {
  private container: HTMLElement | null = null;

  onAdd(map: MapLibreMap): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    let tilt = 60;
    const button = (title: string, icon: string, onClick: () => void) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.title = title;
      element.setAttribute('aria-label', title);
      element.innerHTML = icon;
      element.style.display = 'grid';
      element.style.placeItems = 'center';
      element.addEventListener('click', onClick);
      container.append(element);
      return element;
    };
    button('Face north', NORTH_ICON, () => {
      map.easeTo({ bearing: 0, duration: 600 });
    });
    const topDown = button('Look straight down', TOP_DOWN_ICON, () => {
      if (map.getPitch() > 1) {
        tilt = map.getPitch();
        map.easeTo({ pitch: 0, duration: 600 });
      } else map.easeTo({ pitch: tilt, duration: 600 });
    });
    const sync = () => {
      topDown.title = map.getPitch() > 1 ? 'Look straight down' : 'Tilt the view back';
      topDown.setAttribute('aria-label', topDown.title);
      topDown.setAttribute('aria-pressed', String(map.getPitch() <= 1));
    };
    map.on('pitchend', sync);
    sync();
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}
