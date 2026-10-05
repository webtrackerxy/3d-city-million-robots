# Preparing human and robot models

How to turn a 3D character into a crowd model: a rigged GLB that plays the crowd's walk and idle
clips, from which the app builds five levels of detail (LODs) and impostors when it loads. The
crowd's current models were made this way: the robot (Tesla Optimus, a static mesh), the woman
(a Sketchfab model with its own rig) and the man ("Cool Man" by ardhanaputra on Sketchfab, CC BY
4.0, rigged with Mixamo joint names). An earlier man, RenderPeople's Eric, came from a rigged FBX.

For how the crowd draws these models, see [system-design.md](system-design.md) section 6.

## 1. What the crowd needs

|           | Requirement                                                                      | Why                                                    |
| --------- | -------------------------------------------------------------------------------- | ------------------------------------------------------ |
| File      | Binary glTF (`.glb`) in `apps/city/public/models/`                               | Loaded by three.js `GLTFLoader`                        |
| Skeleton  | The Mixamo skeleton of X Bot (`models/Xbot.glb`), joint names `mixamorig:Hips` … | Every model plays the same baked clips                 |
| Clips     | `idle`, `walk`, `run`, copied from X Bot by `tools/auto-rig`                     | The crowd uses a walk-like clip and an idle one        |
| Facing    | +Z (toes forward), Y up                                                          | auto-rig turns the mesh if needed                      |
| Size      | Any; scaled to 1.75 m at load                                                    | `targetHeight` in `apps/city/src/crowd/crowd-layer.ts` |
| Skinning  | At most 4 joint influences per vertex                                            | The GPU skins 1 or 4 influences                        |
| Triangles | People up to about 24,000; robots up to about 120,000                            | The LOD0 targets; more is simplified at load           |
| Textures  | 1,024 px or less, JPEG, ideally one material                                     | GPU memory, phones, file size                          |
| Materials | As few as possible                                                               | One draw per sub-mesh per LOD                          |

Textured models keep their own look. The seed-based clothing and skin tints (`tintMask`) are only
used for untextured test models.

## 2. The pipeline

```
 source model (data/, git-ignored)
   │  glTF static mesh ─────────────────────────────┐
   │  glTF rigged, Mixamo joint names ──────────────┤
   │  RenderPeople FBX ─ renderpeople.py (Blender) ─┤
   │  other FBX ─ Blender export to GLB ────────────┤
   ▼                                                ▼
 tools/auto-rig  (X Bot skeleton + idle, walk, run)  →  apps/city/public/models/<name>.glb
   ▼  in the browser, when the page loads
 loadCharacter → bakeCharacter (bone-matrix tables) → buildLodChain (LOD0–LOD4)
   → bakeImpostors (from LOD2) → GPU crowd
```

Only the rigged GLB is prepared by hand. The LODs and impostors are built in the browser at load
time, so changing a model never needs a separate LOD export.

## 3. Step by step

### 3.1 Get the source and check the licence

- Put the source file in `data/` (git-ignored: `data/*.glb`, `data/raw`) or keep it in your
  downloads. Models are never committed.
- Check the licence before deploying. A deployed model is downloadable from the public site, which
  may count as redistribution. Character IP (film or game characters) is a separate risk from the
  file's own licence.

### 3.2 Convert to GLB

**A glTF static mesh** (one mesh, no skeleton, like the Optimus robot): use it as it is.

**A rigged glTF with Mixamo joint names** (like the woman): use it as it is. auto-rig matches
joints by name after stripping any `prefix:` and trailing `_1`-style suffixes.

**A RenderPeople rigged FBX** (like the earlier man, Eric): `tools/auto-rig/renderpeople.py` imports the FBX in
Blender, renames the 52 joints X Bot shares (`hip` → `Hips`, `upperleg_l` → `LeftUpLeg`,
`thumb_01_l` → `LeftHandThumb1` …), scales the 8K textures to 1,024 px and exports a GLB. Use the
Y-up T-pose file (`*_yup_t.fbx`) with the `tex/` folder beside it:

```sh
blender -b --python tools/auto-rig/renderpeople.py -- \
  <download>/rp_eric_rigged_001_yup_t.fbx "$PWD/data/man.glb" 1024
```

It prints `renamed 52 joints`. Twist, face and finger-end joints have no X Bot counterpart; auto-rig
hands their weights to the nearest matched joint.

**Any other FBX**: in Blender, _File → Import → FBX_, then _File → Export → glTF 2.0 (.glb)_
without animations. If the model is rigged with other joint names, rename its main joints to
Mixamo's (as `renderpeople.py` does) so its own weights are kept; otherwise it is skinned like a
static mesh. Scale large textures down first (_Image → Resize_).

### 3.3 Rig onto the crowd skeleton

`tools/auto-rig` binds the mesh to X Bot's skeleton and copies its clips. The workspace command
runs inside `tools/auto-rig`, so give absolute paths:

```sh
yarn workspace @city/auto-rig rig \
  --mesh "$PWD/data/man.glb" \
  --skeleton "$PWD/apps/city/public/models/Xbot.glb" \
  --out "$PWD/apps/city/public/models/man.glb"
```

| Option           | Default         | Meaning                                                                                                                                                                  |
| ---------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--mesh`         | (required)      | The source GLB                                                                                                                                                           |
| `--skeleton`     | (required)      | The skeleton and clips to copy: `models/Xbot.glb`                                                                                                                        |
| `--out`          | (required)      | The rigged GLB to write                                                                                                                                                  |
| `--clips`        | `idle,walk,run` | Clips to copy from the skeleton file                                                                                                                                     |
| `--prefix`       | `mixamorig:`    | Joint-name prefix in the skeleton file                                                                                                                                   |
| `--finger-clips` | off             | Keep the clips' finger rotations when retargeting (off: fingers keep the model's own pose, as they twist when its finger joints rest in other orientations than X Bot's) |

What it does depends on the source:

- **Already rigged with matching joints** (all of hips, upper legs, legs, feet, arms, forearms and
  hands on both sides): it _retargets_. The model keeps its own weights, moved onto X Bot's joints
  by name, and X Bot's bones are scaled to the model's proportions. The output says
  `retargeted: N joints matched by name` and `the source model's own weights`.
- **Static, or rigged with unmatched names**: it _skins_ the mesh. The mesh is split into
  connected parts. A small part (a plate, a finger segment) follows one bone and moves rigidly, as
  a robot's parts do. A large part (a leg shell) is skinned per vertex to the nearest bone capsule,
  blended near joints and kept to its own side of the body. X Bot's arms are posed to the mesh's
  (a robot standing arms down, for example).

In both cases the mesh is turned to face +Z and scaled to the skeleton's body height, and the
output ends with `wrote …: <size>, <joints> joints, clips idle, walk, run`.

### 3.4 Check it in the LOD test

Add the model to `MODELS` in `apps/city/src/lod/LodPage.tsx`:

```ts
{
  id: 'man',
  name: 'Man',
  url: '/models/man.glb',
  targets: HUMAN_LOD_TRIANGLES, // ROBOT_LOD_TRIANGLES for a robot
  targetHeight: 1.75,
},
```

Run `yarn dev` and open `/lod`. It shows LOD0 to LOD4 side by side with their triangle counts and
the distances where the crowd draws each. Check:

- **walk, idle and run** all play, the arms swing and the feet do not slide;
- **no stretched triangles** at the shoulders, hips or knees (weights on the wrong joint);
- **textures** are intact at every LOD (the simplifier can open a seam at LOD2 and below, which is
  only visible up close);
- **wireframe** shows the triangles go where the silhouette needs them;
- the **source** line shows the triangle and bone counts you expect.

### 3.5 Use it in the crowd

The crowd's models are set in `apps/city/src/MapPage.tsx`:

```ts
humanModels: ['/models/man.glb', '/models/woman.glb'],
robotModel: '/models/optimus.glb',
```

- **To replace a model**, change its URL (and the label in `apps/city/src/ui/Panel.tsx`).
- **To add a human model**, append it to `humanModels`, add its count to `CrowdMix` and to
  `humanShares` in the same order, and add a row to the panel's crowd section. A model's index in
  `humanModels` is its variant id in the agent record (up to 127).
- **One robot model** is supported; robots are a separate family with their own LOD targets.

Then open the map with only that model, e.g. `/?region=docklands&robots=0`, and set its count to
100k to fill the streets near the start view.

## 4. Levels of detail

The app builds the LODs when it loads: each level is simplified from the previous one with
meshoptimizer (`packages/assets-runtime/src/simplify-geometry.ts`), each sub-mesh keeping its share
of the target. A mesh already below a target is reused as it is.

|                            |    LOD0 |   LOD1 |   LOD2 |  LOD3 | LOD4 | Impostor    |
| -------------------------- | ------: | -----: | -----: | ----: | ---: | ----------- |
| People, triangles          |  24,000 | 10,000 |  4,000 | 1,000 |  350 | quad        |
| Robots, triangles          | 120,000 | 50,000 | 15,000 | 3,500 |  750 | quad        |
| Brief preset, drawn from   |  124 px |  46 px |  18 px |  7 px |      | below 5 px  |
| Density preset, drawn from |  168 px | 120 px |  73 px | 37 px |      | below 20 px |

- The pixel heights are the agent's projected height on screen; at 1080p and a 60° view a 1.8 m
  person is LOD0 to about 14 m, LOD1 to 37 m, LOD2 to 94 m and LOD3 to 241 m (Brief).
- **Impostors** are baked from LOD2 at load: 16 directions × 2 pitches × 8 walk frames, 64 × 128 px
  each, so a model's look far away comes from its LOD2.
- **Caps**: at most 96 / 1,024 / 8,192 people and 8 / 64 / 1,024 robots at LOD0 / 1 / 2; an
  agent whose band is full is drawn as an impostor. A global bias keeps visible triangles under 10M.
- The targets are in `packages/render/src/lod-policy.ts` (`HUMAN_LOD_TRIANGLES`,
  `ROBOT_LOD_TRIANGLES`). Authored LODs (made by hand in Blender) would replace `buildLodChain`.

### 4.1 How the browser builds them

Each character is one GLB. The LODs are made **once per page, at load**, not every frame:

1. **Load** the GLB (`loadCharacter`).
2. **Build five LODs** (`buildLodChain`, `packages/render/src/build-lods.ts`), each simplified from
   the previous one, so the steps are gentler than always starting from LOD0.
3. **Bake impostors** from LOD2 (`bakeImpostors`): the character is rendered into a texture atlas
   from 16 directions × 2 pitches × 8 walk frames, for the farthest people.
4. **Cache:** the results are kept for the page, so changing the crowd size does not rebuild them.

The simplifier is [meshoptimizer](https://github.com/zeux/meshoptimizer), a C++ library compiled
to WebAssembly (`packages/assets-runtime/src/simplify-geometry.ts`). It collapses the edges whose
removal changes the shape least until the target triangle count is reached; where seams (UV cuts,
separate parts) stop that pass well short of the target, a coarser "sloppy" pass finishes it.
Only the triangle list changes: the vertices, with their bone weights, are shared by all five
levels, so every LOD uses the same skeleton and animation and switching levels does not jump.

The only per-frame work is the choice of level: a GPU compute pass measures each agent's height on
screen and picks its LOD or impostor, within the caps above.

Measured in Chrome on an Apple M1 Pro (5 October 2026):

| Model | Load and parse | Build 5 LODs | Triangles LOD0 → LOD4                  |
| ----- | -------------: | -----------: | -------------------------------------- |
| Man   |          47 ms |        12 ms | 16,737 → 9,985 → 4,024 → 1,089 → 494   |
| Woman |          27 ms |         9 ms | 15,292 → 9,998 → 3,995 → 1,005 → 372   |
| Robot |          62 ms |        81 ms | 119,993 → 49,993 → 7,805 → 3,053 → 713 |

The robot's LOD2 comes in under its target (7.8k for 15k) because the sloppy pass took over.

### 4.2 Why not pre-made LOD files

`buildLodChain` began as a stand-in for authored LODs, and it stays because it suits these models:

- **One file per character**: a new or re-rigged model needs no LOD export; the auto-rig output is
  used as it is.
- **A smaller download**: separate LOD files would add roughly half as much again per character.
- **Less GPU memory**: the levels share one vertex buffer; separate LOD files usually carry their
  own.
- **Cheap**: about 0.1 s for all three models, once.

The costs: no hand-tuning of a level, texture seams can open from LOD2 down (by then a person is a
few pixels tall), and the work is repeated on every visit (a little more on a phone).

Million Cars authors its car LODs in Blender: its Porsche starts at 653,000 triangles with many
parts and materials, where careful reduction pays off. These characters start at 15,000–120,000
triangles, where automatic simplification is enough. Authored LODs would replace `buildLodChain`
and nothing else.

**Not a WebGPU feature.** The simplification runs on the CPU in WebAssembly and would work the same
under WebGL. WebGPU draws the crowd, bakes the impostors and runs the per-frame LOD choice as a
compute pass; Million Cars, on WebGL, sorts its cars into LOD buckets in a worker instead.

### 4.3 The LOD test page

`/lod` uses the same method: it loads the chosen model and calls the same `buildLodChain` with the
same targets, then shows LOD0 to LOD4 side by side with their triangle counts and the distance at
which the crowd draws each. So what it shows is exactly the meshes the crowd uses. Two differences:
it animates them as ordinary three.js skinned meshes rather than through the crowd's GPU path, and
it shows no impostors (they exist only in the crowd).

## 5. Budgets

|                  |               Man |          Woman |   Robot |
| ---------------- | ----------------: | -------------: | ------: |
| Source triangles |            16,737 |         15,292 | 122,706 |
| File             |            1.8 MB |         2.6 MB |  7.0 MB |
| Textures         | 10 small (0.8 MB) | up to 1,024 px |    none |

- Load time grows with the source triangles, because simplification and impostor baking run in
  the browser.
- Phones start with 2,000 agents, but every model is still loaded and baked: keep files small.
- More materials mean more draws: each sub-mesh is one indirect draw per LOD.

## 6. Troubleshooting

| Symptom                                              | Cause                                               | Fix                                                              |
| ---------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| auto-rig skins instead of retargeting a rigged model | Joint names do not match Mixamo's                   | Rename the main joints (section 3.2)                             |
| `ENOENT … Xbot.glb`                                  | Relative path; the command runs in `tools/auto-rig` | Use absolute paths (`$PWD/…`)                                    |
| Model lies down or faces backwards                   | Exported Z-up or facing −Z                          | Export Y-up; auto-rig turns it to +Z                             |
| Model is tiny or huge in `/lod`                      | Units                                               | Ignore: the crowd scales to 1.75 m; set `targetHeight` in `/lod` |
| Feet slide                                           | The played clip is not a walk                       | The crowd prefers a walk-like clip name; keep auto-rig's `walk`  |
| Texture seams at far LODs                            | Simplification across UV seams                      | Expected below LOD2; author LODs if it shows                     |
| Slow loading                                         | Large source mesh or textures                       | Decimate the source; textures to 1,024 px                        |

## 7. Deploying a model

Model files are git-ignored (`apps/city/public/models`), so they are not in the repository or on
GitHub, but the demo build copies them into the site: after `vercel build` they are public. Check
the licence first (section 3.1), then deploy.
