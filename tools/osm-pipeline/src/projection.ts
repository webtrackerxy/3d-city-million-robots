import proj4 from 'proj4';

/**
 * WGS84 → British National Grid (EPSG:27700) with the OSGB36 Helmert shift (~1–2 m accuracy,
 * ample for pedestrian networks; OSTN15 would give centimetres). Output is metres relative to a
 * region origin, so f32 keeps millimetre precision inside a region (plan §10 stage 2).
 */
const BNG =
  '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
  '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs';
const converter = proj4('EPSG:4326', BNG);

export function toBng(lon: number, lat: number): [easting: number, northing: number] {
  const [e, n] = converter.forward([lon, lat]);
  return [e, n];
}

export function fromBng(easting: number, northing: number): [lon: number, lat: number] {
  const [lon, lat] = converter.inverse([easting, northing]);
  return [lon, lat];
}

/** Region-local frame: metres east/north of a whole-metre BNG origin. */
export class LocalFrame {
  readonly easting: number;
  readonly northing: number;

  constructor(originLon: number, originLat: number) {
    const [e, n] = toBng(originLon, originLat);
    this.easting = Math.round(e);
    this.northing = Math.round(n);
  }

  toLocal(lon: number, lat: number): [x: number, y: number] {
    const [e, n] = toBng(lon, lat);
    return [e - this.easting, n - this.northing];
  }

  toWgs84(x: number, y: number): [lon: number, lat: number] {
    return fromBng(x + this.easting, y + this.northing);
  }
}
