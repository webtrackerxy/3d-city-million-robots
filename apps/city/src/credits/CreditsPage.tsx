import type { ReactNode } from 'react';

export const GITHUB_URL = 'https://github.com/webtrackerxy/3d-city-million-robots';

interface Credit {
  what: string;
  name: ReactNode;
  licence: ReactNode;
  note?: ReactNode;
}

const CC_BY = <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>;

const MAP_DATA: Credit[] = [
  {
    what: 'Streets, paths, buildings and names',
    name: (
      <>
        <a href="https://www.openstreetmap.org/copyright">© OpenStreetMap contributors</a>, Greater
        London extract by{' '}
        <a href="https://download.geofabrik.de/europe/united-kingdom/england/greater-london.html">
          Geofabrik
        </a>
      </>
    ),
    licence: <a href="https://opendatacommons.org/licenses/odbl/">ODbL 1.0</a>,
    note: 'Built into the walking graph, the buildings, the road network and the building names by this project’s pipeline.',
  },
  {
    what: 'Street map (OSM)',
    name: (
      <>
        <a href="https://openfreemap.org">OpenFreeMap</a> Liberty style,{' '}
        <a href="https://openmaptiles.org">© OpenMapTiles</a>, data © OpenStreetMap contributors
      </>
    ),
    licence: (
      <>
        Style and schema{' '}
        <a href="https://github.com/openmaptiles/openmaptiles/blob/master/LICENSE.md">
          BSD / CC BY 4.0
        </a>
        , data ODbL
      </>
    ),
  },
  {
    what: 'Satellite map',
    name: (
      <>
        <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">
          Esri World Imagery
        </a>
        : Esri, Maxar, Earthstar Geographics and the GIS User Community
      </>
    ),
    licence: (
      <a href="https://www.esri.com/en-us/legal/terms/full-master-agreement">Esri terms of use</a>
    ),
  },
  {
    what: 'Photorealistic 3D (Photo)',
    name: (
      <>
        <a href="https://developers.google.com/maps/documentation/tile/3d-tiles">
          Google Photorealistic 3D Tiles
        </a>{' '}
        via <a href="https://cesium.com/platform/cesium-ion/">Cesium ion</a>; the imagery providers
        are listed on the map while it is shown
      </>
    ),
    licence: (
      <>
        <a href="https://cloud.google.com/maps-platform/terms">Google Maps Platform terms</a>
      </>
    ),
  },
  {
    what: 'Ground heights',
    name: (
      <>
        <a href="https://environment.data.gov.uk/dataset/13787b9a-26a4-4775-8523-806d13af58fc">
          Environment Agency LIDAR Composite DTM 1 m
        </a>
        , © Environment Agency copyright and/or database right
      </>
    ),
    licence: (
      <a href="https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/">
        Open Government Licence v3.0
      </a>
    ),
  },
];

const MODELS: Credit[] = [
  {
    what: 'Man',
    name: (
      <>
        <a href="https://sketchfab.com/3d-models/cool-man-ad14b71697dd4ea7836c1f06c75e5f72">
          Cool Man
        </a>{' '}
        by <a href="https://sketchfab.com/ardhanaputra">ardhanaputra</a>
      </>
    ),
    licence: CC_BY,
    note: 'Modified: re-rigged to the crowd skeleton, levels of detail.',
  },
  {
    what: 'Woman',
    name: (
      <>
        <a href="https://sketchfab.com/3d-models/invisible-womantexturedrigged-031e16a761b64814a30f0cc888ac7aff">
          Invisible Woman (Textured)(Rigged)
        </a>{' '}
        by <a href="https://sketchfab.com/CAPTAAINR">CAPTAAINR</a>
      </>
    ),
    licence: CC_BY,
    note: 'Modified: re-rigged to the crowd skeleton, levels of detail.',
  },
  {
    what: 'Robot',
    name: (
      <>
        <a href="https://sketchfab.com/3d-models/tesla-optimus-2fab5d31927f43729a99a6e8eaf1c7f5">
          Tesla optimus
        </a>{' '}
        by <a href="https://sketchfab.com/jjeendral36">Mechamaner.V</a>
      </>
    ),
    licence: CC_BY,
    note: 'Modified: rigged to the crowd skeleton, levels of detail. Tesla and Optimus are trademarks of Tesla, Inc.',
  },
  {
    what: 'Crowd skeleton and animations; LOD test models',
    name: (
      <>
        X Bot and Soldier from <a href="https://www.mixamo.com">Mixamo</a>, RobotExpressive by{' '}
        <a href="https://www.patreon.com/quaternius">Tomás Laulhé</a>, all from the{' '}
        <a href="https://github.com/mrdoob/three.js/tree/r186/examples/models/gltf">
          three.js examples
        </a>
      </>
    ),
    licence: (
      <>
        Mixamo (Adobe) terms; RobotExpressive{' '}
        <a href="https://creativecommons.org/publicdomain/zero/1.0/">CC0</a>
      </>
    ),
  },
  {
    what: 'Car',
    name: (
      <>
        <a href="https://sketchfab.com/3d-models/free-porsche-911-carrera-4s-d01b254483794de3819786d93e0e1ebf">
          Porsche 911 Carrera 4S
        </a>{' '}
        by <a href="https://sketchfab.com/Lionsharp">Lionsharp Studios</a>
      </>
    ),
    licence: CC_BY,
    note: (
      <>
        Modified: simplified into levels of detail by the{' '}
        <a href="https://github.com/webtrackerxy/3d-city-million-cars">3d-city-million-cars</a>{' '}
        project. Porsche is a trademark of Dr. Ing. h.c. F. Porsche AG.
      </>
    ),
  },
];

const SOFTWARE: Credit[] = [
  { what: 'WebGPU rendering', name: <a href="https://threejs.org">three.js</a>, licence: 'MIT' },
  {
    what: 'Base map',
    name: <a href="https://maplibre.org">MapLibre GL JS</a>,
    licence: 'BSD-3-Clause',
  },
  {
    what: '3D Tiles',
    name: <a href="https://github.com/NASA-AMMOS/3DTilesRendererJS">3DTilesRendererJS</a>,
    licence: 'Apache-2.0',
  },
  {
    what: 'Compressed meshes and textures',
    name: (
      <>
        <a href="https://github.com/google/draco">Draco</a>,{' '}
        <a href="https://github.com/BinomialLLC/basis_universal">Basis Universal</a>,{' '}
        <a href="https://github.com/zeux/meshoptimizer">meshoptimizer</a>
      </>
    ),
    licence: 'Apache-2.0, Apache-2.0, MIT',
  },
  {
    what: 'Coordinates',
    name: <a href="https://proj4js.github.io/proj4js/">proj4js</a>,
    licence: 'MIT',
  },
  {
    what: 'Interface',
    name: (
      <>
        <a href="https://react.dev">React</a>, <a href="https://reactrouter.com">React Router</a>
      </>
    ),
    licence: 'MIT',
  },
  {
    what: 'OSM processing (build time)',
    name: <a href="https://osmcode.org/osmium-tool/">Osmium</a>,
    licence: 'GPL-3.0',
  },
];

function Section({ title, rows }: { title: string; rows: Credit[] }) {
  return (
    <section>
      <h2>{title}</h2>
      <table>
        <tbody>
          {rows.map((r) => (
            <tr key={r.what}>
              <th>{r.what}</th>
              <td>
                {r.name}
                {r.note !== undefined && <div className="credits-note">{r.note}</div>}
              </td>
              <td className="credits-licence">{r.licence}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** Where everything on the site comes from: the map data, the 3D models and the software. */
export function CreditsPage() {
  return (
    <div className="credits">
      <div className="credits-body">
        <h1>Credits and sources</h1>
        <p>
          Million Robots is a browser simulation of people and humanoid robots sharing London. The
          code is on <a href={GITHUB_URL}>GitHub</a>. It is built on the open data, models and
          software below; thank you to everyone who made them.
        </p>
        <Section title="Map data" rows={MAP_DATA} />
        <Section title="3D models" rows={MODELS} />
        <Section title="Software" rows={SOFTWARE} />
      </div>
    </div>
  );
}
