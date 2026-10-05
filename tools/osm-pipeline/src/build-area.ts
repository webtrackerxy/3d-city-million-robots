import type { Point } from './geometry.ts';
import type { OsmData } from './opl.ts';
import { extractBuildings, type Building } from './buildings.ts';
import { closeGaps } from './connect.ts';
import { connectEntrances } from './entrances.ts';
import { pedestrianWays } from './pedestrian.ts';
import type { LocalFrame } from './projection.ts';
import { connectivity } from './qa.ts';
import { inferSidewalks, isRoad } from './sidewalks.ts';
import { connectStations } from './stations.ts';
import { applyTerrain, type Terrain } from './terrain.ts';
import { type Grid, splitIntoTiles, type TiledRegion } from './tiling.ts';
import { buildTopology, type Topology } from './topology.ts';
import { Barriers, SegmentIndex, WaySet } from './way-set.ts';
import { buildNavTile } from './write-region.ts';
import type { NavTile } from '@city/formats';
import { clearWalls } from './wall-clearance.ts';

export interface AreaInput {
  data: OsmData;
  frame: LocalFrame;
  /** Region-frame clipping box: buildings, stations and the graph end here. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  positions: Map<number, Point>;
  /** The region's tile grid (shared by every chunk of a chunked build). */
  grid: Grid;
  landMasses: number;
  step: (label: string) => void;
  /**
   * Ground heights (see terrain.ts): heights become metres above `zero` (m ODN), by default the
   * median ground under the nodes. A chunked build passes one zero for all its chunks.
   */
  terrain?: { terrain: Terrain; zero: number | 'median' } | undefined;
}

export interface AreaResult {
  /** The untiled graph of the area. */
  tile: NavTile;
  tiled: TiledRegion;
  topology: Topology;
  buildings: Building[];
  qa: Record<string, number>;
}

/**
 * Stages 3–11 (implementation plan §10) over one area: pedestrian ways, buildings, inferred
 * sidewalks and crossings, gap closing, entrances and stations, topology, tiles. A region is one
 * area; a city too large to hold at once is built as chunks (chunked.ts), each an area on the
 * same frame and grid.
 */
export function buildArea(input: AreaInput): AreaResult {
  const { data, frame, bounds, positions, grid, step } = input;
  // Stage 3: mapped pedestrian ways.
  const set = new WaySet(positions);
  for (const { way, attributes } of pedestrianWays(data.ways.values()))
    set.add({ id: way.id, refs: [...way.refs], attributes });
  step(`mapped pedestrian ways: ${set.ways.length}`);

  // Stage 8 (needed by 5–9 as barriers): buildings.
  const { buildings, qa: buildingQa } = extractBuildings(
    data,
    (lon, lat) => frame.toLocal(lon, lat),
    bounds,
  );
  step(`buildings: ${buildingQa.buildings} + ${buildingQa.parts} parts`);

  // Stages 5–6: sidewalks inferred from roads, crossings.
  const roads = [...data.ways.values()]
    .filter((way) => isRoad(way.tags))
    .map((way) => ({ id: way.id, refs: way.refs, tags: way.tags }));
  const nodeTags = new Map([...data.nodes.values()].map((node) => [node.id, node.tags] as const));
  const sidewalkQa = inferSidewalks(set, roads, nodeTags);
  step(
    `sidewalks: ${(sidewalkQa.inferredLengthM / 1000).toFixed(1)} km inferred, ${(sidewalkQa.suppressedLengthM / 1000).toFixed(1)} km suppressed; crossings ${sidewalkQa.mappedCrossings} mapped, ${sidewalkQa.implicitCrossings} implicit`,
  );

  // Gap closing and stage 9: entrances.
  const roadBarriers = new Barriers();
  const gapBarriers = new Barriers();
  for (const road of roads)
    for (let i = 0; i + 1 < road.refs.length; i++) {
      const a = positions.get(road.refs[i]);
      const b = positions.get(road.refs[i + 1]);
      if (a === undefined || b === undefined) continue;
      roadBarriers.add(a, b);
      gapBarriers.add(a, b);
    }
  for (const building of buildings)
    building.ring.forEach((a, k) => {
      gapBarriers.add(a, building.ring[(k + 1) % building.ring.length]);
    });
  const index = new SegmentIndex(set);
  const gapQa = closeGaps(set, index, gapBarriers, bounds);
  step(`gaps: ${gapQa.connected} of ${gapQa.deadEnds} dead ends joined`);
  const { entrances, qa: entranceQa } = connectEntrances(
    set,
    index,
    roadBarriers,
    data,
    buildings,
    (lon, lat) => frame.toLocal(lon, lat),
  );
  const stationQa = connectStations(
    set,
    index,
    roadBarriers,
    data,
    buildings,
    entrances,
    (lon, lat) => frame.toLocal(lon, lat),
    bounds,
  );
  step(
    `stations: ${stationQa.stations} with ${stationQa.connected} of ${stationQa.entrances} entrances linked`,
  );
  step(
    `entrances: ${entranceQa.mapped} mapped (${entranceQa.mappedUnreachable} unreachable), ${entranceQa.synthetic} synthetic, ${entranceQa.buildingsWithoutEntrance} buildings without`,
  );

  // Stage 4: topology over mapped + generated ways.
  const topology = buildTopology({
    positions,
    ways: set.ways,
    bounds,
    keepNodes: new Set(entrances.keys()),
  });
  const inTopology = new Set(topology.nodes.map((n) => n.osmId));
  const lostEntrances = [...entrances.keys()].filter((id) => !inTopology.has(id)).length;
  step(
    `pedestrian graph: ${topology.nodes.length} nodes, ${topology.edges.length} edges, ${(topology.qa.lengthM / 1000).toFixed(1)} km`,
  );

  // Stage 11: tile + manifest.
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
  const tileSizeM = Math.ceil(extent / 256) * 256;
  const tile = buildNavTile(topology, buildings, tileSizeM, entrances);
  // Paths along facades are narrowed so walkers spread across them stay outside the walls.
  const wallQa = clearWalls(tile);
  step(
    `walls: ${wallQa.edgesNarrowed} paths narrowed to clear building walls (${wallQa.kmNarrowed.toFixed(1)} km)`,
  );
  // Stage 12 (Phase 3 of the 3D Tiles plan): put the region on the terrain before tiling.
  let terrainQa: Record<string, number> = {};
  if (input.terrain !== undefined) {
    terrainQa = applyTerrain(tile, input.terrain.terrain, input.frame, input.terrain.zero);
    step(
      `terrain: heights ${terrainQa.minHeightM.toFixed(1)} to ${terrainQa.maxHeightM.toFixed(1)} m about the origin, ${terrainQa.nodesFilledFromNeighbours} bridge or no-data nodes from neighbours`,
    );
  }
  const tiled = splitIntoTiles(tile, grid);
  step(
    `tiles: ${tiled.qa.tiles} × ${grid.sizeM} m, ${tiled.qa.portals} portals, ${tiled.qa.splitEdges} edges split at boundaries`,
  );
  const connected = connectivity(tile, input.landMasses);
  const qa: Record<string, number> = {
    ...prefix('graph', topology.qa),
    'graph.danglingShare': connected.danglingShare,
    'graph.connectedShare': connected.connectedShare,
    ...prefix('sidewalks', sidewalkQa),
    ...prefix('gaps', gapQa),
    ...prefix('entrances', entranceQa),
    ...prefix('stations', stationQa),
    'entrances.nodes': connected.entrances,
    /** Entrances clipped at the region edge or whose connector fell outside it. */
    'entrances.lost': lostEntrances,
    'entrances.connectedShare': connected.entranceConnectedShare,
    'entrances.buildingsReachableShare': connected.buildingsReachableShare,
    ...prefix('buildings', buildingQa),
    ...prefix('terrain', terrainQa),
    ...prefix('walls', { ...wallQa }),
    ...prefix('tiles', tiled.qa),
  };
  return { tile, tiled, topology, buildings, qa };
}

function prefix(name: string, values: object): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [`${name}.${k}`, Number(v)]));
}
