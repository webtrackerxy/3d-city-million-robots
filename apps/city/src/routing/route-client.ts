import type { NavTileFiles } from '@city/formats';
import type { ProfileName, RouteRequest, RouteResult } from './protocol.ts';

/** Main-thread side of the routing worker: promise per request. */
export class RouteClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (result: RouteResult) => void>();
  private nextId = 1;

  constructor(files: NavTileFiles) {
    this.worker = new Worker(new URL('./route-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<RouteResult>) => {
      const resolve = this.pending.get(event.data.id);
      this.pending.delete(event.data.id);
      resolve?.(event.data);
    };
    // Copies: the main thread keeps its zero-copy views over the originals.
    this.post({ kind: 'init', files: structuredClone(files) });
  }

  route(from: number, to: number, profile: ProfileName): Promise<RouteResult> {
    const id = this.nextId++;
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.post({ kind: 'route', id, from, to, profile });
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }

  private post(request: RouteRequest): void {
    this.worker.postMessage(request);
  }
}
