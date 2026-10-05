# Simulating people, robots and cars

How the simulators work and how to set up, run, change and test a simulation of people, robots
and cars. For the threads, shared memory and rendering around them, see
[system-design.md](system-design.md); for the character models, see
[character-models.md](character-models.md).

## 1. The simulators

| Simulator         | Code                                                  | Runs in                                                    | Agents                                                 |
| ----------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------ |
| People and robots | `CitySimulation`, `packages/sim/src/city-sim.ts`      | 1–4 Web Workers (`packages/sim-worker`), or Node           | Rows (simulated individually) plus building headcounts |
| Cars              | `RoadTraffic`, `packages/traffic/src/road-traffic.ts` | One Web Worker (`apps/city/src/traffic/traffic-worker.ts`) | Every car, ticked at 10 Hz                             |

Both read the region the pipeline built (`apps/city/public/regions/<region>/`): people and robots
walk the pedestrian graph (`tile_x_y.nav`, or `region.nav` for London) and cars drive `roads.bin`.
They do not interact yet: cars do not stop for people at crossings.

```
 region files ──► MapPage (URL parameters, panel)
                    ├─► SimWorkerClient ─► sim worker × N ─► CitySimulation (a strip each)
                    │        ▲ shared memory: 24-byte records, change rings, clock │
                    │        └──────────────── crowd layer (GPU) ◄─────────────────┘
                    └─► traffic worker ─► RoadTraffic ─► vehicle snapshots ─► traffic layer (GPU)
```

The simulation only writes _records_, each describing an agent's motion from a moment on (edge,
distance, time, speed, clip). The GPU moves every agent between records, so the simulation does no
work for an agent until its next event: the end of a straight segment, a crossing, a building.

## 2. Running a simulation in the browser

Run `yarn dev` and open the map. The URL sets up the run, and the panel changes it while it
runs.

### Recipes

| Simulation                                        | URL (append to `http://localhost:5173/`)                                                  |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Docklands, the demo default                       | `?region=docklands`                                                                       |
| One million people at the morning peak, 16× speed | `?region=docklands&population=1000000&agents=200000&startHour=8.5&workers=2&timeScale=16` |
| London street showcase (2M on the streets)        | `?region=london`                                                                          |
| Robots only                                       | `?region=docklands&robots=1`                                                              |
| People only                                       | `?region=docklands&robots=0`                                                              |
| Evening rush to the stations                      | `?region=docklands&startHour=17.5`                                                        |
| A fifth of walkers on roofs                       | `?region=docklands&roofs=0.2`                                                             |
| No cars                                           | `?region=docklands&cars=0`                                                                |
| Heavy traffic                                     | `?region=docklands&cars=50000`                                                            |
| Reproduce a run                                   | add `&seed=42&workers=2` (same seed and worker count, same run)                           |

### Parameters

| Parameter    | Default                                                          | Meaning                                                           |
| ------------ | ---------------------------------------------------------------- | ----------------------------------------------------------------- |
| `region`     | `london` (`docklands` in the demo build)                         | Which region to load                                              |
| `agents`     | 10,000 (2,000 on phones, 2M in the showcase)                     | Rows: people and robots simulated individually                    |
| `population` | = `agents`                                                       | People in the region; those without a row wait in buildings       |
| `robots`     | 0.2 (0.5 in the showcase)                                        | Share of the rows that are robots                                 |
| `startHour`  | 8                                                                | Time of day at the start; sets who is out and where people go     |
| `timeScale`  | 1                                                                | Simulated seconds per real second (the panel: pause, 1×, 4×, 16×) |
| `workers`    | a third of the cores, at most 4 (1 on phones, 4 in the showcase) | Simulation workers                                                |
| `roofs`      | 0.01                                                             | Share of the start's street walkers who walk on roofs instead     |
| `showcase`   | on for London                                                    | Everyone walks from the start and nobody goes indoors             |
| `seed`       | 1                                                                | Random seed; with the worker count, it fixes the run              |
| `cars`       | about 60 per km of road, at most 50,000 (5,000 on phones)        | Cars; `0` turns traffic off                                       |
| `occlusion`  | on                                                               | `0` draws people behind buildings too (for comparison)            |

The panel's **Crowd** section sets the count of each model (Robots, Woman, Man) and the time
scale, and **Roof view** follows one person or robot. **Traffic** sets the car count. **Route**
plans a walk between two entrances with the pedestrian or robot profile.

## 3. How a person or robot is simulated

### Identity

Every agent is a 32-bit **seed**. From it come the agent's kind (robot or person), model, walking
speed, height and appearance, and its own random-number stream (`assignIdentity`, in
`city-sim.ts`). A person who goes into a building and comes out later keeps their seed, so they
are the same person.

|               | People                                                              | Robots                                                                          |
| ------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Share         | `1 − robots`                                                        | `?robots` (`robotShare`)                                                        |
| Walking speed | 1.2–1.5 m/s                                                         | 1.35–1.5 m/s, less spread                                                       |
| Route profile | `PEDESTRIAN`: steps cost ×1.4; crossing 8 m, implicit crossing 25 m | `ROBOT`: no steps (step-free edges only); crossing 10 m, implicit crossing 80 m |
| At crossings  | Waits 0–2.5 s (1–5 s at implicit ones)                              | The same, plus 1 s of caution                                                   |
| Height        | ±8 %                                                                | Fixed                                                                           |
| Models        | Man and Woman, by `humanShares`                                     | Optimus                                                                         |

### States

| State  | Meaning                                                                      |
| ------ | ---------------------------------------------------------------------------- |
| Walk   | On an edge, at a speed set when entering it                                  |
| Wait   | At a kerb, waiting to cross                                                  |
| Indoor | Inside a building as part of its headcount; the row is free for someone else |
| Pause  | Standing at a corner of a roof walk                                          |

### A day in the simulation

1. **Start.** A share of the population is out walking, depending on the time of day
   (`START_WALKING` in `demand.ts`: 0.5 % at night up to 5 % at the peaks). Everyone else is
   placed in buildings by the previous period's demand.
2. **Trips.** A walker picks a destination entrance by building type and time of day
   (`DESTINATION_WEIGHT`): offices in the morning, shops at midday, stations in the evening, homes
   at night. Stations are virtual buildings standing for the world beyond the region.
3. **Walking.** Each step follows a next-hop table towards the destination's 200 m cluster, then
   A* for the last 200 m. Speed comes from Weidmann's fundamental diagram (crowded edges are
   slower; steps × 0.55). People keep left in lanes 0.75 m wide and sidestep each other near the
   camera.
4. **Crossings.** Signalised crossings run a 60 s cycle with 12 s of green, and an agent starts
   only with at least 4 s left. Waiting agents queue in rows from the kerb.
5. **Buildings.** At the entrance the agent joins the building's headcount and its row is freed.
   Buildings send people out again, first in first out, after a stay that depends on the building
   type (`STAY_MINUTES`).
6. **Roofs.** `?roofs` sends that share of the start's walkers onto roof walks for good. They
   wander, turn at random at corners, and pause 2–10 s now and then.

### Near and far

Agents within 150 m of the camera's focus (leaving at 200 m) are the _near tier_: once a tick
(33 ms) they sidestep anyone within 0.7 m. Everyone else is purely event-driven, so a million
agents cost little more than the events they cause. The population is always
`active rows + building headcounts`, which the simulation checks.

### Determinism

Time is in integer milliseconds with a fixed 33 ms tick, every agent has its own random stream,
and nothing reads the wall clock. The same seed and the same worker count give the same run;
different worker counts give statistically equal runs, not identical ones.

## 4. Changing the simulation

| To change                                                   | Where                                                                                                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Default robot share                                         | `ROBOT_SHARE` in `apps/city/src/MapPage.tsx`, or `?robots`                                                                              |
| Walking speeds                                              | `assignIdentity` in `packages/sim/src/city-sim.ts` (`walkSpeed`)                                                                        |
| Where robots may go, and how they weigh crossings           | `ROBOT` in `packages/nav/src/routing.ts`                                                                                                |
| Where people may go                                         | `PEDESTRIAN` in `packages/nav/src/routing.ts`                                                                                           |
| Crossing timing, lanes, queues, avoidance, speeds in crowds | The constants at the top of `city-sim.ts` (`SIGNAL_CYCLE_MS`, `SIGNAL_GREEN_MS`, `LANE_M`, `QUEUE_*`, `AVOID_RADIUS`, `JAM_DENSITY`, …) |
| Robots' extra caution at crossings                          | `caution` in `city-sim.ts` (1,000 ms)                                                                                                   |
| Who goes where, when, and for how long                      | `DESTINATION_WEIGHT`, `STAY_MINUTES`, `START_WALKING` in `packages/sim/src/demand.ts`                                                   |
| Near-tier radius                                            | `NEAR_ENTER_M`, `NEAR_LEAVE_M` in `city-sim.ts`                                                                                         |
| Roof walking                                                | `ROOF_PAUSE_SHARE` in `city-sim.ts`; roof walk shape in `packages/buildings/src/roof.ts`                                                |
| A new human model                                           | [character-models.md](character-models.md), then `humanModels` and `humanShares` in `MapPage.tsx`                                       |
| Who may use an edge (steps, step-free, robots)              | `EdgePermission` bits, set by `tools/osm-pipeline`                                                                                      |

### Adding a new kind of agent

The agent record has one robot bit and a 7-bit model variant, so:

- **Another look for an existing kind** (a new person model, for example): add a model, as in
  character-models.md. No simulation change.
- **A robot that behaves differently** (a delivery robot that only goes to shops, say) is a larger
  change. It needs a per-agent kind beyond the robot bit in `CitySimulation`, chosen from the seed
  like `robot` is now; its own route profile and table cache (as `hops.robot`); its own destination
  weights; and, to look different, a second robot model family in the renderer
  (`apps/city/src/crowd/crowd-layer.ts` loads one robot family today).

Whatever the change, keep these properties, which the tests check:

- every random choice comes from the agent's own stream, never `Math.random`;
- records change only at events and carry the event's exact time;
- rows plus building headcounts always equal the population.

## 5. Cars

`RoadTraffic` moves cars on `roads.bin`, the drivable roads the pipeline extracts from the same
OSM file.

- **Model:** a simplified intelligent driver model (each car keeps a safe gap to the one ahead),
  slowing for junctions, with random turns that avoid U-turns. There is no overtaking. Cars that
  reach a dead end are placed again elsewhere.
- **Tick:** 10 Hz in the worker; the GPU interpolates between the last two snapshots.
- **Count:** `?cars=N`, or about 60 per km of road (at most 50,000, or 5,000 on phones); the
  panel's Traffic section changes it while running.

| `RoadTrafficOptions`                                         | Default                 | Meaning                              |
| ------------------------------------------------------------ | ----------------------- | ------------------------------------ |
| `count`                                                      | (required)              | Number of cars                       |
| `tickInterval`                                               | 0.1 s                   | Simulation tick, in seconds          |
| `seed`                                                       | 11                      | Random seed (the app passes its own) |
| `acceleration`                                               | 2.5 m/s²                | Maximum acceleration                 |
| `speedFactor`                                                | [0.7, 1.15]             | Each car's share of the speed limit  |
| `junctionSpeed`                                              | 6 m/s                   | Speed limit through a junction       |
| `driveOnLeft`                                                | set `true` for London   | Keep left of the centreline          |
| `laneOffset`                                                 | 1.75 m                  | Distance from the centreline         |
| `vehicleLength`, `minGap`, `headwayTime`, `comfortableDecel` | 4.5 m, 2 m, 1 s, 3 m/s² | Car-following parameters             |

The app's worker (`apps/city/src/traffic/traffic-worker.ts`) passes `count`, `seed`,
`tickInterval` and `driveOnLeft: true`; the rest keep their defaults. To build the roads for a region
that has none, or for a wider area than the pedestrian region:

```sh
yarn region --region docklands --roads-only
yarn region --region docklands --roads-only --roads-bbox -0.2724,51.4182,0.0162,51.5978
```

The car models come from the 3d-city-million-cars project (`apps/city/public/vehicles/porsche`).

## 6. Running without a browser

### Benchmarks (Node, worker threads)

```sh
yarn workspace @city/sim-bench bench            # 1–8 workers × 10k–1M agents on a synthetic grid
yarn workspace @city/sim-bench bench --quick    # a smaller matrix
yarn workspace @city/sim-bench tile-bench       # tile sizes, 100k agents
yarn workspace @city/sim-bench m7-bench         # 1M people on Docklands
yarn workspace @city/sim-bench m7-bench --population 1000000 --rows 200000 --hours 8.5,18 --warmup 600
```

`m7-bench` reads `apps/city/public/regions/docklands`, so build that region first. It reports
worker time per simulated second, rows in use and headcounts at each hour.

### In code

`CitySimulation` is plain TypeScript with no browser APIs, so it runs in a test or a Node script.
The unit tests build one on a small synthetic street grid (`gridTile()` in
`packages/sim/src/test-tile.ts`):

```ts
import { AGENT_RECORD_BYTES } from '@city/core-types';
import { simGraphFromTile } from '@city/nav';
import { CitySimulation } from './city-sim.ts';
import { gridTile } from './test-tile.ts';

const tile = gridTile();
const agents = 500;
const sim = new CitySimulation({
  tile,
  graph: simGraphFromTile(tile),
  agents,
  robotShare: 0.3,
  seed: 42,
  human: { walkClip: 1, idleClip: 0, strideM: 1.4, heightVariation: 0.08 },
  robot: { walkClip: 3, idleClip: 2, strideM: 1.2, heightVariation: 0 },
  humanVariants: 2,
  records: new DataView(new ArrayBuffer(agents * AGENT_RECORD_BYTES)),
  focus: { x: 75, z: -75 },
});

for (let t = 1000; t <= 600_000; t += 1000) {
  sim.advanceTo(t); // process events up to t ms
  sim.flush(() => undefined); // the ids whose records changed (the renderer uploads these)
}
console.log(sim.snapshotStats()); // walking, waiting, indoor, on roofs, …
console.log(sim.agentState(0)); // one agent: state, building, robot, seed
console.log(sim.stateHash()); // compare runs for determinism
```

The main calls: `advanceTo(ms)` runs the simulation up to a time; `flush(callback)` hands over
the agents whose records changed; `setFocus(x, z)` moves the near tier; `snapshotStats()` and
`agentState(agent)` read it; `stateHash()` fingerprints the whole state.

## 7. Testing a change

`yarn test` runs the unit tests; `yarn check` runs them with the type, lint, format and cycle
checks. The simulation tests (`packages/sim/src/*.test.ts`, `packages/sim-worker/src/*.test.ts`)
check that:

- the same seed gives the same state however time is advanced;
- records are continuous (no agent jumps between records);
- the population is conserved at every tick;
- crossings start on green, and robots never take steps;
- partitioned workers agree statistically with one worker;
- about the requested share walk on roofs, of both kinds, and only they do.

Add a test beside the code you change, on `gridTile()` where you can: it is small and fast, and
has steps, a signalised and an implicit crossing, and entrances. Then measure at scale with
`sim-bench`, and look at it in the browser with the recipes in section 2.
