import { useEffect, useState } from 'react';

export type LoadStepId = 'map' | 'graph' | 'buildings' | 'crowd' | 'simulation' | 'traffic';

export interface LoadStep {
  label: string;
  /** Share of the whole bar. */
  weight: number;
  state: 'waiting' | 'active' | 'done' | 'skipped';
  /** Measured progress 0–1, or null to estimate from `expectMs`. */
  fraction: number | null;
  /** Typical duration, for steps without measurable progress. */
  expectMs: number;
  detail: string;
  startedAt: number | null;
  ms: number | null;
}

export const LOAD_STEPS: Record<LoadStepId, LoadStep> = {
  map: step('Base map', 5, 2_000),
  graph: step('City graph', 15, 4_000),
  buildings: step('Buildings around the view', 10, 5_000),
  crowd: step('People and robot models', 25, 10_000),
  simulation: step('Spawning people and robots', 35, 15_000),
  traffic: step('Traffic', 10, 5_000),
};

function step(label: string, weight: number, expectMs: number): LoadStep {
  return {
    label,
    weight,
    state: 'waiting',
    fraction: null,
    expectMs,
    detail: '',
    startedAt: null,
    ms: null,
  };
}

const finished = (s: LoadStep) => s.state === 'done' || s.state === 'skipped';

/** The share of a step that is done: measured, or estimated from its elapsed time. */
function progressOf(s: LoadStep, now: number): number {
  if (finished(s)) return 1;
  if (s.state === 'waiting' || s.startedAt === null) return 0;
  if (s.fraction !== null) return s.fraction;
  return Math.min(0.9, Math.max(0, now - s.startedAt) / s.expectMs);
}

/**
 * Start-up progress (a city takes tens of seconds: a 125 MB graph, models to bake, a million
 * agents to spawn): one bar for the whole, and each step with its state and time. Fades out once
 * everything is ready.
 */
export function LoadingPanel({
  steps,
  title,
}: {
  steps: Record<LoadStepId, LoadStep>;
  title: string;
}) {
  const [now, setNow] = useState(() => performance.now());
  const list = Object.values(steps);
  const done = list.every(finished);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    if (done) {
      const timer = setTimeout(() => {
        setHidden(true);
      }, 1200);
      return () => {
        clearTimeout(timer);
      };
    }
    const timer = setInterval(() => {
      setNow(performance.now());
    }, 200);
    return () => {
      clearInterval(timer);
    };
  }, [done]);
  if (hidden) return null;
  const total = list.reduce((sum, s) => sum + (s.state === 'skipped' ? 0 : s.weight), 0);
  const reached = list.reduce(
    (sum, s) => sum + (s.state === 'skipped' ? 0 : s.weight * progressOf(s, now)),
    0,
  );
  const percent = Math.round((reached / Math.max(1, total)) * 100);
  const started = list.reduce((t, s) => Math.min(t, s.startedAt ?? Infinity), Infinity);
  return (
    <div className={done ? 'loading loading-done' : 'loading'} role="status" aria-live="polite">
      <div className="loading-head">
        <span>{done ? `${title} ready` : `Loading ${title}…`}</span>
        <span>
          {percent}%
          {Number.isFinite(started) && ` · ${Math.max(0, (now - started) / 1000).toFixed(0)} s`}
        </span>
      </div>
      <div className="loading-bar">
        <div style={{ width: `${percent}%` }} />
      </div>
      <ol className="loading-steps">
        {list
          .filter((s) => s.state !== 'skipped')
          .map((s) => (
            <li key={s.label} className={`loading-${s.state}`}>
              <span className="loading-mark">
                {s.state === 'done' ? '✓' : s.state === 'active' ? '•' : '○'}
              </span>
              <span className="loading-label">
                {s.label}
                {s.state === 'active' && s.detail !== '' && (
                  <span className="loading-detail"> — {s.detail}</span>
                )}
              </span>
              <span className="loading-time">
                {s.ms !== null
                  ? `${(s.ms / 1000).toFixed(1)} s`
                  : s.state === 'active' && s.startedAt !== null
                    ? `${Math.max(0, (now - s.startedAt) / 1000).toFixed(0)} s`
                    : ''}
              </span>
            </li>
          ))}
      </ol>
    </div>
  );
}
