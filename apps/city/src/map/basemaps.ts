import type { StyleSpecification } from 'maplibre-gl';

/**
 * Base maps, as in the 3d-city-million-cars project: OpenFreeMap Liberty (vector), Esri World
 * Imagery with Liberty's labels, or the imagery alone. Every host sends CORS headers, which the
 * cross-origin isolated page (COEP require-corp) needs.
 */
export type BasemapId = 'vector' | 'satellite' | 'imagery';

const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
const IMAGERY_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
];
const IMAGERY_ATTRIBUTION =
  'Imagery © Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

export function isBasemapId(id: string): id is BasemapId {
  return id === 'vector' || id === 'satellite' || id === 'imagery';
}

async function fetchStyle(url: string): Promise<StyleSpecification> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`style ${url}: HTTP ${response.status}`);
  return (await response.json()) as StyleSpecification;
}

/** Label paint over imagery: white text on a dark halo. */
export const LABELS_OVER_IMAGERY = {
  'text-color': '#ffffff',
  'text-halo-color': 'rgba(0, 0, 0, 0.85)',
  'text-halo-width': 1.4,
  'text-halo-blur': 0.4,
} as const;

/** The imagery layer's id; it sits under the vector style, hidden until a basemap shows it. */
export const IMAGERY_LAYER = 'imagery';

/**
 * The style every base map starts from: OpenFreeMap Liberty with Esri imagery underneath, hidden.
 * startBaseMap then shows the requested base map, and setBasemap switches between them in place,
 * so the region outline and the city layer stay. Its OSM building extrusions stay (as in the cars
 * project, they give the city beyond the built region its skyline); startBaseMap hides them inside
 * the region, where the city draws its own buildings.
 */
export async function basemapStyle(): Promise<StyleSpecification> {
  const vector = await fetchStyle(VECTOR_STYLE);
  return {
    ...vector,
    sources: {
      ...vector.sources,
      imagery: {
        type: 'raster',
        tiles: IMAGERY_TILES,
        tileSize: 256,
        maxzoom: 19,
        attribution: IMAGERY_ATTRIBUTION,
      },
    },
    layers: [
      { id: IMAGERY_LAYER, type: 'raster', source: 'imagery', layout: { visibility: 'none' } },
      ...vector.layers,
    ],
  };
}
