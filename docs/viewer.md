# City viewer and WebGL test

The pipeline viewer (buildings and walking network) and the WebGL test page.

### The city viewer

- **Network colouring:**
  - **Source** (the pipeline viewer): mapped vs. inferred vs. implicit crossings.
  - **Edge type.**
  - **Connected component.**
- **Entrances:** magenta posts; synthetic ones are paler.
- **Routing:** click near one entrance, then another, to route between them. The worker runs A*
  with a pedestrian or robot profile; robots avoid steps and strongly prefer mapped crossings.
  **Random route** picks two entrances.
- **Top-down views:** `?at=x,y,height` starts looking down at a tile point, e.g.
  `?at=250,650,260` for kerb detail.
- **Map type:** Streets (OpenFreeMap) or Satellite (Esri World Imagery with the street labels),
  switched in place in the Layers section; `?basemap=satellite` opens on it.
- **Building names:** up to 40 named buildings in view within 3 km are labelled, tallest and
  nearest first, without overlapping; a tower whose roof is above the view keeps its label at the
  top edge. **Building names** in Layers turns them off.
- **Building transparency:** a 0–90 % slider fades the city's buildings and the base map's own 3D
  buildings. See-through buildings stop hiding the crowd behind them.
- **Panel:** the region header collapses the panel. It starts open on desktop and collapsed on
  phones.
- **Phones:** narrow or touch screens up to 1,024 px start lighter: 2,000 agents, 5,000 cars, one
  worker, smaller route tables and drawing buffers (`apps/city/src/device.ts`). URL parameters
  and the panel still override it.
- **No WebGPU:** the page says what it needs instead of failing.

### WebGL test (/webgl)

A proof for a WebGL 2 fallback (older iPhones, the Meta Quest Browser): the city's Optimus
robot, simplified to about 3,000 triangles (its LOD3 in the city) with meshoptimizer, its walk
baked into vertex animation textures; 1k–50k robots (5k to start) in one instanced draw that walk
and animate in the vertex shader, with frame rate, triangles and GPU shown, and **Enter VR** where
WebXR is available. (Before 5 October 2026 it used the CC0 RobotExpressive robot: on an M1 Pro,
60 fps up to 5k robots, 55 fps at 10k, 28 fps at 20k.) No WebGPU is used, so it runs where the city
does not.
