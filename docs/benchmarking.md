# Benchmarking

The character benchmark (/bench), the simulation benchmark and the Stage 0 report matrix.

## Running a benchmark

Open `yarn dev` and use the panel, or describe the run in the URL:

```
http://localhost:5173/bench?path=b&model=/models/Xbot.glb&tris=1000&agents=10000&sweep=1000,10000&autorun=1
```

| Parameter     | Default                   | Meaning                                                                                                                                                                                                                                                           |
| ------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`        | `b`                       | `b` = baked animation, GPU dead reckoning and skinning, instanced (Three.js + TSL); `c` = the same crowd in hand-written WebGPU; `a` = one SkinnedMesh + AnimationMixer per character; `transfer` = simulation → GPU transfer benchmark; `idle` = clear pass only |
| `strategy`    | `events`                  | `path=transfer` only: `full`, `ranges` or `events` upload of simulation output (plan Q10)                                                                                                                                                                         |
| `model`       | `test-rig`                | human base meshes, comma-separated: `test-rig` or URLs of rigged GLBs                                                                                                                                                                                             |
| `clip`        | first `/walk/i`, or first | animation clip name                                                                                                                                                                                                                                               |
| `tris`        | as authored               | simplify the character to about this many triangles (meshoptimizer; skin weights stay valid)                                                                                                                                                                      |
| `robot`       | none                      | URL of a robot GLB, loaded as a second skeleton family (bone-parented rigid parts are merged automatically)                                                                                                                                                       |
| `robots`      | `0.25` with `robot`       | share of agents that are robots; `1` loads robots only                                                                                                                                                                                                            |
| `robotClip`   | first `/walk/i`           | robot animation clip                                                                                                                                                                                                                                              |
| `robotSkin`   | `authored`                | `rigid` collapses robot skinning to one bone per vertex                                                                                                                                                                                                           |
| `robotHeight` | `1.75`                    | robot rest height in metres                                                                                                                                                                                                                                       |
| `agents`      | `500`                     | agent count for interactive use                                                                                                                                                                                                                                   |
| `sweep`       | `100,500,1000,2000`       | agent counts measured by **Run sweep**                                                                                                                                                                                                                            |
| `warmup`      | `2`                       | seconds discarded before each step                                                                                                                                                                                                                                |
| `measure`     | `5`                       | seconds measured per step                                                                                                                                                                                                                                         |
| `autorun`     | off                       | `1` starts the sweep once the scene is ready                                                                                                                                                                                                                      |
| `seed`        | `1`                       | per-character phase and orientation                                                                                                                                                                                                                               |
| `lod`         | `auto`                    | Path B: force every agent to LOD `0`–`4` or `impostor`                                                                                                                                                                                                            |
| `impostors`   | on                        | `0` disables impostors for far agents                                                                                                                                                                                                                             |
| `lodPreset`   | `brief`                   | LOD pixel thresholds: `brief` (the brief's distance bands) or `density` (~1 px per triangle)                                                                                                                                                                      |
| `lodColours`  | off                       | `1` tints agents by LOD                                                                                                                                                                                                                                           |
| `fade`        | on                        | `0` switches LODs instantly instead of crossfading                                                                                                                                                                                                                |
| `fadeMs`      | `300`                     | crossfade duration                                                                                                                                                                                                                                                |
| `tint`        | on                        | `0` disables per-agent clothing/skin/hair tints and height variation                                                                                                                                                                                              |
| `layout`      | `crowd`                   | `lineup` stands agents in rows facing the camera                                                                                                                                                                                                                  |

Results download as JSON from the panel and are also exposed as `window.__cityBenchmark` for
scripted runs. Recorded results live in `docs/benchmarks/`.

Real characters go in `apps/city/public/models/` (gitignored until asset licences are
settled). The humans come from the three.js examples: X Bot and Soldier (Mixamo), plus
RobotExpressive by Tomás Laulhé (CC0):

```
base=https://raw.githubusercontent.com/mrdoob/three.js/r186/examples/models/gltf
curl -L -o apps/city/public/models/Xbot.glb $base/Xbot.glb
curl -L -o apps/city/public/models/Soldier.glb $base/Soldier.glb
curl -L -o apps/city/public/models/RobotExpressive.glb $base/RobotExpressive/RobotExpressive.glb
```

The robot is ["Tesla optimus"](https://sketchfab.com/3d-models/tesla-optimus-2fab5d31927f43729a99a6e8eaf1c7f5) by
[Mechamaner.V](https://sketchfab.com/jjeendral36), [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/)
(`data/Tesla optimus.glb`, a static mesh). The woman is
["Invisible Woman (Textured)(Rigged)"](https://sketchfab.com/3d-models/invisible-womantexturedrigged-031e16a761b64814a30f0cc888ac7aff)
by [CAPTAAINR](https://sketchfab.com/CAPTAAINR), CC BY 4.0. All sources and licences are on the site's
Credits page (`/credits`). `tools/auto-rig`
binds it to X Bot's skeleton and copies its idle, walk and run clips. A static mesh is skinned by
nearest bone (rigid parts stay rigid); an already rigged model (the woman) keeps its own weights,
moved onto X Bot's joints by name, with the skeleton scaled to its proportions:

```
yarn workspace @city/auto-rig rig --mesh "data/Tesla optimus.glb" \
  --skeleton apps/city/public/models/Xbot.glb --out apps/city/public/models/optimus.glb
yarn workspace @city/auto-rig rig --mesh data/invisible_womantexturedrigged.glb \
  --skeleton apps/city/public/models/Xbot.glb --out apps/city/public/models/woman.glb
```

The man is ["Cool Man"](https://sketchfab.com/3d-models/cool-man-ad14b71697dd4ea7836c1f06c75e5f72) by
[ardhanaputra](https://sketchfab.com/ardhanaputra), licensed
[CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). It is already rigged with Mixamo joint
names, so auto-rig keeps its own weights (the workspace runs in `tools/auto-rig`, so give absolute
paths):

```
yarn workspace @city/auto-rig rig --mesh "$PWD/data/cool_man.glb" \
  --skeleton "$PWD/apps/city/public/models/Xbot.glb" --out "$PWD/apps/city/public/models/man.glb"
```

RenderPeople's rigged FBX characters (an earlier man was their Eric) convert first with
`tools/auto-rig/renderpeople.py` in Blender; see
[`docs/character-models.md`](character-models.md).

For example: `?model=/models/Xbot.glb,/models/Soldier.glb&robot=/models/RobotExpressive.glb&robots=0.25`.

## Simulation benchmark

```
yarn workspace @city/sim-bench bench            # full matrix, 1–8 workers, 10k–1M agents
yarn workspace @city/sim-bench bench --quick    # smaller matrix
yarn workspace @city/sim-bench bench --out docs/benchmarks/stage0-sim-<machine>.json
```

## Benchmark matrix (Stage 0 report)

```
yarn workspace @city/bench-runner matrix                     # all entries × 3, ~15 min + load waits
yarn workspace @city/bench-runner matrix --only b-lod0 --merge docs/benchmarks/stage0-matrix/<file>.json
yarn workspace @city/bench-runner report docs/benchmarks/stage0-matrix/<file>.json   # regenerate only
```

Writes raw runs to `docs/benchmarks/stage0-matrix/` and the report to
`docs/benchmarks/stage0-<machine>.md`. Needs the models above and a quiet machine.
