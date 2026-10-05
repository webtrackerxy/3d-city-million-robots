# Map guide

How to use the city map: opening it, moving around, the panel, places, the crowd and traffic,
routes, layers, building names, and what every number on screen means. For how it works inside,
see [system-design.md](system-design.md); for running and changing the simulation, see
[simulation.md](simulation.md).

## 1. Opening the map

| Where                      | Address                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| Live demo (Central London) | https://3d-city-million-robots.vercel.app                                  |
| Locally, after `yarn dev`  | http://localhost:5173 (London), or http://localhost:5173/?region=docklands |

The map needs **WebGPU**: a current desktop Chrome, Edge or Safari. Phones, tablets and headsets
see a _Not supported on mobile_ notice instead, with a link to the WebGL test; **Try anyway**
loads the map with lighter phone settings. A browser without WebGPU shows what it needs.

### Map XR (headsets)

The **Map XR** tab (`/map-xr`) opens the same city for a VR headset: our own buildings, the
walking network on a plain ground, 20,000 people and robots and 2,000 cars (`?agents=` and
`?cars=` change them), without the street map or 3D tiles (MapLibre cannot draw in a headset).
Choose a place, then press **Enter XR**: you stand in the street at the centre of the view, among
the crowd, at your own height.

#### Controller guide (Meta Quest 2 Touch controllers)

Left controller:

| Button     | Where                        | In Map XR                                                                |
| ---------- | ---------------------------- | ------------------------------------------------------------------------ |
| Thumbstick | top                          | Walk the way you look: forward, back, or sideways to step left and right |
| Trigger    | index finger                 | Hold while walking: faster (6 m/s instead of 1.6 m/s)                    |
| Grip       | middle finger, side          | Hold while walking: faster (as the trigger)                              |
| X, Y       | face buttons                 | Not used                                                                 |
| Menu (☰)  | small button below the stick | Not used by Map XR (the Quest may use it)                                |

Right controller:

| Button               | Where                        | In Map XR                                                                |
| -------------------- | ---------------------------- | ------------------------------------------------------------------------ |
| Thumbstick           | top                          | Push left or right to turn 30°; let go and push again for another turn   |
| B                    | upper face button            | Leave VR and go back to the page                                         |
| A                    | lower face button            | Not used                                                                 |
| Trigger, grip        | index and middle finger      | Not used                                                                 |
| Meta (Oculus) button | round button below the stick | The Quest's: press for its menu (which also has Exit); hold to re-centre |

```
        LEFT                                RIGHT
   [Y]  [X]                            [B] = leave VR   [A]
   (thumbstick) = walk                 (thumbstick ←/→) = turn 30°
   ☰ menu                              ⊚ Meta = Quest menu / hold: re-centre
   trigger / grip (hold) = faster      trigger / grip = —
```

Tips:

- **Comfort**: snap turns and walking pace are the gentlest; use the fast speed for longer trips,
  and stop and look at something still if you feel queasy.
- **Your own steps**: walking for real within the Guardian boundary moves you too.
- **Re-centre**: if "forward" feels wrong, hold the Meta button.
- The mapping follows the WebXR `xr-standard` gamepad layout (left and right stick axes 2 and 3,
  trigger button 0, grip 1, B 5, in `apps/city/src/xr-webgl/xr-controls.ts`). A, X, Y and the
  right trigger are free for later features.

You stay on the ground as it rises and falls, and walk through buildings (there is no collision).
After 250 m the ground and buildings are refreshed round you. In the desktop preview, WASD walks,
Q/E turns, Shift goes faster and Escape closes it.

Where the browser offers WebXR with WebGPU, the headset shows the same WebGPU city. Where it does
not (the Meta Quest Browser), Enter XR switches to a lighter **WebGL** city round the same running
simulation: the buildings within 700 m, the ground with its terrain, the nearest 300 people and
robots (skinned in the vertex shader from the same baked animation, by nearness: the nearest 16
within 12 m at LOD1, the next 64 within 40 m at LOD2, the rest at LOD3; robots: the nearest
4 within 10 m at LOD1, the next 24 within 25 m at LOD2, then LOD3 and LOD4) and the nearest 60 cars. `?xrPeople=` and `?xrCars=` change those numbers; `?xrPreview=1` shows the WebGL view on
the page instead of a headset (Escape closes it), to check it on a desktop. The `/xr` page reports
what a headset's browser supports.

### Clicking a person, robot or car

Click someone in the crowd or a car to select it: a cyan ring and arrow mark it (shown through
buildings too), and a card at the top right says what it is and what it is doing:

| For        | The card shows                                                                          |
| ---------- | --------------------------------------------------------------------------------------- |
| Man, woman | The model and its author, walking / waiting to cross / on a roof, speed, heading, where |
| Robot      | The same, for the Optimus model                                                         |
| Car        | The Porsche model and its author, paint, speed, heading, where                          |

**Follow** keeps the camera on it; **×** or a click on empty ground clears the selection (that
click still picks building entrances for a route).

### Regions

| Region         | Area                                              | Opens at                                                                                | Where                  |
| -------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------- |
| Central London | 9.8 × 3.6 km: Buckingham Palace to Island Gardens | Trafalgar Square, close, with 1 million people and robots on the streets (the showcase) | Live demo, and locally |
| Docklands      | 4.2 × 4.3 km: Limehouse, Poplar, Isle of Dogs     | Canary Wharf from above, 10,000 people and robots                                       | Locally                |
| London         | 20 × 20 km round Trafalgar Square                 | Trafalgar Square, close, with 2 million people and robots on the streets (the showcase) | Locally                |
| Canary Wharf   | About 2 × 2 km                                    | The whole region from above                                                             | Locally                |

### Loading

A panel shows the steps and their progress: **Base map**, **City graph**, **Buildings around
the view**, **People and robot models**, **Spawning people and robots**, **Traffic**. Docklands
takes about 20 seconds; London longer. Keep the tab in front while it loads: browsers pause
background tabs.

## 2. Moving around

| Action          | Mouse / trackpad                   | Touch                                 |
| --------------- | ---------------------------------- | ------------------------------------- |
| Pan             | Drag                               | Drag with one finger                  |
| Zoom            | Scroll, or double-click to zoom in | Pinch                                 |
| Rotate and tilt | Right-drag, or Ctrl + drag         | Two-finger rotate and drag up or down |

### Map controls (top right)

| Control                | What it does                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **+ / −**              | Zoom in and out                                                                                                                                                      |
| **Compass**            | Shows the heading and tilt; click to face north                                                                                                                      |
| **Globe**              | Switches between the globe and a flat map                                                                                                                            |
| **N**                  | Face north                                                                                                                                                           |
| **Look straight down** | Tilts to a top-down view; click again to tilt back                                                                                                                   |
| **OSM / Photo**        | Which buildings: the city's own from OpenStreetMap, or photorealistic 3D tiles (see section 8). Shown only when the build has a Cesium ion token (local development) |

The scale bar at the bottom right shows metres at the bottom of the view; with a tilted view,
things further away are smaller.

## 3. The panel

The panel on the left holds everything else. Its header shows the region and the size of its
data; the **chevron** at the top right collapses it (phones start collapsed). Its sections, top
to bottom: Places, Crowd, Traffic, Route, Layers, Pipeline QA, Render.

## 4. Places

One click flies the camera to a place in three seconds.

| Place                 | View                                                              | In Docklands                                                                     | In London   |
| --------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ----------- |
| **Trafalgar Square**  | Close over the square, facing north                               | Reloads into the London region there (not on the live demo, which has no London) | Flies there |
| **Canary Wharf**      | South of One Canada Square, looking south-east                    | Flies there                                                                      | Flies there |
| **Buckingham Palace** | By the Victoria Memorial, looking south-west to the Palace        | As Trafalgar Square                                                              | Flies there |
| **Island Gardens**    | Low over Manchester Road by the station, looking north-north-east | Flies there                                                                      | Flies there |

A link can open at a place: `?place=trafalgar-square`, `?place=canary-wharf`,
`?place=buckingham-palace` or `?place=island-gardens`.

**Your own view for a place:** set up the view, click **Copy view** in the Render section, and
paste the copied line into the place in `apps/city/src/map/places.ts` (`camera`).

## 5. The crowd

| Control                             | What it does                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| **Robots / Woman / Man**            | How many of each: Robots Off–1M; Woman and Man Off–500k each. The crowd restarts with the new numbers                               |
| **Pause · 1× · 4× · 16×**           | Simulation speed                                                                                                                    |
| **Roof view: Off / Person / Robot** | Follows someone walking on a roof. The camera tracks them and a log lists what they do. Click again to pick someone else; Off stops |

At the start, a share of the population is out walking, depending on the time of day (5 % at
8:00); the rest are inside buildings and come out over time. One in a hundred walkers walks on roofs.

### What the crowd numbers mean

| Row                                    | Meaning                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Time of day                            | Simulated clock (starts 8:00)                                                                        |
| Population · rows · aggregated         | Everyone in the region · people simulated individually · people counted inside buildings             |
| Walking · waiting · on roofs · indoors | Out walking · waiting at a crossing · on roof walks · inside buildings                               |
| Near tier (T0) · tables                | People within 150 m of the view's centre, who step round each other · route tables in use            |
| Visible · triangles · LOD bias         | People drawn · triangles drawn · level-of-detail scale (1 = full detail; lower when the GPU is busy) |
| Sim clock                              | Simulated time since the start                                                                       |
| Worker per sim second                  | Simulation cost: milliseconds of worker time per simulated second                                    |
| Records · this frame                   | Agent updates per second · updates sent to the GPU this frame                                        |
| Frame rate                             | Frames per second                                                                                    |

People and robots switch between five levels of detail and, far away, flat impostors, so close
ones are detailed and a million can be drawn.

## 6. Traffic

| Control / row                        | Meaning                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| **Off · 1k · 5k · 20k · 50k · 100k** | Number of cars (default about 60 per km of road)              |
| Cars · roads                         | Cars · length of the road network                             |
| Drawn LOD0–3 · boxes                 | Cars drawn at each level of detail · as simple boxes far away |
| Worker per tick                      | Traffic simulation cost per 0.1 s tick                        |

Cars drive on the left. They do not yet stop for people at crossings.

## 7. Routes

1. Choose **Pedestrian** or **Robot**.
2. Click near a building entrance (magenta posts), then near a second one.

The route is drawn on the streets, with its **Distance**, **Time** (at 1.34 m/s walking, 1.2 m/s
for a robot) and **Crossings · steps**. Robots avoid steps and prefer mapped crossings, so their
routes can differ. **Random route** picks two entrances; **Clear** removes the route. If two
entrances are not connected for that profile, the panel says so.

## 8. Layers

| Layer                             | What it does                                                                                                                                                                                                                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Map type: Streets / Satellite** | Street map (OpenFreeMap) or satellite imagery (Esri) with the street names                                                                                                                                                                                                                        |
| **Buildings**                     | The city's own buildings on or off                                                                                                                                                                                                                                                                |
| **Building names**                | Names over named buildings (section 9)                                                                                                                                                                                                                                                            |
| **Building transparency**         | 0–90 %: fades the buildings (and the 3D tiles); see-through buildings no longer hide the people behind them                                                                                                                                                                                       |
| **Pedestrian network**            | The walking graph the simulation uses, as lines                                                                                                                                                                                                                                                   |
| **Entrances**                     | Building entrances as posts; synthetic ones (added where none is mapped) are paler                                                                                                                                                                                                                |
| **Ways on other levels**          | Network lines on other floors (bridges, tunnels)                                                                                                                                                                                                                                                  |
| **Dead ends**                     | Marks the network's dead ends                                                                                                                                                                                                                                                                     |
| **Network colouring**             | Colours the network by **Source** (mapped, inferred sidewalk, crossing, implicit crossing, entrance link), **Edge type** (footway, crossing, steps, pedestrian area, shared path, entrance link) or **Component** (the largest connected part in green, others one colour each); a legend follows |

### 3D tiles (OSM / Photo)

**Photo** in the map controls replaces the city's buildings with Google's photorealistic 3D tiles
(through Cesium ion): real façades, trees, river and docks, with the crowd and cars walking and
driving among them. **OSM** switches back. While Photo is on, the city's and the base map's
buildings are hidden, the transparency slider fades the tiles, and "Google" is credited at the
bottom right. `?tiles=photorealistic` opens with it on.

The walking graph is flat while real streets are not, so in places with several levels (Canary
Wharf's raised decks and lower dock roads) people can appear a few metres above or below the
tiles' streets.

## 9. Building names

Up to 40 named buildings in view within 3 km are labelled, tallest and nearest first, without
overlapping each other or the panel; further ones are fainter. When you are close to a tower
whose roof is above the screen, its name stays at the top edge. Names come from OpenStreetMap
(1,455 in Docklands). Labels are not hidden by buildings in front of them.

## 10. Pipeline QA and Render

**Pipeline QA** shows the region's data and its quality checks: nodes, edges and tiles; network
length; inferred sidewalks; connected share (by length); entrances connected; buildings
reachable; mapped and implicit crossings; mapped and synthetic entrances; dead ends; buildings;
buildings with a default height.

**Render**:

| Row                   | Meaning                                                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Frame rate            | Frames per second                                                                                                        |
| Buildings drawn       | Buildings in the loaded tiles                                                                                            |
| Line segments         | Network lines drawn                                                                                                      |
| Zoom · tilt · heading | The map camera: zoom level, tilt from straight down, heading clockwise from north                                        |
| Centre                | Latitude and longitude at the centre of the view                                                                         |
| 3D tiles ground       | With Photo on: the tiles' ground at the view, metres above the WGS84 ellipsoid, where the city's flat streets are placed |
| **Copy view**         | Copies the camera as one line, for a place's view (section 4)                                                            |

## 11. Links (URL parameters)

Add these to the address, joined with `&` after `?`.

| Parameter    | Example                | Effect                                                                                   |
| ------------ | ---------------------- | ---------------------------------------------------------------------------------------- |
| `region`     | `region=docklands`     | Region to load                                                                           |
| `place`      | `place=canary-wharf`   | Start at a place                                                                         |
| `at`         | `at=0,0,60,110`        | Start looking at x, y (metres from the region's origin) from a height and distance south |
| `basemap`    | `basemap=satellite`    | `vector`, `satellite`, `imagery` (no names) or `none` (no base map)                      |
| `tiles`      | `tiles=photorealistic` | Start with 3D tiles (with a token)                                                       |
| `agents`     | `agents=100000`        | People and robots simulated individually                                                 |
| `population` | `population=1000000`   | People in the region; those without a row wait in buildings                              |
| `robots`     | `robots=0.5`           | Share of robots                                                                          |
| `startHour`  | `startHour=17.5`       | Time of day at the start                                                                 |
| `timeScale`  | `timeScale=16`         | Simulation speed at the start                                                            |
| `cars`       | `cars=0`               | Number of cars                                                                           |
| `roofs`      | `roofs=0.2`            | Share of walkers on roofs                                                                |
| `workers`    | `workers=2`            | Simulation workers                                                                       |
| `seed`       | `seed=42`              | Random seed (the same seed and worker count give the same run)                           |
| `showcase`   | `showcase=0`           | The London street showcase off or on                                                     |
| `mobile`     | `mobile=0`             | Overrides the phone detection                                                            |

Examples:

- One million people at the morning peak, fast:
  `?region=docklands&population=1000000&agents=200000&startHour=8.5&workers=2&timeScale=16`
- Robots only, no cars, on satellite imagery: `?region=docklands&robots=1&cars=0&basemap=satellite`

## 12. Phones and performance

- Phones start lighter: 2,000 people and robots, 5,000 cars, one worker. Raise the numbers with
  care: mobile browsers close tabs that use too much memory.
- On a desktop, large crowds are mainly limited by the GPU. If the frame rate drops, lower the
  counts, zoom out (far people are drawn as impostors), or turn traffic off.
- Keep the tab in front: a background tab stops drawing and pauses loading.

## 13. Troubleshooting

| Problem                                                   | What to do                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| _Not supported on mobile_                                 | Use a desktop browser, or **Try anyway** (iOS 26+ for WebGPU)                           |
| "This demo needs WebGPU"                                  | Update the browser, or use Chrome or Edge                                               |
| Stuck at _Base map_                                       | Bring the tab to the front; check the network                                           |
| No people visible                                         | Zoom in; most people start indoors (raise the counts, or `startHour` for a busier hour) |
| OSM / Photo buttons missing                               | The build has no Cesium ion token (the live demo has none)                              |
| Trafalgar Square or Buckingham Palace missing from Places | The live demo has no London data                                                        |

## 14. Credits

Map data © OpenStreetMap contributors (ODbL); base map OpenFreeMap / OpenMapTiles; imagery ©
Esri and its partners; photorealistic 3D tiles © Google, through Cesium ion. Character models:
Tesla Optimus (robot), the Invisible Woman, and "Cool Man" by ardhanaputra (CC BY 4.0, man); cars
from the
3d-city-million-cars project.
