import type { MetricsBus, MetricsSnapshot, SeriesStats } from '@city/metrics';
import { useEffect, useState } from 'react';
import type { EngineStatus } from '../gpu/benchmark-engine.ts';
import type { BenchmarkResult } from '../harness/benchmark-result.ts';
import type { Scenario } from '../harness/scenario.ts';
import type { LodControls } from '../paths/render-path.ts';
import { RenderPathKind } from '../harness/scenario.ts';
import { BenchmarkControls } from './BenchmarkControls.tsx';
import { LodPanel } from './LodPanel.tsx';
import { formatBytes, formatInteger, formatMs } from './format.ts';

const POLL_INTERVAL_MS = 250;
const FRAME_BUDGET_MS = 1000 / 60;

interface Props {
  bus: MetricsBus;
  status: EngineStatus;
  scenario: Scenario;
  results: readonly BenchmarkResult[];
  onSetAgents: (count: number) => void;
  onRunSweep: () => void;
  lodControls: LodControls;
  onLodControls: (controls: LodControls) => void;
}

export function DebugPanel({
  bus,
  status,
  scenario,
  results,
  onSetAgents,
  onRunSweep,
  lodControls,
  onLodControls,
}: Props) {
  const [snapshot, setSnapshot] = useState<MetricsSnapshot>(() => bus.snapshot());

  useEffect(() => {
    const timer = setInterval(() => {
      setSnapshot(bus.snapshot());
    }, POLL_INTERVAL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [bus]);

  const { gauges, series } = snapshot;
  const interval = series['frame.intervalMs'];
  const gpuBytes = (gauges['gpu.bufferBytes'] ?? 0) + (gauges['gpu.textureBytes'] ?? 0);

  return (
    <aside className="panel">
      <h1>Character LOD benchmark · step 0.9</h1>

      {status.state === 'running' ? (
        <BenchmarkControls
          scenario={scenario}
          characters={status.characters}
          agents={gauges['agents.total'] ?? 0}
          sweep={{
            active: gauges['sweep.active'] === 1,
            step: gauges['sweep.step'] ?? 0,
            steps: gauges['sweep.steps'] ?? 0,
            measuring: gauges['sweep.measuring'] === 1,
          }}
          results={results}
          onSetAgents={onSetAgents}
          onRunSweep={onRunSweep}
        />
      ) : (
        <p>{status.state === 'starting' ? status.message : ''}</p>
      )}

      {status.state === 'running' &&
        scenario.path !== RenderPathKind.A &&
        scenario.path !== RenderPathKind.Idle && (
          <LodPanel
            families={status.characters.map((character) => character.key)}
            controls={lodControls}
            gauges={gauges}
            onChange={onLodControls}
          />
        )}

      <section>
        <h2>Frame · p50 / p95 / p99 ms</h2>
        <Row
          label="FPS"
          value={interval && interval.mean > 0 ? (1000 / interval.mean).toFixed(1) : '–'}
        />
        <SeriesRow label="Frame interval" stats={interval} />
        <SeriesRow label="CPU frame" stats={series['frame.cpuMs']} />
        <SeriesRow label="Animation update" stats={series['anim.updateMs']} />
        <SeriesRow label="GPU frame" stats={series['gpu.frameMs']} />
        <Row
          label="CPU headroom"
          value={formatMs(
            series['frame.cpuMs'] ? FRAME_BUDGET_MS - series['frame.cpuMs'].p95 : undefined,
          )}
        />
      </section>

      <section>
        <h2>Scene</h2>
        <Row
          label="Agents visible / total"
          value={`${formatInteger(gauges['agents.visible'])} / ${formatInteger(gauges['agents.total'])}`}
        />
        <Row label="Triangles" value={formatInteger(gauges['render.triangles'])} />
        <Row label="Draw calls" value={formatInteger(gauges['render.drawCalls'])} />
        <Row
          label="Canvas"
          value={`${formatInteger(gauges['canvas.width'])} × ${formatInteger(gauges['canvas.height'])}`}
        />
      </section>

      {gauges['kernel.integrate.checked'] !== undefined && (
        <section>
          <h2>WGSL kernels vs CPU reference</h2>
          <Row
            label="integrate · max position error"
            value={`${(gauges['kernel.integrate.maxError'] ?? 0).toExponential(1)} m`}
            tone={(gauges['kernel.integrate.maxError'] ?? 1) < 1e-3 ? 'good' : 'bad'}
          />
          <Row
            label="integrate · frame mismatches"
            value={`${formatInteger(gauges['kernel.integrate.frameMismatches'])} / ${formatInteger(gauges['kernel.integrate.checked'])}`}
            tone={gauges['kernel.integrate.frameMismatches'] === 0 ? 'good' : 'bad'}
          />
        </section>
      )}

      {status.state === 'running' &&
        status.characters.map((character) => (
          <BakeSection key={character.key} family={character.key} gauges={gauges} />
        ))}

      <section>
        <h2>Memory</h2>
        <Row label="GPU tracked" value={formatBytes(gpuBytes)} />
        <Row label="GPU peak" value={formatBytes(gauges['gpu.peakBytes'] ?? 0)} />
        <Row
          label="Buffers / textures"
          value={`${formatInteger(gauges['gpu.bufferCount'])} / ${formatInteger(gauges['gpu.textureCount'])}`}
        />
        <Row label="JS heap" value={formatJsHeap()} />
        <Row label="Cross-origin isolated" value={crossOriginIsolated ? 'yes' : 'NO'} />
        <Row
          label="SharedArrayBuffer"
          value={typeof SharedArrayBuffer === 'function' ? 'yes' : 'NO'}
        />
      </section>

      {status.state === 'running' ? (
        <>
          <section>
            <h2>Adapter</h2>
            <Row label="Vendor" value={status.report.vendor || '–'} />
            <Row label="Architecture" value={status.report.architecture || '–'} />
            <Row
              label="Device"
              value={status.report.deviceName || status.report.description || '–'}
            />
          </section>

          <section>
            <h2>Features</h2>
            {status.report.features.map((feature) => (
              <Row
                key={feature.name}
                label={feature.name}
                value={feature.device ? 'enabled' : feature.adapter ? 'available' : 'missing'}
                tone={feature.device ? 'good' : 'bad'}
              />
            ))}
          </section>

          <section>
            <h2>Limits (device / adapter)</h2>
            {status.report.limits.map((limit) => (
              <Row
                key={limit.name}
                label={limit.name}
                value={`${formatLimit(limit.name, limit.device)} / ${formatLimit(limit.name, limit.adapter)}`}
              />
            ))}
          </section>
        </>
      ) : null}
    </aside>
  );
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="row">
      <span>{label}</span>
      <span className={tone}>{value}</span>
    </div>
  );
}

function BakeSection({
  family,
  gauges,
}: {
  family: string;
  gauges: Readonly<Record<string, number>>;
}) {
  const g = (name: string) => gauges[`anim.${family}.${name}`];
  return (
    <section>
      <h2>Animation bake · {family}</h2>
      <Row
        label="Bones / clips"
        value={`${formatInteger(g('boneCount'))} / ${formatInteger(g('clipCount'))}`}
      />
      <Row label="Frames baked" value={formatInteger(g('frameCount'))} />
      <Row label="Matrix buffer" value={formatBytes(g('matrixBytes') ?? 0)} />
      <Row label="Bake time" value={formatMs(g('bakeMs'))} />
      <BakeErrorRow error={g('maxErrorM')} />
      <Row
        label="Clip speed / stride"
        value={
          (g('clipSpeed') ?? 0) > 0
            ? `${(g('clipSpeed') ?? 0).toFixed(2)} m/s / ${(g('strideM') ?? 0).toFixed(2)} m`
            : 'in place'
        }
      />
      <FootSlideRow slide={g('footSlide')} speed={g('clipSpeed')} />
    </section>
  );
}

/** Same tolerance as the unit test: baked skinning must match Three within 0.1 mm. */
const BAKE_TOLERANCE_M = 1e-4;

function BakeErrorRow({ error }: { error: number | undefined }) {
  if (error === undefined) return <Row label="Max vertex error" value="–" />;
  const ok = error < BAKE_TOLERANCE_M;
  return (
    <Row
      label="Max vertex error"
      value={`${error.toExponential(1)} m ${ok ? '✓' : '✗'}`}
      tone={ok ? 'good' : 'bad'}
    />
  );
}

/** Planted-foot drift above 5% of walking speed reads as skating. */
const FOOT_SLIDE_TOLERANCE = 0.05;

function FootSlideRow({ slide, speed }: { slide: number | undefined; speed: number | undefined }) {
  if (slide === undefined || speed === undefined || speed <= 0) {
    return <Row label="Foot slide" value="–" />;
  }
  const ok = slide / speed < FOOT_SLIDE_TOLERANCE;
  return (
    <Row
      label="Foot slide"
      value={`${(slide * 100).toFixed(1)} cm/s (${((slide / speed) * 100).toFixed(1)}%) ${ok ? '✓' : '✗'}`}
      tone={ok ? 'good' : 'bad'}
    />
  );
}

function SeriesRow({ label, stats }: { label: string; stats: SeriesStats | undefined }) {
  const value =
    stats === undefined || stats.count === 0
      ? '–'
      : `${stats.p50.toFixed(2)} / ${stats.p95.toFixed(2)} / ${stats.p99.toFixed(2)}`;
  return <Row label={label} value={value} />;
}

function formatLimit(name: string, value: number): string {
  return name.endsWith('Size') && value >= 1024 ? formatBytes(value) : formatInteger(value);
}

/** performance.memory is Chrome-only and non-standard; good enough for a live readout. */
function formatJsHeap(): string {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory === undefined ? 'n/a' : formatBytes(memory.usedJSHeapSize);
}
