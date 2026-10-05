import { useEffect, useRef, useState } from 'react';
import '../lod/lod.css';
import './xr.css';
import { startWebglXrTest } from './webgl-xr-test.ts';
import { startWebgpuXrTest, type XrRun, type XrTest } from './webgpu-xr-test.ts';
import { probeXr, type XrProbe, xrPath } from './xr-probe.ts';

const COUNTS = [1_000, 5_000, 10_000, 20_000, 50_000];
const RUNS_KEY = 'city.xrRuns';

type Side = 'webgpu' | 'webgl';

function loadRuns(): XrRun[] {
  try {
    return JSON.parse(localStorage.getItem(RUNS_KEY) ?? '[]') as XrRun[];
  } catch {
    return [];
  }
}

function saveRuns(runs: XrRun[]): void {
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(runs));
  } catch {
    // Storage blocked: the runs stay on screen only.
  }
}

const yesNo = (v: boolean | null) => (v === null ? 'unknown' : v ? 'yes' : 'no');

/**
 * XR test (/xr, internal; not in the navigation): the XR plan's Phase 0 on a headset. It reports
 * what the browser offers (WebXR, WebGPU, the WebXR–WebGPU binding, multiview, memory) and runs
 * an A/B test: the same walking crowd in VR through WebGPU with a compute pass (A) and through
 * WebGL only (B), recording the frame rate of each session.
 */
export function XrPage() {
  const [probe, setProbe] = useState<XrProbe | null>(null);
  const [side, setSide] = useState<Side>('webgpu');
  const [count, setCount] = useState(10_000);
  const [status, setStatus] = useState('');
  const [runs, setRuns] = useState<XrRun[]>(loadRuns);
  const [copied, setCopied] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const test = useRef<XrTest | null>(null);
  /** The count for a test that starts later (read in the effect, not during render). */
  const countRef = useRef(count);

  useEffect(() => {
    void probeXr().then(setProbe);
  }, []);

  // One test at a time, on its own canvas (a canvas cannot switch between WebGPU and WebGL).
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    let cancelled = false;
    let started: XrTest | null = null;
    const onRun = (run: XrRun) => {
      setRuns((previous) => {
        const next = [...previous, run];
        saveRuns(next);
        return next;
      });
      setStatus(`${run.renderer} session: ${run.meanFps.toFixed(0)} fps`);
    };
    setStatus(`Starting the ${side === 'webgpu' ? 'WebGPU' : 'WebGL'} test…`);
    const start: Promise<XrTest> =
      side === 'webgpu'
        ? startWebgpuXrTest(element, onRun)
        : Promise.resolve(startWebglXrTest(element, onRun));
    start
      .then((t) => {
        if (cancelled) {
          t.dispose();
          return;
        }
        started = t;
        test.current = t;
        t.setWalkers(countRef.current);
        setStatus('');
      })
      .catch((e: unknown) => {
        setStatus(`Could not start: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      started?.dispose();
      test.current = null;
    };
  }, [side]);

  const enterVr = () => {
    const t = test.current;
    if (t === null) return;
    setStatus(`Entering VR with ${t.renderer}…`);
    t.enterVr().then(
      () => {
        setStatus(`In VR with ${t.renderer}. Exit the session to record its frame rate.`);
      },
      (e: unknown) => {
        setStatus(`${t.renderer} VR refused: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  };

  const report = JSON.stringify({ probe, runs }, null, 2);

  return (
    <div className="lod-page">
      <canvas key={side} ref={canvas} className="lod-canvas" />
      <aside className="lod-panel xr-panel">
        <h2>XR test (internal)</h2>
        <p className="lod-status">
          A/B: the same walking crowd in VR through <b>A · WebGPU</b> (compute pass) or{' '}
          <b>B · WebGL</b> only. Pick a side and a count, enter VR, look around, exit; the frame
          rate is recorded below.
        </p>

        <div className="lod-segmented" role="radiogroup" aria-label="Renderer">
          {(
            [
              ['webgpu', 'A · WebGPU'],
              ['webgl', 'B · WebGL'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={side === value}
              onClick={() => {
                setSide(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="lod-segmented" role="radiogroup" aria-label="Walkers">
          {COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={count === n}
              onClick={() => {
                setCount(n);
                countRef.current = n;
                test.current?.setWalkers(n);
              }}
            >
              {n / 1000}k
            </button>
          ))}
        </div>
        <button type="button" className="xr-enter" onClick={enterVr}>
          Enter VR · {side === 'webgpu' ? 'WebGPU' : 'WebGL'}
        </button>
        {status !== '' && <p className="lod-status">{status}</p>}

        <h3>Sessions</h3>
        {runs.length === 0 ? (
          <p className="lod-status">None yet.</p>
        ) : (
          <table className="xr-runs">
            <thead>
              <tr>
                <th>Renderer</th>
                <th>Walkers</th>
                <th>Mean</th>
                <th>Min</th>
                <th>Secs</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run, i) => (
                <tr key={i}>
                  <td>
                    {run.renderer}
                    {run.renderer === 'WebGPU' && !run.webgpu ? ' (fell back)' : ''}
                  </td>
                  <td>{(run.walkers / 1000).toFixed(0)}k</td>
                  <td>{run.meanFps.toFixed(0)}</td>
                  <td>{run.minFps.toFixed(0)}</td>
                  <td>{run.seconds.toFixed(0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {runs.length > 0 && (
          <button
            type="button"
            className="xr-link"
            onClick={() => {
              setRuns([]);
              saveRuns([]);
            }}
          >
            Clear sessions
          </button>
        )}

        <h3>This device</h3>
        {probe === null ? (
          <p className="lod-status">Checking…</p>
        ) : (
          <>
            <p className="xr-verdict">{xrPath(probe)}</p>
            <dl className="lod-stats">
              <dt>WebXR VR · AR</dt>
              <dd>
                {yesNo(probe.immersiveVr)} · {yesNo(probe.immersiveAr)}
              </dd>
              <dt>WebGPU</dt>
              <dd>{probe.webgpu ? (probe.webgpuAdapter ?? 'no adapter') : 'no'}</dd>
              <dt>XR + WebGPU binding</dt>
              <dd>{yesNo(probe.xrGpuBinding)}</dd>
              <dt>WebGL 2</dt>
              <dd>{probe.webglRenderer ?? 'no'}</dd>
              <dt>Multiview</dt>
              <dd>{probe.webglMultiview.join(', ') || 'no'}</dd>
              <dt>Max buffer</dt>
              <dd>
                {probe.webgpuLimits.maxBufferSize === undefined
                  ? '–'
                  : `${(probe.webgpuLimits.maxBufferSize / 2 ** 20).toFixed(0)} MiB`}
              </dd>
              <dt>Memory · heap</dt>
              <dd>
                {probe.deviceMemoryGb ?? '?'} GB · {probe.heapLimitMb ?? '?'} MB
              </dd>
              <dt>Cores · isolated</dt>
              <dd>
                {probe.cores ?? '?'} · {yesNo(probe.crossOriginIsolated)}
              </dd>
            </dl>
          </>
        )}
        <button
          type="button"
          className="xr-enter xr-secondary"
          onClick={() => {
            void navigator.clipboard.writeText(report).then(() => {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
              }, 2000);
            });
          }}
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
        <details>
          <summary>Full report</summary>
          <pre className="xr-report">{report}</pre>
        </details>
      </aside>
    </div>
  );
}
