import proj4 from 'proj4';

/**
 * The region frame on the Web Mercator map. Region coordinates are metres east/north of a
 * whole-metre British National Grid origin (the manifest's `origin`), projected with the same
 * proj4 definition as the OSM pipeline. Three draws them as X = x, Y = up, Z = −y.
 *
 * Across a region of a few kilometres BNG → Mercator is an affine map to within half a metre
 * (grid convergence and scale drift are second-order), so the overlay uses one 4 × 4 matrix,
 * fitted at the origin in float64.
 */
const BNG =
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
  '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';
const converter = proj4('EPSG:4326', BNG);
/** MapLibre's earth radius, for altitude in Mercator units. */
const EARTH_RADIUS_M = 6371008.8;

const mercatorX = (lng: number) => (180 + lng) / 360;
const mercatorY = (lat: number) =>
  (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360;

export class GeoFrame {
  readonly easting: number;
  readonly northing: number;
  /** Origin in [lng, lat]. */
  readonly origin: [number, number];
  /** Column-major: Three world (metres, Y up) → Mercator [0..1] with altitude in Mercator units. */
  readonly model = new Float64Array(16);
  /** Mercator per region metre: x ← (a·x + b·y), y ← (c·x + d·y). */
  private readonly a: number;
  private readonly b: number;
  private readonly c: number;
  private readonly d: number;
  private readonly m0: [number, number];

  constructor(origin: { easting: number; northing: number }) {
    this.easting = origin.easting;
    this.northing = origin.northing;
    this.origin = this.toLngLat(0, 0);
    const h = 100;
    const at = (x: number, y: number): [number, number] => {
      const [lng, lat] = this.toLngLat(x, y);
      return [mercatorX(lng), mercatorY(lat)];
    };
    this.m0 = at(0, 0);
    const east = at(h, 0);
    const north = at(0, h);
    this.a = (east[0] - this.m0[0]) / h;
    this.c = (east[1] - this.m0[1]) / h;
    this.b = (north[0] - this.m0[0]) / h;
    this.d = (north[1] - this.m0[1]) / h;
    const up = 1 / (2 * Math.PI * EARTH_RADIUS_M * Math.cos((this.origin[1] * Math.PI) / 180));
    const m = this.model;
    // X (east) column, Y (up) column, Z (= −north) column, translation.
    // prettier-ignore
    m.set([
      this.a, this.c, 0, 0,
      0, 0, up, 0,
      -this.b, -this.d, 0, 0,
      this.m0[0], this.m0[1], 0, 1,
    ]);
  }

  toLngLat(x: number, y: number): [number, number] {
    const [lng, lat] = converter.inverse([x + this.easting, y + this.northing]);
    return [lng, lat];
  }

  toLocal(lng: number, lat: number): [number, number] {
    const [e, n] = converter.forward([lng, lat]);
    return [e - this.easting, n - this.northing];
  }
}
