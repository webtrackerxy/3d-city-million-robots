import { useEffect, useRef, useState } from 'react';
import '../lod/lod.css';
import {
  startWebglCrowd,
  type WebglCrowd,
  type WebglInfo,
  type WebglStats,
} from './webgl-crowd.ts';

const COUNTS = [1_000, 5_000, 10_000, 20_000, 50_000];

/**
 * WebGL test (/webgl): how many animated robots WebGL 2 alone can draw on this device. A proof
 * for a WebGL fallback (older iPhones, the Quest Browser, WebXR), before porting the crowd.
 */
export function WebglPage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const vrSlot = useRef<HTMLDivElement>(null);
  const crowd = useRef<WebglCrowd | null>(null);
  const [count, setCount] = useState(5_000);
  const [info, setInfo] = useState<WebglInfo | null>(null);
  const [stats, setStats] = useState<WebglStats | null>(null);
  const [status, setStatus] = useState('Loading the robot…');

  useEffect(() => {
    if (canvas.current === null) return;
    let cancelled = false;
    let started: WebglCrowd | null = null;
    void startWebglCrowd(canvas.current, setStats)
      .then((c) => {
        if (cancelled) {
          c.dispose();
          return;
        }
        started = c;
        crowd.current = c;
        setInfo(c.info);
        setStatus('');
        vrSlot.current?.append(c.vrButton);
      })
      .catch((e: unknown) => {
        setStatus(`WebGL failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      started?.vrButton.remove();
      started?.dispose();
      crowd.current = null;
    };
  }, []);

  return (
    <div className="lod-page">
      <canvas ref={canvas} className="lod-canvas" />
      <aside className="lod-panel">
        <h2>WebGL test</h2>
        <p className="lod-status">
          Animated robots in WebGL 2 only (no WebGPU), one instanced draw. Pick a count and watch
          the frame rate.
        </p>
        <div className="lod-segmented">
          {COUNTS.map((n) => (
            <button
              key={n}
              type="button"
              aria-pressed={count === n}
              onClick={() => {
                setCount(n);
                crowd.current?.setCount(n);
              }}
            >
              {n >= 1000 ? `${n / 1000}k` : n}
            </button>
          ))}
        </div>
        {status !== '' && <p className="lod-status">{status}</p>}
        <dl className="lod-stats">
          <dt>Frame rate</dt>
          <dd>{stats === null ? '–' : `${stats.fps.toFixed(0)} fps`}</dd>
          <dt>Frame time</dt>
          <dd>{stats === null ? '–' : `${stats.frameMs.toFixed(1)} ms`}</dd>
          <dt>Triangles</dt>
          <dd>{stats === null ? '–' : `${(stats.triangles / 1e6).toFixed(1)} M`}</dd>
          <dt>Draw calls</dt>
          <dd>{stats?.drawCalls ?? '–'}</dd>
          <dt>Robot</dt>
          <dd>
            {info === null
              ? '–'
              : `${info.triangles.toLocaleString()} tris · ${info.frames} frames`}
          </dd>
          <dt>GPU</dt>
          <dd>{info?.gpu ?? '–'}</dd>
          <dt>WebXR VR</dt>
          <dd>{info === null ? '–' : info.vr ? 'supported' : 'not available'}</dd>
        </dl>
      </aside>
      {/* three.js's VRButton positions itself at the bottom centre. */}
      <div ref={vrSlot} />
    </div>
  );
}
