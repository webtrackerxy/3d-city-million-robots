import type { RegionManifest } from '@city/formats';
import { GeoFrame } from './geo-frame.ts';

/** An exact base-map camera: centre, zoom, tilt from straight down and heading, in degrees. */
export interface MapCameraView {
  lat: number;
  lng: number;
  zoom: number;
  pitch: number;
  bearing: number;
}

/**
 * A place the camera can fly to (panel Places, `?place=<id>`). Without a `camera` it is shown
 * close, facing north; a `camera` pins a hand-picked view (copy one with the panel's Copy view).
 */
export interface Place {
  id: string;
  name: string;
  lat: number;
  lng: number;
  camera?: MapCameraView;
}

/** A start or fly-to view: looking at (x, y) from `height` metres up and `distance` metres south. */
export interface PlaceView {
  x: number;
  y: number;
  height: number;
  distance: number;
}

/**
 * Every place is in the London and central regions; Docklands holds Canary Wharf and Island Gardens.
 */
export const PLACES: readonly Place[] = [
  { id: 'trafalgar-square', name: 'Trafalgar Square', lat: 51.508, lng: -0.1281 },
  {
    id: 'canary-wharf',
    name: 'Canary Wharf',
    lat: 51.503764,
    lng: -0.019779,
    // Hand-picked: over Canada Square, looking south-east.
    camera: { lat: 51.503764, lng: -0.019779, zoom: 19.98, pitch: 68, bearing: 145.2 },
  },
  {
    id: 'buckingham-palace',
    name: 'Buckingham Palace',
    lat: 51.50207,
    lng: -0.140095,
    // Hand-picked: by the Victoria Memorial, looking south-west across to the Palace.
    camera: { lat: 51.50207, lng: -0.140095, zoom: 19.25, pitch: 73, bearing: -150.6 },
  },
  {
    id: 'island-gardens',
    name: 'Island Gardens',
    lat: 51.487922,
    lng: -0.009739,
    // Hand-picked: low over Manchester Road by the station, looking north-north-east.
    camera: { lat: 51.487922, lng: -0.009739, zoom: 20.51, pitch: 78.4, bearing: 20.3 },
  },
];

/**
 * How close a place is shown: the London showcase's start (60 m up, 110 m back), which the base
 * map opens at about zoom 18.4 with a 61° tilt, where people and robots are large enough to see.
 */
const CLOSE = { height: 60, distance: 110 };

/** The view of a place in a region's frame, or undefined if the region has no tile there. */
export function placeView(place: Place, manifest: RegionManifest): PlaceView | undefined {
  const [x, y] = new GeoFrame(manifest.origin).toLocal(place.lng, place.lat);
  const tx = Math.floor((x - manifest.gridOrigin.x) / manifest.tileSizeM);
  const ty = Math.floor((y - manifest.gridOrigin.y) / manifest.tileSizeM);
  if (!manifest.tiles.some((t) => t.x === tx && t.y === ty)) return undefined;
  return { x, y, ...CLOSE };
}

/** The places inside a region, with their views. */
export function placesIn(manifest: RegionManifest): { place: Place; view: PlaceView }[] {
  return PLACES.flatMap((place) => {
    const view = placeView(place, manifest);
    return view === undefined ? [] : [{ place, view }];
  });
}
