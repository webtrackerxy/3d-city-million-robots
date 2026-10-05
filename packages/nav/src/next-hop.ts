import type { RoutingGraph } from './routing.ts';

/**
 * Next-hop tables (implementation plan §11, stage 2+): for a destination node, every node stores
 * which of its outgoing half-edges leads towards it — one byte per node, the slot in the node's
 * adjacency list. An agent then carries only its destination, and a junction decision is one
 * lookup: no per-agent path, no per-trip search.
 *
 * Tables are built lazily (one Dijkstra from the destination, costs are symmetric) and kept in an
 * LRU. Canary Wharf: ~10k nodes → 10 kB per destination.
 *
 * A destination can also be a set of nodes (a destination cluster, Appendix A `nexthop.bin`): the
 * table then leads to the nearest of them, and callers finish the last stretch to the exact node
 * another way. Keys are the caller's: a node id, or a cluster id — one kind per instance.
 *
 * With a `maxCost`, the search stops at that cost from the destination and the table is sparse:
 * the nodes reached, each packed with its slot as `node << 8 | slot` and sorted, 4 bytes a node.
 * A city-sized graph (London, ~1.5M nodes) with trips of a walk's length then needs a few hundred
 * kB per destination instead of 1.5 MB.
 */
export const NO_HOP = 0xff;

/** Dense (a slot per node) or sparse (sorted `node << 8 | slot`). */
type Table = { dense: Uint8Array } | { sparse: Uint32Array };

function slotIn(table: Table, node: number): number {
  if ('dense' in table) return table.dense[node];
  const packed = table.sparse;
  const key = node * 256;
  let lo = 0;
  let hi = packed.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (packed[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo < packed.length && packed[lo] >>> 8 === node ? packed[lo] & 0xff : NO_HOP;
}

export class NextHopTables {
  private readonly graph: RoutingGraph;
  private readonly costs: Float32Array;
  private readonly maxTables: number;
  private readonly maxCost: number;
  private readonly maxBytes: number;
  private readonly tables = new Map<number, Table>();
  private tableBytes = 0;
  /** Slot of each half-edge in its start node's adjacency list. */
  private readonly slotOf: Uint8Array;
  // Dijkstra scratch.
  private readonly dist: Float64Array;
  private readonly done: Uint8Array;
  private heapNode = new Uint32Array(1024);
  private heapKey = new Float64Array(1024);
  private heapSize = 0;
  /** Nodes whose `dist` was set by the last build (reset before the next). */
  private touched = new Uint32Array(1024);
  /** Bounded builds: the slot found for each node, and the settled nodes packed. */
  private readonly slotScratch: Uint8Array;
  private settled = new Uint32Array(1024);
  private touchedCount = 0;
  builds = 0;

  /**
   * `maxTables` caps the cache; bounded tables (`maxCost` finite) are also capped at
   * `maxBytes`.
   */
  constructor(
    graph: RoutingGraph,
    costs: Float32Array,
    maxTables = 4096,
    maxCost = Infinity,
    maxBytes = Infinity,
  ) {
    this.maxBytes = maxBytes;
    this.graph = graph;
    this.costs = costs;
    this.maxTables = maxTables;
    this.maxCost = maxCost;
    const n = graph.firstHalfEdge.length - 1;
    if (maxCost !== Infinity && n >= 1 << 24)
      throw new RangeError(`${n} nodes: sparse tables pack node ids in 24 bits`);
    this.slotOf = new Uint8Array(graph.adjacency.length);
    for (let node = 0; node < n; node++) {
      const first = graph.firstHalfEdge[node];
      const degree = graph.firstHalfEdge[node + 1] - first;
      if (degree >= NO_HOP) throw new RangeError(`Node ${node} has degree ${degree} (max 254)`);
      for (let i = 0; i < degree; i++) this.slotOf[graph.adjacency[first + i]] = i;
    }
    this.dist = new Float64Array(n).fill(Infinity);
    this.slotScratch = new Uint8Array(maxCost === Infinity ? 0 : n);
    this.done = new Uint8Array(n);
  }

  get size(): number {
    return this.tables.size;
  }

  /** Half-edge to take from `node` towards `dest`; −1 at the destination or when unreachable. */
  next(node: number, dest: number): number {
    if (node === dest) return -1;
    return this.nextTo(node, dest, [dest]);
  }

  reachable(node: number, dest: number): boolean {
    return node === dest || slotIn(this.table(dest, [dest]), node) !== NO_HOP;
  }

  /** Towards the nearest of `sources` (cached under `key`); −1 at one of them or unreachable. */
  nextTo(node: number, key: number, sources: Iterable<number> & ArrayLike<number>): number {
    const slot = slotIn(this.table(key, sources), node);
    return slot === NO_HOP ? -1 : this.graph.adjacency[this.graph.firstHalfEdge[node] + slot];
  }

  /** Whether `node` can reach one of `sources` (true at a source itself). */
  reachableTo(node: number, key: number, sources: Iterable<number> & ArrayLike<number>): boolean {
    if (slotIn(this.table(key, sources), node) !== NO_HOP) return true;
    for (const source of sources) if (source === node) return true;
    return false;
  }

  /** Bytes held by the cached tables. */
  get bytes(): number {
    return this.tableBytes;
  }

  private table(key: number, sources: Iterable<number> & ArrayLike<number> = [key]): Table {
    let table = this.tables.get(key);
    if (table !== undefined) {
      this.tables.delete(key);
      this.tables.set(key, table);
      return table;
    }
    table = this.build(sources);
    this.tables.set(key, table);
    this.tableBytes += sizeOf(table);
    while (
      this.tables.size > 1 &&
      (this.tables.size > this.maxTables || this.tableBytes > this.maxBytes)
    ) {
      const oldest = this.tables.keys().next().value;
      if (oldest === undefined) break;
      this.tableBytes -= sizeOf(this.tables.get(oldest) ?? { dense: new Uint8Array(0) });
      this.tables.delete(oldest);
    }
    return table;
  }

  private build(sources: Iterable<number> & ArrayLike<number>): Table {
    this.builds++;
    const { firstHalfEdge, adjacency, edgeFrom, edgeTo } = this.graph;
    const bounded = this.maxCost !== Infinity;
    const dense = bounded ? null : new Uint8Array(this.dist.length).fill(NO_HOP);
    // Only the nodes the last search touched need resetting (a bounded search touches few).
    for (let i = 0; i < this.touchedCount; i++) {
      this.dist[this.touched[i]] = Infinity;
      this.done[this.touched[i]] = 0;
    }
    this.touchedCount = 0;
    this.heapSize = 0;
    // Bounded: each node's slot in a scratch array, and the settled nodes (all those within
    // maxCost — the search stops at the first beyond it) packed once at the end. (A Map here was
    // three quarters of London's spawn time.)
    let settled = 0;
    for (const source of sources) {
      this.touch(source);
      this.dist[source] = 0;
      this.slotScratch[source] = NO_HOP;
      this.push(source, 0);
    }
    while (this.heapSize > 0) {
      const u = this.pop();
      if (this.done[u] === 1) continue;
      this.done[u] = 1;
      const base = this.dist[u];
      if (base > this.maxCost) break;
      if (bounded && this.slotScratch[u] !== NO_HOP) {
        if (settled === this.settled.length) {
          const grown = new Uint32Array(this.settled.length * 2);
          grown.set(this.settled);
          this.settled = grown;
        }
        this.settled[settled++] = u * 256 + this.slotScratch[u];
      }
      for (let i = firstHalfEdge[u]; i < firstHalfEdge[u + 1]; i++) {
        const half = adjacency[i];
        const edge = half >>> 1;
        const cost = this.costs[edge];
        if (cost === Infinity) continue;
        const v = (half & 1) === 0 ? edgeTo[edge] : edgeFrom[edge];
        const candidate = base + cost;
        if (candidate < this.dist[v]) {
          if (this.dist[v] === Infinity) this.touch(v);
          this.dist[v] = candidate;
          // From v the way to dest is back along this edge: the reverse half-edge.
          if (dense !== null) dense[v] = this.slotOf[half ^ 1];
          else this.slotScratch[v] = this.slotOf[half ^ 1];
          this.push(v, candidate);
        }
      }
    }
    if (dense !== null) return { dense };
    return { sparse: this.settled.slice(0, settled).sort() };
  }

  private touch(node: number): void {
    if (this.touchedCount === this.touched.length) {
      const grown = new Uint32Array(this.touched.length * 2);
      grown.set(this.touched);
      this.touched = grown;
    }
    this.touched[this.touchedCount++] = node;
  }

  private push(node: number, key: number): void {
    if (this.heapSize === this.heapNode.length) {
      const nodes = new Uint32Array(this.heapSize * 2);
      const keys = new Float64Array(this.heapSize * 2);
      nodes.set(this.heapNode);
      keys.set(this.heapKey);
      this.heapNode = nodes;
      this.heapKey = keys;
    }
    let i = this.heapSize++;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heapKey[parent] <= key) break;
      this.heapNode[i] = this.heapNode[parent];
      this.heapKey[i] = this.heapKey[parent];
      i = parent;
    }
    this.heapNode[i] = node;
    this.heapKey[i] = key;
  }

  private pop(): number {
    const top = this.heapNode[0];
    const size = --this.heapSize;
    const node = this.heapNode[size];
    const key = this.heapKey[size];
    let i = 0;
    for (;;) {
      let child = 2 * i + 1;
      if (child >= size) break;
      if (child + 1 < size && this.heapKey[child + 1] < this.heapKey[child]) child++;
      if (this.heapKey[child] >= key) break;
      this.heapNode[i] = this.heapNode[child];
      this.heapKey[i] = this.heapKey[child];
      i = child;
    }
    this.heapNode[i] = node;
    this.heapKey[i] = key;
    return top;
  }
}

function sizeOf(table: Table): number {
  return 'dense' in table ? table.dense.byteLength : table.sparse.byteLength;
}
