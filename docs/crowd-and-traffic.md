# Crowd and traffic

Running the crowd at different sizes, roofs and buildings, and the cars from the Million Cars project.

### Traffic

Cars from the [3d-city-million-cars](https://github.com/webtrackerxy/3d-city-million-cars) project drive the region's roads:
its road traffic model (car following, junction slow-down, keep-left) runs in a worker in
`packages/traffic`, and the GPU passes in `packages/render/src/gpu-traffic.ts` cull, pick LODs and
draw its Blender-made Porsche LODs in the city scene, so buildings, robots and cars hide each
other correctly. `?cars=N` sets the number (default about 60 per km of road, at most 50k, or 5k on
a phone); the panel's Traffic section switches it live.

The road network (`roads.bin`) comes from the same OSM extract as the pedestrian tiles. A region
built before traffic existed gets one without rebuilding its tiles:

```
yarn region --region docklands --roads-only
```

The car models are the cars project's optimised LODs, copied into `apps/city/public/vehicles/`
(gitignored):

```
mkdir -p apps/city/public/vehicles/porsche
cp ../3d-city-million-cars/dist/vehicles/porsche/{car_lod?.opt.glb,manifest.json} \
  apps/city/public/vehicles/porsche/
```

Traffic can cover more than the pedestrian region. The cars project's 20 km London box around
Docklands (5,300 km of road; the base map's own 3D buildings fill the city outside the region):

```
yarn region --region docklands --roads-only --roads-bbox -0.2724,51.4182,0.0162,51.5978
```

Cars and robots are simulated separately for now: cars do not yet stop for robots at crossings.

### 1M people (M7)

```sh
yarn region --region docklands     # 4.2 × 4.3 km: Limehouse, Poplar, Isle of Dogs, south bank
yarn dev:city                      # then open:
# ?region=docklands&population=1000000&agents=200000&startHour=8.5&workers=2&timeScale=16
```

- **Tiles:** one `tile_x_y.nav` container per tile (Appendix A), streamed nearest first.
- **Stations:** virtual buildings in the pipeline; their aggregates are the world beyond the
  region.
- **Population and demand:** the `population` is shared between `agents` rows (individually
  simulated) and building aggregates. Demand follows the time of day (`packages/sim/src/demand.ts`):
  morning to offices, evening to stations and homes.
- **Routing:** next-hop tables per 200 m destination cluster, then a last-mile A*.
- **Workers:** `?workers=N` partitions rows and population. Workers exchange density and
  near-tier positions every tick behind a barrier (decision 0005).
- **Results:** `docs/benchmarks/m7-1m-m1pro.md` (`yarn workspace @city/sim-bench m7-bench`).

### Roofs and buildings

People do not walk inside buildings. They walk on the streets, on roofs, or wait inside a
building as part of its headcount:

- **Roof walks:** `packages/buildings` generates a walk round every flat roof at least 6 m high:
  a loop set 1.5 m in from the edge and, on roofs over 400 m², a path across along the long axis.
  Roofs that are too small or thin, or partly under a taller building (a podium round a tower), get
  none. The walks are islands, never part of a route, drawn at the roof's height.
- **Roof walkers:** `?roofs=0.01` (default) sends that share of the people and robots walking at
  the start onto roofs, for good. They wander the walks, turning at random at each corner and now
  and then standing for a few seconds. In a city (London), roof walks are generated round the
  start view, the share is taken of the street walkers there, and roof walkers are drawn only
  where buildings are loaded.
- **Aggregates (T3):** reaching a building's entrance collapses the agent into that building's
  count and frees its row. Buildings emit people back out, first in first out, and a person keeps
  their seed and therefore their identity. Rows plus aggregates equal the population at every tick
  (tested).
- **Roof view:** the panel's Roof view menu (Off / Person / Robot) picks a person or a robot on a
  roof near the view, and the camera follows them.

### 100k agents (M5)

`?agents=100000` (or the panel's 100k):

- **Tiers (§19):**
  - T0: agents within 150 m of the camera's orbit target run 30 Hz avoidance.
  - T2: everyone else is purely event-driven.
  - Density slows agents on crowded edges (Weidmann's fundamental diagram, applied at edge entry).
- **Routing:** next-hop tables, one per destination and profile, built lazily. Agents carry only
  their destination.
- **Transfer:** changed records are uploaded as (id, record) events and scattered by a compute
  pass (decision 0002).
- **Streaming:** tiles stream in nearest the camera first. Each tile's buildings are one mesh; the
  tiles are stitched into one graph for the simulation and routing.
- **Culling:** Hi-Z occlusion against the buildings (`?occlusion=0` turns it off).
- **LOD budget control (§17):** per-LOD instance caps (`?lodCaps=N` to test), and a global LOD
  bias driven by visible triangles against a 10M budget.
- **Tile-size benchmark:** `yarn workspace @city/sim-bench tile-bench`; report in
  `docs/benchmarks/tile-size-m1pro.md`.

### The crowd (M4)

`yarn dev:city` also starts a crowd: `?agents=10000&robots=0.2&seed=1`. The panel sets the count
of each model (Robots up to 1M; Woman and Man up to 500k each) and the time scale (pause, 1×, 4×,
16×).

**Simulation** (`CitySimulation` in `packages/sim`, running in a worker):

- **Trips:** agents walk routes between entrances, choosing destinations by building type and
  time of day. At the entrance they join the building's headcount (see Roofs and buildings) and
  come out again later.
- **Straight segments:** nav polylines are split into straight segments (`simGraphFromTile` in
  `packages/nav`). Records change only at segment ends and are stamped with the exact event
  time. The GPU dead-reckons in between and holds an agent at a segment end until its next record
  arrives.
- **Lanes:** `clamp(floor(width / 0.75 m), 1, 4)` lanes per edge, keep-left, with ±0.15 m jitter.
  Agents drift to a new lane at 0.2 m/s instead of jumping.
- **Crossings:** signalised crossings (`EdgeFlag.Signalised`) run a 60 s cycle with 12 s of
  green and a per-crossing offset. Other crossings use gap acceptance of 0–2.5 s, or 1–5 s for
  implicit ones. Robots wait an extra second. Agents wait at the kerb with the idle clip.
- **Avoidance:** walking agents closer than 0.7 m push each other sideways within the pavement.
- **Determinism:** tests check that the same seed gives the same state hash however time is
  advanced, that records are continuous, that population is conserved, that crossings start on
  green, and that robots never take steps.

**Transfer** (`packages/sim-worker`):

- The worker follows the render thread's clock through shared memory.
- It writes 24-byte records into a SharedArrayBuffer and publishes changed ids through a ring.
- The render loop drains the ring every frame and uploads just those records as (id, record)
  events, which a compute pass scatters into place (decision 0002). A frame with more than 65,536
  changes re-uploads every record instead.

**Rendering:** the Stage 0 GPU crowd (Path B) with LODs and impostors, using the rigged models
from `apps/city/public/models`: the man ("Cool Man" by ardhanaputra, CC BY 4.0) and the Invisible Woman (humans) and
Optimus (robot), rigged or retargeted by `tools/auto-rig`. How to prepare another model:
[`docs/character-models.md`](character-models.md).

`window.__city` exposes frame intervals, GPU timestamps and crowd stats for scripted
measurement.
