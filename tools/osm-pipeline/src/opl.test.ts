import proj4 from 'proj4';
import { describe, expect, it } from 'vitest';
import { parseOpl, unescapeOpl } from './opl.ts';
import { LocalFrame, toBng } from './projection.ts';

describe('parseOpl', () => {
  it('reads nodes, ways and relations with tags and members', () => {
    const data = parseOpl(
      [
        'n1 v1 dV c0 t2020-01-01T00:00:00Z i0 u T x-0.0200000 y51.5050000',
        'n2 v1 dV c0 t2020-01-01T00:00:00Z i0 u Tentrance=main,name=One%20%Canada%20%Square x-0.0190000 y51.5051000',
        'w10 v2 dV c0 t2020-01-01T00:00:00Z i0 u Thighway=footway,footway=sidewalk Nn1,n2',
        'r20 v1 dV c0 t2020-01-01T00:00:00Z i0 u Ttype=multipolygon,building=yes Mw10@outer,w11@inner',
      ].join('\n'),
    );
    expect(data.nodes.get(1)).toEqual({ id: 1, lon: -0.02, lat: 51.505, tags: {} });
    expect(data.nodes.get(2)?.tags).toEqual({ entrance: 'main', name: 'One Canada Square' });
    expect(data.ways.get(10)).toEqual({
      id: 10,
      tags: { highway: 'footway', footway: 'sidewalk' },
      refs: [1, 2],
    });
    expect(data.relations.get(20)?.members).toEqual([
      { type: 'w', ref: 10, role: 'outer' },
      { type: 'w', ref: 11, role: 'inner' },
    ]);
  });

  it('unescapes %hex% sequences, including commas and equals signs', () => {
    expect(unescapeOpl('a%2c%b%3d%c%20%d')).toBe('a,b=c d');
  });
});

describe('projection', () => {
  it('projects the Ordnance Survey worked example exactly (OSGB36 lat/lon → grid)', () => {
    // "A guide to coordinate systems in Great Britain", Annex C: 52°39'27.2531"N 1°43'4.5177"E
    // on the Airy 1830 ellipsoid → E 651409.903, N 313177.270.
    const airy = proj4(
      '+proj=longlat +ellps=airy +no_defs',
      '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs',
    );
    const lat = 52 + 39 / 60 + 27.2531 / 3600;
    const lon = 1 + 43 / 60 + 4.5177 / 3600;
    const [e, n] = airy.forward([lon, lat]);
    expect(e).toBeCloseTo(651409.903, 2);
    expect(n).toBeCloseTo(313177.27, 2);
  });

  it('applies the WGS84 → OSGB36 datum shift (~100 m in London)', () => {
    const noShift = proj4(
      'EPSG:4326',
      '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +units=m +no_defs',
    );
    const [e0, n0] = noShift.forward([-0.0195, 51.505]);
    const [e, n] = toBng(-0.0195, 51.505);
    const shift = Math.hypot(e - e0, n - n0);
    expect(shift).toBeGreaterThan(50);
    expect(shift).toBeLessThan(150);
  });

  it('round-trips through the local frame to millimetres', () => {
    const frame = new LocalFrame(-0.0235, 51.5054);
    const [x, y] = frame.toLocal(-0.0151, 51.5102);
    const [lon, lat] = frame.toWgs84(x, y);
    // proj4's inverse is iterative: ~1e-8° (1 mm).
    expect(Math.abs(lon - -0.0151)).toBeLessThan(1e-7);
    expect(Math.abs(lat - 51.5102)).toBeLessThan(1e-7);
    expect(x).toBeGreaterThan(500);
    expect(y).toBeGreaterThan(400);
  });
});
