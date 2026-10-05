/// <reference lib="webworker" />
import { readNavTile } from '@city/formats';
import { edgeCosts, PEDESTRIAN, ROBOT, Router, routingGraphFromTile } from '@city/nav';
import type { ProfileName, RouteRequest, RouteResult } from './protocol.ts';

/**
 * Routing worker (implementation plan §11, stage 1): A* per profile, with an LRU of recent
 * routes keyed by (origin, destination, profile) so repeated trips cost a map lookup.
 */
const CACHE_SIZE = 512;
let routers: Record<ProfileName, Router> | null = null;
const cache = new Map<string, Omit<RouteResult, 'id' | 'ms' | 'cached'>>();

self.onmessage = (event: MessageEvent<RouteRequest>) => {
  const request = event.data;
  if (request.kind === 'init') {
    const tile = readNavTile(request.files);
    const graph = routingGraphFromTile(tile);
    routers = {
      pedestrian: new Router(graph, edgeCosts(tile, PEDESTRIAN)),
      robot: new Router(graph, edgeCosts(tile, ROBOT)),
    };
    cache.clear();
    return;
  }
  if (routers === null) throw new Error('Route worker used before init');
  const key = `${request.profile}:${request.from}:${request.to}`;
  const hit = cache.get(key);
  if (hit !== undefined) {
    cache.delete(key);
    cache.set(key, hit);
    reply({ ...hit, id: request.id, ms: 0, cached: true });
    return;
  }
  const t0 = performance.now();
  const route = routers[request.profile].find(request.from, request.to);
  const ms = performance.now() - t0;
  const result = {
    found: route !== null,
    halfEdges: route?.halfEdges ?? new Uint32Array(0),
    lengthM: route?.lengthM ?? 0,
    cost: route?.cost ?? 0,
    expanded: route?.expanded ?? 0,
  };
  cache.set(key, result);
  if (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  reply({ ...result, id: request.id, ms, cached: false });
};

function reply(result: RouteResult): void {
  // Copy: the cached half-edge array must stay usable here.
  self.postMessage({ ...result, halfEdges: result.halfEdges.slice() });
}
