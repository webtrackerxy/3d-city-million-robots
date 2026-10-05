import { readRoadNetwork } from '@city/formats';
import { RoadNetwork, RoadTraffic, VehicleBuffer } from '@city/traffic';
import { CONTROL, type FromTrafficWorker, TICK_MS, type ToTrafficWorker } from './protocol.ts';

/** Runs the cars project's road traffic model and publishes 10 Hz snapshots. */
let timeScale = 1;
const post = (message: FromTrafficWorker) => {
  self.postMessage(message);
};

self.onmessage = (event: MessageEvent<ToTrafficWorker>) => {
  const message = event.data;
  if (message.kind === 'timeScale') {
    timeScale = message.scale;
    return;
  }
  try {
    start(message);
  } catch (e) {
    post({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};

function start(message: Extract<ToTrafficWorker, { kind: 'start' }>): void {
  const network = new RoadNetwork(readRoadNetwork(message.roads));
  const buffer = new VehicleBuffer(message.count);
  // London drives on the left.
  const traffic = new RoadTraffic(buffer, network, {
    count: message.count,
    seed: message.seed,
    tickInterval: TICK_MS / 1000,
    driveOnLeft: true,
  });
  const control = new Int32Array(message.shared.control);
  const snapshots = new Float32Array(message.shared.snapshots);
  const count = message.count;
  let slot = 0;
  const publish = () => {
    const out = snapshots.subarray(slot * count * 4, (slot + 1) * count * 4);
    buffer.packStateInto(out);
    Atomics.store(control, CONTROL.slot, slot);
    Atomics.store(control, CONTROL.count, count);
    Atomics.add(control, CONTROL.sequence, 1);
    slot = 1 - slot;
  };
  publish();
  post({ kind: 'ready', colours: buffer.color.slice(), roadKm: network.totalLength / 1000 });

  // A fixed step per tick; the time scale changes how much simulated time a tick covers.
  const loop = () => {
    const begin = performance.now();
    if (timeScale > 0) {
      const steps = Math.max(1, Math.round(timeScale));
      for (let k = 0; k < steps; k++) traffic.step((TICK_MS / 1000) * (timeScale / steps));
      publish();
    }
    Atomics.store(control, CONTROL.stepMicros, Math.round((performance.now() - begin) * 1000));
    setTimeout(loop, Math.max(0, TICK_MS - (performance.now() - begin)));
  };
  setTimeout(loop, TICK_MS);
}
