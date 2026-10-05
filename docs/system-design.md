# System design

How Future London simulates and draws a million people and humanoid robots in a browser: the
threads and shared memory, the frame, the crowd renderer and its levels of detail, the simulation,
the offline map pipeline, and how it is built, deployed and measured. File paths are relative to
the repository root.

## 1. Goals and constraints

- **Scale.** A million agents in the region, people and robots, each walking a real route on
  London's pavements, crossings and building entrances; a two-million-agent street showcase.
- **Browser only.** No server at run time: static files, WebGPU for drawing and GPU compute,
  Web Workers for simulation. The page must be cross-origin isolated (COOP `same-origin`, COEP
  `require-corp`) so the workers and the render thread can share memory (`SharedArrayBuffer`).
- **The main thread stays light.** It drains changes, uploads them and records GPU work; it never
  touches every agent per frame. Per-agent work happens in the workers (simulation) or on the GPU
  (motion between events, culling, level of detail, animation).
- **Determinism.** A seed and a worker count give the same run: integer milliseconds, a fixed
  tick, per-agent random streams, no `Math.random` or wall clock in the simulation.
- **Open data.** OpenStreetMap is the only map source for the city; the base map is OpenFreeMap
  (vector) or Esri World Imagery (satellite).

## 2. Architecture at a glance

```
 offline                                     browser
 ───────                                     ───────
 OSM extract (data/raw)                      main thread                       workers
   │ osmium + tools/osm-pipeline             ┌───────────────────────────┐    ┌──────────────────┐
   ▼                                         │ React UI (panel, pages)   │    │ sim worker × N   │
 apps/city/public/regions/<region>/          │ MapLibre base map (WebGL) │    │ CitySimulation   │
   manifest.json                             │ WebGPU overlay canvas     │◄──►│ (one strip each) │
   tile_x_y.nav  (256 m tiles)   ──fetch──►  │  ├ buildings (per tile)   │SAB │ barrier per tick │
   region.nav    (London graph)              │  ├ GPU crowd  (compute)   │    ├──────────────────┤
   roads.bin     (drivable roads)            │  └ GPU traffic (compute)  │◄──►│ traffic worker   │
 apps/city/public/models, vehicles           └───────────────────────────┘    └──────────────────┘
   (rigged characters, car LODs)                         ▲ draws indirect, one call per bucket
                                                         │
                                                       GPU
```

- The **simulation** owns agent state. It writes each agent's 24-byte record into shared memory
  only when the agent's motion changes (an _event_), and posts the agent's id on a ring.
- The **render thread** drains those ids every frame and uploads just the changed records. The
  GPU dead-reckons every agent between events, culls them, picks a level of detail and draws them
  with indirect draws, so the CPU cost does not grow with the number of agents on screen.
- **Cars** run in their own worker at 10 Hz; the GPU interpolates between the last two snapshots.

## 3. Runtime components

| Thread     | Code                                      | Responsibility                                                   |
| ---------- | ----------------------------------------- | ---------------------------------------------------------------- |
| Main       | `apps/city/src/MapPage.tsx`, `ui/`        | Loading, URL parameters, the panel, routing clicks               |
| Main       | `apps/city/src/map/base-map.ts`           | MapLibre globe base map; drives the frame from its draw callback |
| Main       | `apps/city/src/scene/city-view.ts`        | WebGPU renderer, buildings, network lines, follow camera         |
| Main       | `apps/city/src/region/tile-streamer.ts`   | Streams building tiles within 1.5 km of the view (6 at a time)   |
| Main       | `apps/city/src/crowd/crowd-layer.ts`      | Clock, drain, upload, crowd compute passes, LOD budget           |
| Main       | `apps/city/src/traffic/traffic-layer.ts`  | Car snapshots, car compute passes                                |
| Worker × N | `packages/sim-worker/src/worker.ts`       | One partition of the population (`CitySimulation`)               |
| Worker     | `apps/city/src/traffic/traffic-worker.ts` | Road traffic (`packages/traffic`)                                |
| Worker     | `apps/city/src/routing/`                  | Click-to-route A* for the Route panel                            |

The number of simulation workers is `?workers=N`, or 4 in the showcase, 1 on a phone, and
otherwise a third of the cores (at most 4).

## 4. Data model and shared memory

### The agent record (24 bytes)

Defined in `packages/core-types/src/agent-record.ts`. It describes motion, not position: the GPU
computes the position from it at any time.

| Offset | Type | Field                                        |
| -----: | ---- | -------------------------------------------- |
|      0 | u32  | half-edge (edge × 2 + direction)             |
|      4 | f32  | `s0`: distance along the edge at `t0`        |
|      8 | u32  | `t0`: simulation time, ms                    |
|     12 | u16  | speed, mm/s                                  |
|     14 | i8   | lateral offset, 2 cm units                   |
|     15 | u8   | animation clip                               |
|     16 | u8   | kind: robot bit (0x80) + model variant       |
|     17 | u8   | flags: Hidden 1, Roof 2                      |
|     18 | u16  | walk phase at `t0`                           |
|     20 | u32  | seed (identity: look, height, random stream) |

### Shared buffers (`packages/sim-worker/src/shared.ts`)

- **records**: 24 bytes per agent row, written by the workers, read by the render thread.
- **dirty rings**: one per worker, the ids whose records changed. Capacity is a power of two, at
  least twice the worker's rows. A reader that falls a lap behind refreshes every record.
- **clock**: the target time the render thread wants (`TargetMs`), running flag, the camera focus
  (for the near tier), and the followed agent.
- **reached**: the time each worker has simulated to. The renderer never draws past the minimum.
- **exchange**: per-tick data the workers swap (section 7).

### Changes reach the GPU as events

Each frame the crowd layer drains the rings, holds records whose `t0` is still in the drawn
future, packs the rest as (id, record) events into one buffer with a single upload, and a
`scatter` compute pass writes them into place. At 1M agents this measured 0.50 ms per frame
against 42.8 ms for re-uploading every record. A frame with more than 65,536 changes
re-uploads the whole buffer instead.

## 5. The frame

With a base map, MapLibre owns the camera and calls the city's draw from a custom layer each map
frame; without one, `setAnimationLoop` drives it. Per frame:

1. **Camera.** The overlay takes MapLibre's view-projection × the region's geo matrix (section 8),
   converts depth to WebGPU's range and applies it to the Three camera; the follow camera glides
   its focus towards the followed agent.
2. **Crowd clock.** Drawn time advances by the frame time × time scale, but never past what every
   worker has reached; the workers are asked to run 250 ms (× time scale) ahead.
3. **Drain and upload** the changed records (section 4).
4. **Hi-Z.** Solid buildings are rendered depth-only into a 512-wide target and reduced to a
   max-depth pyramid (below 200 m camera height; `?occlusion=0` turns it off).
5. **Crowd compute**: `scatter → integrate → occlusion → cullLod → writeArgs`.
6. **Traffic compute**: `cull → writeArgs`.
7. **Render**: buildings, network lines, then one indirect draw per (model family, LOD, sub-mesh)
   and per car part and LOD; impostors are one instanced quad draw per family.
8. **Readback** (asynchronous, every 250–500 ms): visible counts and triangles for the panel and
   the LOD budget; GPU timestamps where `timestamp-query` exists.

## 6. Crowd rendering and level of detail

`packages/render/src/gpu-crowd.ts`, with the CPU reference rules in `lod-policy.ts`.

- **integrate** dead-reckons each agent along its edge from the record (position, heading, walk
  phase) and picks the two animation frames to blend.
- **cullLod** drops hidden agents, roof walkers outside loaded tiles, occluded and off-screen
  agents, then picks a band from the projected height
  `h = height × pixelsPerRadian / distance × lodBias`, with 10 % hysteresis and a 300 ms dithered
  crossfade, and appends the agent to its bucket with an atomic counter. Buckets are fixed
  segments of one buffer, so no prefix sum is needed.
- **Levels.** Five mesh LODs and an impostor per family:

  |                    |    LOD0 |   LOD1 |   LOD2 |  LOD3 | LOD4 | Impostor below |
  | ------------------ | ------: | -----: | -----: | ----: | ---: | -------------: |
  | Human triangles    |  24,000 | 10,000 |  4,000 | 1,000 |  350 |                |
  | Robot triangles    | 120,000 | 50,000 | 15,000 | 3,500 |  750 |                |
  | Brief preset, px   |     124 |     46 |     18 |     7 |      |              5 |
  | Density preset, px |     168 |    120 |     73 |    37 |      |             20 |

- **Budgets.** Per-LOD caps (robots 8 / 64 / 1,024 and people 96 / 1,024 / 8,192 for LOD0–2); a
  full band sends the agent to the impostor. A global LOD bias keeps visible triangles under 10M:
  ×0.85 when over, ×1.05 when under 70 %, between 0.25 and 1.
- **Animation.** Clips are baked to bone-matrix tables at load; the vertex shader skins on the GPU
  (one or four influences, two frames blended). The walk phase follows distance walked divided by
  stride, so feet do not slide.
- **Appearance.** The seed picks clothing, skin and hair colours and a ±8 % height for tint-masked
  models; the textured models (the man and the woman) keep their own look.
- **Impostors** are baked on the GPU at load from LOD2: 16 yaws × 2 pitches × 8 walk frames, 64 ×
  128 px tiles with albedo, normal and mask.
- **Occlusion.** `hi-z.ts` tests each agent's bounding sphere at the pyramid level where it covers
  at most 2 × 2 texels. Buildings made see-through with the transparency slider leave the occluder
  layer, so the crowd behind them is drawn.

### Characters

- Robot: `models/optimus.glb`, a static Tesla Optimus mesh rigged by `tools/auto-rig` (nearest
  bone onto the Mixamo X Bot skeleton, which supplies the idle, walk and run clips).
- Woman: `models/woman.glb`, a rigged model retargeted by joint name, keeping its own weights.
- Man: `models/man.glb`, "Cool Man" by ardhanaputra (Sketchfab, CC BY 4.0), already rigged with
  Mixamo joint names, retargeted by auto-rig keeping its own weights.
- Cars: the Porsche LODs from the 3d-city-million-cars project (`vehicles/porsche`).

Models load through `loadCharacter` → `bakeCharacter` → `buildLodChain` (chained simplification,
each sub-mesh keeping its share of the triangle target). How to prepare a new model:
[character-models.md](character-models.md).

## 7. Simulation

`packages/sim/src/city-sim.ts` (`CitySimulation`), run by `packages/sim-worker`. How to run, change and test it:
[simulation.md](simulation.md).

### Agents and time

- **States**: Walk, Wait (at a kerb), Indoor (collapsed into a building aggregate, row freed),
  Pause (at a roof-walk corner).
- **Event-driven.** An agent costs nothing between the ends of straight graph segments. Events
  sit in a timing wheel (16 ms slots); the tick is 33 ms (30 Hz). Records are stamped with the
  exact event time, so the GPU's dead reckoning stays continuous.
- **Tiers.** Agents within 150 m of the camera focus (leaving at 200 m) are the near tier: once a
  tick they sidestep within the pavement (0.7 m radius, 2 cm per tick). Everyone else is purely
  event-driven, with a density-dependent speed chosen on entering each edge. Buildings are
  aggregates: people inside them are counts, not rows.
- **Population.** `population = active rows + Σ building aggregates`, constant and checked.
  Buildings emit people back out first-in first-out with exponential gaps; an emitted person keeps
  their seed, so their identity and look. The start puts a time-of-day share of the population on
  the streets and the rest in buildings by the previous period's demand.
- **Demand** (`demand.ts`): five periods (night, morning 06–10, midday 10–16, evening 16–20,
  late). Destination weights and stay times depend on building type: offices in the morning,
  stations in the evening, homes at night. Stations are virtual buildings whose aggregates stand
  for the world beyond the region.

### Walking

- **Speed**: Weidmann's fundamental diagram (jam density 5.4 per m², floor 15 % of free speed),
  steps × 0.55. People walk 1.2–1.5 m/s, robots 1.35–1.5 m/s.
- **Lanes**: `clamp(floor(width / 0.75 m), 1, 4)` per edge, keep-left, ±0.15 m jitter.
- **Crossings**: signalised crossings run a 60 s cycle with 12 s green (start only with 4 s left),
  with reaction delays; unsignalised and implicit crossings wait 0–2.5 s and 1–5 s; robots add 1 s.
  Waiting agents queue in rows from the kerb.
- **Routing**: next-hop tables (one byte per node) built by Dijkstra from each 200 m destination
  cluster (400 m at city scale), per profile, cached LRU under a byte budget (168 MB per worker,
  34 MB on a phone); the last 200 m is A*. Robots use the robot profile, which avoids steps and
  weighs implicit crossings at 80 m instead of 25 m. Trips are at most 1 km at city scale.
- **Roof walkers**: `?roofs` (default 0.01) sends that share of the start's street walkers onto
  roof walks for good: they wander, turn at random at corners and pause 2–10 s. The Roof view
  follows one (a person or a robot).

### Partitioned workers

- Each worker owns a contiguous range of rows, a share of the population and a strip of the
  region (strips hold equal numbers of entrances), so it builds route tables for its own area only.
- **Per tick**: step events → publish (per-edge occupancy and up to 16,384 near-tier walkers,
  double-buffered) → barrier (`Atomics.wait`) → consume the others' occupancy (density, one tick
  late) and near walkers (avoidance across strip borders).
- A run is deterministic for a given worker count, but different counts give statistically, not
  bit-, identical runs.

### Traffic

`packages/traffic`: a simplified intelligent driver model on `roads.bin` (4.5 m cars, 2 m gap,
1 s headway, no overtaking), junction slow-down, random turns avoiding U-turns, driving on the
left, a 10 Hz tick. About 60 cars per km of road, at most 50,000 (5,000 on a phone).

## 8. Geography

- **Frame.** The pipeline projects OSM to British National Grid (EPSG:27700) around a region
  origin; tiles hold tile-local metres. `apps/city/src/map/geo-frame.ts` fits BNG → Web Mercator as
  one affine 4 × 4 matrix in float64 at the origin (within about 0.5 m over a few km); Three's
  matrices keep float64, so the overlay lines up with the base map without jitter.
- **Base map.** MapLibre on a globe; Streets (OpenFreeMap Liberty) or Satellite (Esri World
  Imagery with Liberty's labels), switched in place without reloading the style. Its own 3D
  buildings are hidden where the city draws the same building: a filter on the OpenMapTiles
  feature id (OSM id × 10 plus a type digit) against the OSM ids of the loaded tiles' buildings,
  since MapLibre's `within` does not test polygons. The rest fade with the transparency slider.
  The base map is flat while a region built with terrain is not, so over it the city camera is
  raised by the ground height at the focus (`scene/ground-grid.ts`, 64 m cells of ground-node
  medians, glided as the view moves): the ground under the view meets the map. The same offset
  applies over the photorealistic tiles, which move with the city and keep their terrain
  relative to it: MapLibre's camera stands on its flat ground, so without it a close view
  (zoom 21–22) put the camera below a street higher than the region's zero.
  Buildings on slopes stand on their lowest ground, so each wall corner instead starts at the
  street beside it (`scene/street-ground.ts`: the lowest path node within 10 m, never below the
  base), and an invisible depth-only ground (`scene/ground-depth.ts`, 8 m cells, 0.3 m under each
  cell's lowest path node) hides what still reaches below the street. The depth ground is off
  over the photorealistic tiles, whose own ground does the same.
- **Paths along walls**: walkers spread across a path's width, so the pipeline narrows each
  open-air ground-level path to its line's clearance from the nearest building wall, less 0.35 m
  for a body (`tools/osm-pipeline/src/wall-clearance.ts`, never below 1 m; entrance links, indoor,
  covered and bridge paths are left). Central London: 10,307 paths, 203 of 1,479 km.
- **Buildings.** One mesh per streamed 256 m tile, from the tile's footprints and heights (OSM
  `height`, else levels × a storey height by type, else a type default).

## 9. Offline pipeline and formats

### Pipeline (`tools/osm-pipeline`)

`yarn region --region <id>` builds a region from the Geofabrik extract in `data/raw/` with
`osmium` (bounding box, then tag filter), in this order:

1. mapped pedestrian ways;
2. buildings (also barriers for later stages);
3. inferred sidewalks along roads, mapped and implicit crossings;
4. gap closing;
5. entrances (mapped, plus synthetic ones so every building is reachable) and stations;
6. topology: end snapping, node contraction, polyline simplification;
7. tiling into 256 m tiles; edges that cross a boundary are split, with portals joining the two
   boundary nodes;
8. QA gates (connected share ≥ 0.95, entrances connected ≥ 0.9, buildings reachable ≥ 0.85,
   dangling ≤ 0.15). A failure exits non-zero but keeps the output for inspection.

Every tile is read back and hash-checked, and the stitched tiles must match the untiled graph.
London (20 × 20 km, 5,898 tiles) is built in 10 × 10-tile chunks with 400 m margins, whose seams
are re-linked, then stitched once into `region.nav`, which keeps every building without its
outline; the tiles then keep only their buildings, so each is stored once (284 → 165 MB, and the
app fills in the outlines round the start view for the roof walks). `roads.bin` holds the drivable
network.

| Region         | Size                               | Tiles |
| -------------- | ---------------------------------- | ----: |
| `canary-wharf` | about 2 × 2 km                     |    64 |
| `docklands`    | 4.2 × 4.3 km                       |   267 |
| `london`       | 20 × 20 km around Trafalgar Square | 5,898 |

### Formats (`packages/formats`)

- **Column file, version 1**: little-endian, magic `CNAV`, a 32-byte header and a column table;
  columns are 8-byte aligned and read zero-copy as typed arrays. Unknown columns are skipped;
  newer versions are rejected.
- **Nav tile** (`tile_x_y.nav`): a container of seven sections: nodes, edges, half-edge adjacency
  (compressed rows), polylines, buildings, building rings and portals.
- **Region manifest** (`manifest.json`): origin, WGS84 box, tile size and list, the stitched graph
  (`region.nav`), the road network, QA metrics and build provenance.
- **Roads** (`roads.bin`, magic `RDS1`): nodes, edges, speeds and road classes.

## 10. Module layering

A Yarn 4 monorepo; packages are consumed as TypeScript source. `eslint-plugin-boundaries`
disallows every import that is not listed, and madge rejects cycles:

| Package                                   | May import                               |
| ----------------------------------------- | ---------------------------------------- |
| `core-types`, `metrics`, `assets-runtime` | nothing                                  |
| `formats`                                 | core-types                               |
| `nav`                                     | core-types, formats                      |
| `buildings`                               | core-types, formats, nav                 |
| `sim`                                     | core-types, formats, nav                 |
| `sim-worker`                              | core-types, formats, nav, sim, buildings |
| `traffic`                                 | formats                                  |
| `render`                                  | core-types, metrics, assets-runtime      |
| `apps/city`                               | all packages                             |
| `osm-pipeline`                            | core-types, formats, nav                 |
| `sim-bench`                               | core-types, formats, nav, sim, buildings |
| `bench-runner`, `auto-rig`                | nothing                                  |

`render` knows nothing of the map or the simulation: it draws records. `sim` knows nothing of the
GPU: it writes records. `yarn check` runs typecheck, lint, formatting, the cycle check and the
unit tests.

## 11. Pages

| Path     | Purpose                                                |
| -------- | ------------------------------------------------------ |
| `/`      | The city: region, crowd, traffic, routing, layers      |
| `/lod`   | A character's LOD chain side by side, animated         |
| `/bench` | Crowd rendering benchmarks (paths, strategies, sweeps) |
| `/webgl` | WebGL 2-only crowd test with WebXR (see section 14)    |

## 12. Deployment

- **Hosting**: Vercel, static. `vercel.json` sends COOP, COEP and CORP on every response and
  rewrites client routes to `index.html`; region, model and vehicle files are cached for an hour.
- **Assets are not in git** (region data, models, cars), so the deploy is built locally: `vercel
build` runs `yarn build:demo`, and the output is uploaded as one archive from a copy outside the
  repository (inside it, Vercel attaches the commit author and may block the deployment).
- **The demo build** opens on Central London (`VITE_DEFAULT_REGION=central`): the river corridor
  from Buckingham Palace to Island Gardens, 9.8 × 3.6 km, in the showcase at Trafalgar Square with
  a million people and robots. It leaves London, Docklands and the `debug/` GeoJSON out: 49.7 MB
  and 614 files, mostly London's 46.0 MB of tiles and 106.4 MB graph.
- **Phones** (narrow or coarse-pointer screens up to 1,024 px) start lighter: 2,000 agents, 5,000
  cars, one worker, 34 MB route tables, a 1× city canvas, a 2× map without antialiasing and
  WebGPU's default limits, because iOS Safari ends a tab that uses more than about 1–1.5 GB.

## 13. Degradation and failure modes

| Condition                      | Behaviour                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No WebGPU, or no adapter       | A message names what is needed (Safari on iOS 26+, recent desktop Chrome, Edge or Safari)                                                                  |
| Not cross-origin isolated      | No `SharedArrayBuffer` for the simulation's shared memory; the vehicle buffer falls back to a plain `ArrayBuffer`. Vite and `vercel.json` send the headers |
| A worker falls behind          | Drawn time waits for the slowest worker (`reached`); the scene slows rather than tears                                                                     |
| A ring reader is lapped        | Every record is refreshed once                                                                                                                             |
| Over 65,536 changes in a frame | One full record upload instead of events                                                                                                                   |
| Too many visible triangles     | The LOD bias lowers detail, down to 0.25                                                                                                                   |
| A LOD band is full             | The agent is drawn as an impostor                                                                                                                          |
| Pipeline QA gate fails         | The build exits non-zero but writes the output for inspection                                                                                              |
| Background tab                 | Browsers stop animation frames; loading pauses at the base map until the tab is visible                                                                    |

## 14. Performance

Measured on an Apple M1 Pro unless stated.

| Measurement                                           | Result                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------- |
| London showcase, 1M agents                            | 60 fps, workers at about 430 ms of compute per simulated second       |
| Docklands, 1M population at 08:30                     | 98,530 rows + 901,470 aggregated; 63.6 worker ms per simulated second |
| Record upload at 1M agents                            | 0.50 ms per frame as events, against 42.8 ms full                     |
| Hi-Z occlusion at street level                        | GPU 3.80 ms against 7.30 ms without                                   |
| Streaming a 256 m tile                                | 0.47 ms mean, 3.6 ms worst on the main thread                         |
| WebGL 2 test (`/webgl`), 3,237-triangle robot, no LOD | 60 fps to 5k robots (16M triangles), 55 fps at 10k, 28 fps at 20k     |

## 15. Limits and next steps

- **WebGPU only.** The crowd and traffic depend on compute shaders, so older iPhones and the Meta
  Quest Browser cannot run the city. The `/webgl` page is the proof for a WebGL 2 fallback: culling
  and LOD selection moved into the workers (as in the cars project), animation in vertex
  textures, and WebXR for a VR mode with a smaller crowd.
- **Memory on phones.** Route tables, region data and two drawing buffers dominate; the phone
  profile is a first cut, not measured on devices.
- **London in the demo.** London's data (165 MB) is too large for the free hosting plan's
  limits; a smaller London or separate storage would bring it back.
- **Indoors.** Procedural interiors were replaced by roof walks; people inside buildings are
  aggregates only.
