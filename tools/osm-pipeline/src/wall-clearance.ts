import { BuildingFlag, EdgeFlag, EdgeType } from '@city/core-types';
import type { NavTile } from '@city/formats';

/**
 * Walkers spread across a path's width (lanes either side of its line), so a pavement drawn along a
 * facade sends some of them into the wall. This narrows each open-air ground-level path to the
 * clearance its line has from the nearest building wall, less a body's half-width, so people stay
 * outside; paths with nothing near keep their width.
 */

/** Half a walker's shoulder width, kept clear of the wall. */
const BODY_M = 0.35;
/** A path is never narrowed below this (one lane on its line). */
export const MIN_WIDTH_CM = 100;
/** Points along each path are tested this far apart. */
const STEP_M = 2;
/** Points this close to a path's ends are not tested (junctions and entrances meet walls). */
const END_M = 1.5;
/** The clearance is this low quantile of the points' distances (one corner does not narrow it). */
const QUANTILE = 0.2;
const CELL_M = 16;

export interface WallClearanceQa {
  edgesNarrowed: number;
  kmNarrowed: number;
}

export function clearWalls(tile: NavTile): WallClearanceQa {
  const { buildings: b, edges, nodes, polylines } = tile;
  // Wall segments by grid cell.
  const segments: number[] = [];
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => (cx + 32768) * 65536 + (cy + 32768);
  for (let i = 0; i < b.ringOffset.length; i++) {
    if (((b.flags[i] ?? 0) & BuildingFlag.Virtual) !== 0) continue;
    const o = b.ringOffset[i] ?? 0;
    const n = b.ringCount[i] ?? 0;
    for (let k = 0; k < n; k++) {
      const x1 = b.ringX[o + k] ?? 0;
      const y1 = b.ringY[o + k] ?? 0;
      const x2 = b.ringX[o + ((k + 1) % n)] ?? 0;
      const y2 = b.ringY[o + ((k + 1) % n)] ?? 0;
      const s = segments.length / 4;
      segments.push(x1, y1, x2, y2);
      for (
        let cx = Math.floor(Math.min(x1, x2) / CELL_M);
        cx <= Math.floor(Math.max(x1, x2) / CELL_M);
        cx++
      )
        for (
          let cy = Math.floor(Math.min(y1, y2) / CELL_M);
          cy <= Math.floor(Math.max(y1, y2) / CELL_M);
          cy++
        ) {
          const list = grid.get(key(cx, cy));
          if (list === undefined) grid.set(key(cx, cy), [s]);
          else list.push(s);
        }
    }
  }
  const wallDistance = (x: number, y: number, reach: number) => {
    let best = reach;
    const r = Math.ceil(reach / CELL_M);
    const cx = Math.floor(x / CELL_M);
    const cy = Math.floor(y / CELL_M);
    for (let dx = -r; dx <= r; dx++)
      for (let dy = -r; dy <= r; dy++)
        for (const s of grid.get(key(cx + dx, cy + dy)) ?? []) {
          const x1 = segments[s * 4] ?? 0;
          const y1 = segments[s * 4 + 1] ?? 0;
          const ex = (segments[s * 4 + 2] ?? 0) - x1;
          const ey = (segments[s * 4 + 3] ?? 0) - y1;
          const len2 = ex * ex + ey * ey;
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - x1) * ex + (y - y1) * ey) / len2)) : 0;
          best = Math.min(best, Math.hypot(x - x1 - t * ex, y - y1 - t * ey));
        }
    return best;
  };

  const skip = EdgeFlag.Bridge | EdgeFlag.Tunnel | EdgeFlag.Indoor | EdgeFlag.Covered;
  const qa: WallClearanceQa = { edgesNarrowed: 0, kmNarrowed: 0 };
  for (let e = 0; e < edges.from.length; e++) {
    const width = edges.widthCm[e] ?? 0;
    if (width <= MIN_WIDTH_CM) continue;
    const type = edges.type[e];
    if (type === EdgeType.Entrance || type === EdgeType.Corridor || type === EdgeType.Elevator)
      continue;
    if (((edges.flags[e] ?? 0) & skip) !== 0) continue;
    const from = edges.from[e] ?? 0;
    const to = edges.to[e] ?? 0;
    if (nodes.level[from] !== 0 || nodes.level[to] !== 0) continue;
    // The path's line: its end nodes with the polyline points between.
    const xs = [nodes.x[from] ?? 0];
    const ys = [nodes.y[from] ?? 0];
    const p0 = edges.polyOffset[e] ?? 0;
    for (let k = 0; k < (edges.polyCount[e] ?? 0); k++) {
      xs.push(polylines.x[p0 + k] ?? 0);
      ys.push(polylines.y[p0 + k] ?? 0);
    }
    xs.push(nodes.x[to] ?? 0);
    ys.push(nodes.y[to] ?? 0);
    const length = edges.length[e] ?? 0;
    if (length < 2 * END_M) continue;
    const reach = width / 200 + BODY_M;
    const distances: number[] = [];
    let along = 0;
    for (let k = 1; k < xs.length; k++) {
      const ax = xs[k - 1] ?? 0;
      const ay = ys[k - 1] ?? 0;
      const seg = Math.hypot((xs[k] ?? 0) - ax, (ys[k] ?? 0) - ay);
      for (let s = 0; s < seg; s += STEP_M) {
        const at = along + s;
        if (at < END_M || at > length - END_M) continue;
        const f = seg > 0 ? s / seg : 0;
        distances.push(
          wallDistance(ax + f * ((xs[k] ?? 0) - ax), ay + f * ((ys[k] ?? 0) - ay), reach),
        );
      }
      along += seg;
    }
    if (distances.length === 0) continue;
    distances.sort((p, q) => p - q);
    const clearance = distances[Math.floor(QUANTILE * (distances.length - 1))] ?? reach;
    const fits = Math.max(MIN_WIDTH_CM, Math.floor((clearance - BODY_M) * 200));
    if (fits < width) {
      edges.widthCm[e] = fits;
      qa.edgesNarrowed++;
      qa.kmNarrowed += length / 1000;
    }
  }
  return qa;
}
