import type { SeriesStats } from '@city/metrics';
import { type CharacterInfo, familyLabel } from '@city/render';
import { type BenchmarkResult, resultFileName } from '../harness/benchmark-result.ts';
import { RenderPathKind, type Scenario } from '../harness/scenario.ts';
import { formatInteger } from './format.ts';

const AGENT_PRESETS = [100, 500, 1000, 2000, 5000] as const;

const PATH_LABELS: Record<RenderPathKind, string> = {
  [RenderPathKind.Idle]: 'Idle · clear pass only',
  [RenderPathKind.A]: 'A · SkinnedMesh + mixer each',
  [RenderPathKind.B]: 'B · baked, GPU skinned, instanced',
  [RenderPathKind.C]: 'C · raw WebGPU, same buffers',
  [RenderPathKind.Transfer]: 'Transfer · sim → GPU (Q10)',
};

interface Props {
  scenario: Scenario;
  characters: readonly CharacterInfo[];
  agents: number;
  sweep: { active: boolean; step: number; steps: number; measuring: boolean };
  results: readonly BenchmarkResult[];
  onSetAgents: (count: number) => void;
  onRunSweep: () => void;
}

export function BenchmarkControls({
  scenario,
  characters,
  agents,
  sweep,
  results,
  onSetAgents,
  onRunSweep,
}: Props) {
  const latest = results[results.length - 1];
  const humanBases = characters.filter((character) => character.key !== 'robot').length;

  return (
    <>
      <section>
        <h2>Scenario</h2>
        <div className="row">
          <span>Render path</span>
          <span>{PATH_LABELS[scenario.path]}</span>
        </div>
        {characters.map((character) => (
          <div key={character.key} className="family">
            <div className="row">
              <span>{familyLabel(character.key, humanBases)}</span>
              <span>
                {character.model}
                {characters.length > 1 && character.key === 'robot'
                  ? ` · ${Math.round(scenario.robotShare * 100)}%`
                  : ''}
              </span>
            </div>
            <div className="row">
              <span>Clip / bones / triangles</span>
              <span>
                {character.clip} / {character.bones} / {formatInteger(character.triangles)}
                {character.triangles < character.sourceTriangles
                  ? ` (of ${formatInteger(character.sourceTriangles)})`
                  : ''}
              </span>
            </div>
            <div className="row">
              <span>Skin influences</span>
              <span>
                {character.influences.join(' · ')}
                {character.mergedParts ? ' · parts merged' : ''}
              </span>
            </div>
          </div>
        ))}
        {scenario.warnings.map((warning) => (
          <p key={warning} className="warning">
            Ignored {warning}
          </p>
        ))}
      </section>

      <section>
        <h2>Agents</h2>
        <div className="buttons">
          {AGENT_PRESETS.map((count) => (
            <button
              key={count}
              type="button"
              className={count === agents ? 'active' : undefined}
              disabled={sweep.active}
              onClick={() => {
                onSetAgents(count);
              }}
            >
              {formatInteger(count)}
            </button>
          ))}
        </div>
        <div className="buttons">
          <button type="button" className="primary" disabled={sweep.active} onClick={onRunSweep}>
            {sweep.active
              ? `Sweep ${sweep.step}/${sweep.steps} · ${sweep.measuring ? 'measuring' : 'warming up'}`
              : `Run sweep · ${scenario.sweep.map(formatInteger).join(' · ')}`}
          </button>
        </div>
        <p className="hint">
          {scenario.warmupMs / 1000} s warm-up + {scenario.measureMs / 1000} s measured per step.
          FPS is capped by the display unless Chrome runs with{' '}
          <code>--disable-frame-rate-limit</code>; CPU and GPU times are not.
        </p>
      </section>

      {latest && (
        <section>
          <h2>Last sweep · p95 ms</h2>
          <table className="results">
            <thead>
              <tr>
                <th>Agents</th>
                <th>FPS</th>
                <th>Frame</th>
                <th>CPU</th>
                <th>Anim</th>
                <th>GPU</th>
              </tr>
            </thead>
            <tbody>
              {latest.steps.map((step) => (
                <tr key={step.agents}>
                  <td>{formatInteger(step.agents)}</td>
                  <td>{step.fps.toFixed(1)}</td>
                  <td>{p95(step.intervalMs)}</td>
                  <td>{p95(step.cpuMs)}</td>
                  <td>{p95(step.animMs)}</td>
                  <td>{p95(step.gpuMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="buttons">
            <button
              type="button"
              onClick={() => {
                downloadJson(latest);
              }}
            >
              Download JSON
            </button>
          </div>
        </section>
      )}
    </>
  );
}

function p95(stats: SeriesStats | null): string {
  return stats === null || stats.count === 0 ? '–' : stats.p95.toFixed(2);
}

function downloadJson(result: BenchmarkResult): void {
  const blob = new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = resultFileName(result);
  link.click();
  URL.revokeObjectURL(url);
}
