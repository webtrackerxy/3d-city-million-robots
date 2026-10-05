# Building regions

How the OSM pipeline turns an OpenStreetMap extract into a region: walking graph, buildings, terrain, roads, names; London built in chunks.

## Building a region

```sh
mkdir -p data/raw
curl -Lo data/raw/greater-london-$(date +%y%m%d).osm.pbf \
  https://download.geofabrik.de/europe/united-kingdom/england/greater-london-latest.osm.pbf
yarn region                      # --region canary-wharf --pbf <file> --out <dir> --tile-size 256
yarn dev:city                    # http://localhost:5173
```

The pipeline (plan §10) uses the newest `.osm.pbf` in `data/raw/`:

1. **Extract**: `osmium extract` the region box and `tags-filter` highways, buildings, parts,
   multipolygons and entrances into `data/work/<region>/`.
2. **Project** to British National Grid (EPSG:27700), then to a tile-local frame in metres.
3. **Mapped walkways**: footways, paths, pedestrian areas, steps, corridors, lifts, and cycleways
   with foot access.
4. **Buildings**: outer rings, heights from `height`, `building:levels` or type defaults, and
   capacity. Buildings come before the stages below because they act as barriers there.
5. **Sidewalks** inferred from road centrelines, using `sidewalk*` tags or a class default.
   - Each side is offset by half the carriageway plus 1 m.
   - At each road node, the arms are sorted by bearing, and neighbouring kerb lines meet at one
     corner per wedge.
   - Dead ends get a cap.
   - An inferred sidewalk is dropped where a mapped footway runs parallel within 4 m.
   - No sidewalks are inferred for `sidewalk=separate`, dual carriageways, trunk roads or
     tunnels.
6. **Crossings**: mapped `highway=crossing` nodes become kerb-to-kerb crossing edges. A junction
   arm without one within 20 m gets an _implicit_ crossing, flagged so routing charges extra.
7. **Gap closing**: a dead end within 5 m of another walkway is joined to it. The link can't cross
   a road or a building wall.
8. **Entrances**: each mapped `entrance=*` is assigned to the building whose wall it sits on and
   linked to the nearest walkway within 30 m. The link can't cross a road or a building.
   Buildings with no mapped entrance get a synthetic one on the wall nearest the network.
9. **Topology**: split at shared nodes, snap loose ends, contract degree-2 chains, simplify, and
   drop fragments under 30 m. Entrance nodes are never contracted, snapped or dropped.
10. **QA gates**: connectivity metrics go into the manifest. The build exits non-zero when a gate
    in `tools/osm-pipeline/src/regions.ts` fails, but still writes its output so the failure can
    be inspected in the viewer.
11. **Terrain**: ground heights from the Environment Agency's LIDAR Composite DTM (1 m, Open
    Government Licence), fetched from its WCS at `--terrain-res` metres (2 by default; 4 for the
    chunked London build) and cached in `data/raw/dtm/`. Nodes, polyline points and building bases
    take the ground under them, relative to the median ground of the nodes (`terrain.zeroM` in
    the manifest, metres above Ordnance Datum), so most streets sit near the flat base map's
    height. Nodes on bridges or tunnels take their neighbours' heights. Road nodes get heights the
    same way (`roads.bin` format RDS2), so cars drive on the terrain too. `--no-terrain` skips it.
12. **Tile and write**:
    - The graph is cut into 256 m tiles (decision 0004). Edges that cross a boundary are split
      there, with portals joining the two boundary nodes.
    - Coordinates become tile-local, and building ids are region-wide.
    - Format v1 files and `manifest.json` go to `apps/city/public/regions/<region>/`.
    - Every tile is read back and hash-compared, and the stitched tiles must match the untiled
      graph (length per OSM way, and connectivity).

Connectivity is measured per _land mass_. The Canary Wharf box includes a strip of Rotherhithe
across the Thames, which only a ferry connects, so the region declares `landMasses: 2`.

Building names for the map's labels come from the same extract, matched to the region's
buildings by OSM id, without rebuilding the tiles:

```sh
yarn workspace @city/osm-pipeline labels --region docklands   # writes labels.json beside the tiles
```

It also writes GeoJSON (in `debug/`) for QGIS. Each edge has a `source` of `mapped`, `inferred` or
`implicit`. Generated data is git-ignored. Map data is © OpenStreetMap contributors, ODbL.

### London (20 km)

The default region is the 3d-city-million-cars project's London: 20 × 20 km around Trafalgar
Square, 467k buildings, 1.24M graph nodes. It is too big to build or load whole, so:

```
yarn workspace @city/osm-pipeline build-chunked --region london --chunk-tiles 8   # ~5 min, ~2 GB
```

- **Chunked build** (`tools/osm-pipeline/src/chunked.ts`): 2 km chunks, each built with a 400 m
  margin on the region's frame and grid; seam portals are re-linked by position and buildings
  renumbered by OSM id. Built chunked, Docklands comes out identical to its one-piece build.
- **One graph file**: `region.nav` (106 MB, 39 MB compressed) is the stitched graph; the
  simulation and routing load it instead of stitching 5,900 tiles in the browser.
- **Each thing once**: `region.nav` keeps every building without its outline, and the tiles keep
  only buildings (46 MB), no walking graph (manifest `graph.buildingOutlines: "tiles"`). The app
  fills in the outlines round the start view, where the roof walks are built. London went from
  284 to 165 MB. `--stitch-only` slims an older build in place.
- **Streamed buildings**: the viewer draws its own buildings for tiles within 1.5 km of the view,
  loading and dropping them as the map moves; the base map's 3D buildings fill in the rest.
- **City-scale simulation**: trips of up to 1 km, 400 m destination clusters, bounded next-hop
  tables (168 MB per worker) and a strip of London per worker. The London showcase opens with 2M
  agents (1M robots, 500k women, 500k men; the Crowd panel sets each). 1M agents ran at
  60 fps with the workers at ~430 ms of compute per simulated second.
