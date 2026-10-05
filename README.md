# Future London — million-agent city simulation

Browser-based 3D simulation of humans and humanoid robots sharing London, walking real pavements,
crossings and roofs among cars: a 20 km London region with a two-million-agent street showcase,
Central London (Buckingham Palace to Island Gardens, the public demo) and Docklands, rendered with
WebGPU over a MapLibre street map or Google Photorealistic 3D Tiles.

**Live demo:** [3d-city-million-robots.vercel.app](https://3d-city-million-robots.vercel.app)
(needs a WebGPU browser). Data, models and software credits are on its
[Credits](https://3d-city-million-robots.vercel.app/credits) page.



https://github.com/user-attachments/assets/276e1e89-9bfc-4de8-b7f9-8d8a93ed605e





## Pages

| Page                      | What it is                                                                                                            |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Map** (`/`)             | The city: people, robots and cars on the street map or Google 3D tiles; click someone to inspect and follow them      |
| **LOD test** (`/lod`)     | A character's five levels of detail side by side (the man, the woman or the Optimus robot)                            |
| **WebGL test** (`/webgl`) | 1k–50k walking Optimus robots (5k to start) in WebGL 2 only, with **Enter VR**: what a device without WebGPU can draw |
| **Credits** (`/credits`)  | The sources and licences of the map data, 3D models and software                                                      |
| **Map XR** (`/map-xr`)    | The city for a VR headset (below)                                                                                     |
| Benchmarks (`/bench`)     | The developer character benchmark (hidden from the public demo's top bar)                                             |

## XR (headsets)

**Map XR** puts you in the street among the crowd. Choose a place, press **Enter XR**, and you
stand there at your own height:

- **WebGPU headsets**: where the browser offers WebXR with WebGPU, you see the same city as on
  the desktop.
- **Meta Quest (WebGL)**: the Quest Browser offers WebXR only with WebGL, so Map XR switches to a
  lighter WebGL city around the same running simulation. You get the buildings within 700 m, the
  ground with its terrain, the nearest 300 people and robots (finer models for the nearest, e.g.
  the closest robots at about 50,000 triangles) and the nearest 60 cars.
- **Controls (Quest)**: left thumbstick walks (grip or trigger held: faster), right thumbstick
  turns 30°, **B** leaves VR. The full controller guide is in
  [`docs/map-guide.md`](docs/map-guide.md).
- `?xrPeople=` and `?xrCars=` change the counts; `?xrPreview=1` shows the WebGL headset view on a
  desktop page (WASD, Q/E, Escape).

The **WebGL test** (`/webgl`) measures what a headset can draw. It shows the city's Optimus robot,
simplified to about 2,800 triangles, walking in thousands (5,000 to start) in one instanced draw,
animated in the vertex shader, with **Enter VR**. On an M1 Pro, 5,000 robots (14.2M triangles) run
at 60 fps. More on both pages in [`docs/viewer.md`](docs/viewer.md) and
[`docs/map-guide.md`](docs/map-guide.md).

## Compared with Million Cars

[3d-city-million-cars](https://github.com/webtrackerxy/3d-city-million-cars) shows a million
vehicles on the roads of five cities. This project simulates a million people and humanoid robots
on foot in one city, London, at the level of pavements, crossings, entrances and roofs.

|                     | Million Cars                                                                                   | Million Robots                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Agents**          | Cars of one model (a Porsche)                                                                  | People and robots (a man, a woman and an Optimus robot) with skeletal animation, rigged onto one skeleton by `tools/auto-rig`; cars from Million Cars as traffic                |
| **LOD models**      | Four authored Porsche LODs (146k / 33k / 5.4k / 830 triangles) from a Blender pipeline         | Five mesh LODs per character plus impostors, simplified in the browser at load from one GLB (humans 24k → 350 triangles, the robot 120k → 750); the cars use Million Cars' four |
| **Where they move** | Road graphs, car following                                                                     | Pavement lanes, signalised crossings, entrances, and walks on roofs                                                                                                             |
| **Cities**          | London, Tokyo, New York, Hong Kong, New Delhi                                                  | London: Central London (the demo), Docklands and the 20 km London region                                                                                                        |
| **Map data**        | Per-city OSM road graphs; OSM extrusions or 3D Tiles buildings (Cesium OSM Buildings, PLATEAU) | Own OSM pipeline (`tools/osm-pipeline`) builds the walking graph, buildings and roads, with LIDAR ground heights; OpenFreeMap street map or Google Photorealistic 3D Tiles      |
| **Rendering**       | Three.js in a MapLibre custom layer (WebGL2), instanced LOD buckets                            | Three.js WebGPU (TSL compute passes) in a canvas on MapLibre's camera: Hi-Z occlusion against buildings, impostors; Map XR in a headset (WebGPU, or WebGL on the Meta Quest)    |
| **Simulation**      | Every vehicle simulated in one worker                                                          | Tiered: individually simulated agent rows plus per-building aggregates, split across `?workers=N`; cars in their own worker                                                     |
| **Interaction**     | Click a vehicle to inspect it                                                                  | Click a person, robot or car to inspect and follow it; routes between building entrances                                                                                        |
| **Networking**      | Optional WebSocket traffic server with binary frames                                           | No server of its own; everything is simulated in the browser                                                                                                                    |
| **Code**            | One Vite app (npm) and a Node traffic server                                                   | Yarn monorepo of packages and tools                                                                                                                                             |
| **Assets**          | Vehicle LODs committed to git                                                                  | One GLB per character, the car LODs and the regions, downloaded or generated locally and kept out of git                                                                        |
| **Deployed demo**   | 74.0 MB, 34 files                                                                              | 49.7 MB, 614 files (Central London instead of the 20 km London; the full build is 304 MB)                                                                                       |

## Setup

Requirements:

- Node 24+, Yarn 4 via Corepack (`corepack enable`)
- A WebGPU browser: current desktop Chrome, Edge or Safari, or Safari on iOS 26+
- For building regions: [`osmium`](https://osmcode.org/osmium-tool/) (`brew install osmium-tool`)
- For converting character models: [Blender](https://www.blender.org/)

Install, then add the assets that are not in git (models, cars, map regions):

```sh
corepack enable
yarn install

# 1. Characters: X Bot (the crowd skeleton) and the test models from three.js, then the man,
#    woman and robot rigged onto it (sources and licences on the Credits page).
base=https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/models/gltf
curl -L -o apps/city/public/models/Xbot.glb $base/Xbot.glb
curl -L -o apps/city/public/models/Soldier.glb $base/Soldier.glb
curl -L -o apps/city/public/models/RobotExpressive.glb $base/RobotExpressive/RobotExpressive.glb
# man.glb, woman.glb, optimus.glb: see docs/character-models.md

# 2. Cars: the Porsche LODs from the Million Cars project.
mkdir -p apps/city/public/vehicles/porsche
cp ../3d-city-million-cars/dist/vehicles/porsche/{car_lod?.opt.glb,manifest.json} \
  apps/city/public/vehicles/porsche/

# 3. A region: put a Geofabrik Greater London extract in data/raw/, then
yarn region --region central
yarn region --region central --roads-only --roads-bbox -0.2724,51.4182,0.0162,51.5978
yarn workspace @city/osm-pipeline labels --region central

# 4. Optional, for the Photo (Google 3D tiles) layer: a Cesium ion token.
echo 'VITE_CESIUM_ION_TOKEN=…' > apps/city/.env.local

yarn dev   # http://localhost:5173/?region=central
```

Regions (including the 20 km London built in chunks) are in [`docs/regions.md`](docs/regions.md).
The app must be served with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` (SharedArrayBuffer); Vite dev and preview already do.

## Commands

| Command                      | What it does                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `yarn dev`                   | Run the app (Vite); the map opens on London, `?region=docklands` for Docklands |
| `yarn build`                 | Production build of the app, with every region                                 |
| `yarn build:demo`            | Smaller build for the live demo                                                |
| `yarn region`                | OSM → nav tiles for a region (default `canary-wharf`)                          |
| `yarn dev:city`              | Run the city viewer (buildings + pedestrian network)                           |
| `yarn typecheck`             | `tsc -b` across all project references                                         |
| `yarn lint`                  | ESLint, including the package layering rules                                   |
| `yarn prettier-check`        | Formatting check (`yarn prettier-write` to fix)                                |
| `yarn circular-dependencies` | madge, including cycles that cross package boundaries                          |
| `yarn test`                  | Vitest unit tests for the pure packages                                        |
| `yarn check`                 | All of the above gates in sequence                                             |

## Testing

```sh
yarn check   # typecheck, lint (with package layering), formatting, circular imports, unit tests
yarn test    # Vitest unit tests only
```

Every change should pass `yarn check`. Performance is measured separately: the character
benchmark (`/bench`), the simulation benchmark and the scripted report matrix are described in
[`docs/benchmarking.md`](docs/benchmarking.md).

## Folder structure

```
packages/core-types   agent record layout, LOD ids — zero dependencies
packages/metrics      MetricsBus, GPU allocation tracker, adapter report, GPU pass timer
packages/assets-runtime  animation baker (Three.js as a sampling tool), CPU skinning reference
packages/nav          navigation graph views, synthetic street grid, A* routing and profiles
packages/formats      binary format v1 (column files) and nav tile / region manifest
packages/render       crowd renderer (Three.js + TSL): GPU crowd, character loading/baking/LODs,
                      impostors, appearance, LOD policy — shared by the benchmark and the city
packages/sim-worker   simulation worker, shared-memory records, dirty-id ring and clock
packages/buildings    roof walks and their assembly into the region graph
packages/sim          event-driven agent simulation (timing wheel, tiers, avoidance) — pure, worker-safe
packages/traffic      road traffic (from the cars project): road graph, car following, vehicle buffer
tools/sim-bench       Node worker-thread benchmark of packages/sim (plan Q8)
tools/bench-runner    Playwright benchmark matrix and Stage 0 report generator
tools/osm-pipeline    OSM → nav tiles: extract, project, pedestrian graph, buildings, pack
tools/auto-rig        rigs a humanoid GLB to the Mixamo skeleton and clips; renderpeople.py
                      converts RenderPeople FBX characters in Blender
apps/city             the app: Map (/), LOD test (/lod), Benchmarks (/bench), WebGL test (/webgl),
                      Credits (/credits), Map XR (/map-xr; src/xr-webgl: the WebGL headset city)
```

Packages are consumed as TypeScript source (`exports` → `src/index.ts`); there is no per-package
build step. Imports use explicit `.ts` extensions and erasable-only syntax (no enums, no parameter
properties), so pure packages also run directly under Node.

### Adding a package

1. Create `packages/<name>` with a `package.json` and a `tsconfig.json` extending
   `tsconfig.base.json`, and add it to the references in the root `tsconfig.json`.
2. Register it in `PACKAGE_DIRS` and `PACKAGE_LAYERS` in `eslint.config.js`, listing the packages
   it is allowed to import. Anything not listed is a lint error.

## Documentation

| Document                                                 | What it covers                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [`docs/map-guide.md`](docs/map-guide.md)                 | Using the map: moving around, places, the crowd, traffic, routes, layers, 3D tiles    |
| [`docs/system-design.md`](docs/system-design.md)         | Threads and shared memory, the frame, rendering and LOD, the simulation, the pipeline |
| [`docs/simulation.md`](docs/simulation.md)               | Running, changing and testing the simulation of people, robots and cars               |
| [`docs/crowd-and-traffic.md`](docs/crowd-and-traffic.md) | Crowd sizes, roofs and buildings, the cars                                            |
| [`docs/regions.md`](docs/regions.md)                     | Building a region with the OSM pipeline, London in chunks, terrain, roads, names      |
| [`docs/character-models.md`](docs/character-models.md)   | Preparing a human or robot model, rigging it, its levels of detail                    |
| [`docs/viewer.md`](docs/viewer.md)                       | The city viewer and the WebGL test (Optimus robots)                                   |
| [`docs/benchmarking.md`](docs/benchmarking.md)           | The benchmarks and how to run them                                                    |
