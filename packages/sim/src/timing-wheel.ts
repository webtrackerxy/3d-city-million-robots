/**
 * Hashed timing wheel (implementation plan §15): agents are filed under the time slot of their
 * next event, so a tick touches only agents whose events are due — cost scales with the event
 * rate, not the agent count.
 *
 * Slots are `slotMs` wide; events further ahead than the wheel's horizon are filed at the
 * horizon, and the visitor re-files them when they pop early (their due time is still ahead).
 */
export class TimingWheel {
  readonly slotMs: number;
  private readonly slots: Uint32Array[];
  private readonly lengths: Uint32Array;
  private readonly slotCount: number;
  /** Next slot (absolute index) that has not been drained. */
  private cursor: number;

  constructor(startMs: number, slotMs = 16, slotCount = 4096) {
    this.slotMs = slotMs;
    this.slotCount = slotCount;
    this.slots = Array.from({ length: slotCount }, () => new Uint32Array(8));
    this.lengths = new Uint32Array(slotCount);
    this.cursor = Math.floor(startMs / slotMs);
  }

  get horizonMs(): number {
    return (this.slotCount - 2) * this.slotMs;
  }

  schedule(agent: number, dueMs: number): void {
    let slot = Math.max(Math.floor(dueMs / this.slotMs), this.cursor);
    // Never the slot being drained (cursor − 1 modulo the wheel), which is refilled from index 0.
    slot = Math.min(slot, this.cursor + this.slotCount - 2);
    const index = slot % this.slotCount;
    let items = this.slots[index];
    const length = this.lengths[index];
    if (length === items.length) {
      const grown = new Uint32Array(items.length * 2);
      grown.set(items);
      this.slots[index] = grown;
      items = grown;
    }
    items[length] = agent;
    this.lengths[index] = length + 1;
  }

  /**
   * Drains every slot that ends at or before `nowMs`, calling `visit` for each agent filed there.
   * `visit` may schedule again (into later slots). Returns the number of agents visited.
   */
  advanceTo(nowMs: number, visit: (agent: number) => void): number {
    let visited = 0;
    const last = Math.floor(nowMs / this.slotMs) - 1;
    while (this.cursor <= last) {
      const index = this.cursor % this.slotCount;
      const items = this.slots[index];
      const length = this.lengths[index];
      this.lengths[index] = 0;
      this.cursor++;
      for (let i = 0; i < length; i++) visit(items[i]);
      visited += length;
    }
    return visited;
  }
}
