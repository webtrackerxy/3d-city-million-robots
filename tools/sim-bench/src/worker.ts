import { AGENT_RECORD_BYTES } from '@city/core-types';
import { AgentStore, Simulation } from '@city/sim';
import { parentPort, workerData } from 'node:worker_threads';
import { COUNTER_FIELDS, type WorkerSetup } from './protocol.ts';

const setup = workerData as WorkerSetup;
const control = new Int32Array(setup.control);
const timings = new Float64Array(setup.timings);
const counters = new Float64Array(setup.counters);

const store = new AgentStore(setup.agents, setup.capacity);
const simulation = new Simulation({
  graph: setup.graph,
  store,
  start: setup.start,
  end: setup.end,
  seed: setup.seed + setup.index * 7919,
  ...(setup.focus === undefined ? {} : { focus: setup.focus }),
  avoidance: setup.avoidance,
});
// Upload staging: dirty records are packed here each tick, as the render host would read them.
const staging = new DataView(new ArrayBuffer((setup.end - setup.start) * AGENT_RECORD_BYTES));
simulation.drainDirty(() => undefined);

/** Every worker waits until all have finished the tick (sense-reversing generation barrier). */
function barrier(): void {
  const generation = Atomics.load(control, 0);
  if (Atomics.add(control, 1, 1) + 1 === setup.workers) {
    Atomics.store(control, 1, 0);
    Atomics.add(control, 0, 1);
    Atomics.notify(control, 0);
  } else {
    Atomics.wait(control, 0, generation);
  }
}

Atomics.add(control, 2, 1);
barrier();
const total = setup.warmupTicks + setup.ticks;
for (let tick = 1; tick <= total; tick++) {
  const started = performance.now();
  const stats = simulation.step(tick * setup.tickMs);
  let packed = 0;
  const dirty = simulation.drainDirty((agent) => {
    store.writeRecord(agent, staging, packed++);
  });
  const elapsed = performance.now() - started;
  const measured = tick - setup.warmupTicks - 1;
  if (measured >= 0) {
    timings[setup.index * setup.ticks + measured] = elapsed;
    const c = setup.index * COUNTER_FIELDS;
    const add = (field: number, value: number) => {
      counters[c + field] = (counters[c + field] ?? 0) + value;
    };
    add(0, stats.events);
    add(1, dirty);
    add(2, stats.nearAgents);
    add(3, stats.lateralChanges);
  }
  barrier();
}
parentPort?.postMessage('done');
