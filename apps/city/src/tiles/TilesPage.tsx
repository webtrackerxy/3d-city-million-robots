import { useEffect, useRef, useState } from 'react';
import '../lod/lod.css';
import '../xr/xr.css';
import {
  startTilesSpike,
  type TilesAsset,
  type TilesSpike,
  type TilesStats,
} from './tiles-spike.ts';

/** From apps/city/.env.local (git-ignored); empty means the page asks for one. */
const ENV_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN as string | undefined) ?? '';
const TARGETS = [6, 12, 24];

/**
 * 3D Tiles test (/tiles, internal; not in the navigation): the 3D Tiles plan's Phase 0. Renders a
 * Cesium ion tileset over Canary Wharf with the city's WebGPU renderer and reports whether it
 * renders, whether tiles load under cross-origin isolation, and the frame rate and load.
 */
export function TilesPage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const spike = useRef<TilesSpike | null>(null);
  const [asset, setAsset] = useState<TilesAsset>('photorealistic');
  const [errorTarget, setErrorTarget] = useState(12);
  const [stats, setStats] = useState<TilesStats | null>(null);
  const [status, setStatus] = useState(
    ENV_TOKEN === ''
      ? 'No token: set VITE_CESIUM_ION_TOKEN in apps/city/.env.local and restart.'
      : 'Starting…',
  );
  const [ground, setGround] = useState<string>('–');
  const targetRef = useRef(errorTarget);

  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    if (ENV_TOKEN === '') return;
    let cancelled = false;
    let started: TilesSpike | null = null;
    startTilesSpike(element, { token: ENV_TOKEN, asset, errorTarget: targetRef.current }, setStats)
      .then((s) => {
        if (cancelled) {
          s.dispose();
          return;
        }
        started = s;
        spike.current = s;
        setStatus('');
      })
      .catch((e: unknown) => {
        setStatus(`Could not start: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      started?.dispose();
      spike.current = null;
    };
  }, [asset]);

  const report = JSON.stringify(
    { asset, errorTarget, ground, stats, crossOriginIsolated, userAgent: navigator.userAgent },
    null,
    2,
  );

  return (
    <div className="lod-page">
      <canvas key={asset} ref={canvas} className="lod-canvas" />
      <aside className="lod-panel xr-panel">
        <h2>3D Tiles test (internal)</h2>
        <p className="lod-status">
          Cesium ion tiles over Canary Wharf in the city&apos;s WebGPU renderer. Drag to orbit,
          scroll to zoom.
        </p>
        <div className="lod-segmented" role="radiogroup" aria-label="Tileset">
          {(
            [
              ['photorealistic', 'Photorealistic'],
              ['osmBuildings', 'OSM Buildings'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={asset === value}
              onClick={() => {
                if (value === asset) return;
                setStats(null);
                setStatus('Starting…');
                setAsset(value);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="lod-segmented" role="radiogroup" aria-label="Detail">
          {TARGETS.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={errorTarget === t}
              onClick={() => {
                setErrorTarget(t);
                targetRef.current = t;
                spike.current?.setErrorTarget(t);
              }}
            >
              error {t}
            </button>
          ))}
        </div>
        {status !== '' && <p className="lod-status">{status}</p>}
        <dl className="lod-stats">
          <dt>Tileset</dt>
          <dd>{stats === null ? '–' : stats.tilesetLoaded ? 'loaded' : 'loading'}</dd>
          <dt>Frame rate</dt>
          <dd>
            {stats === null ? '–' : `${stats.fps.toFixed(0)} fps · ${stats.frameMs.toFixed(1)} ms`}
          </dd>
          <dt>Triangles · draws</dt>
          <dd>
            {stats === null
              ? '–'
              : `${(stats.triangles / 1e6).toFixed(2)} M · ${stats.drawCalls.toLocaleString()}`}
          </dd>
          <dt>Tiles visible</dt>
          <dd>{stats?.visible ?? '–'}</dd>
          <dt>Downloading · parsing</dt>
          <dd>{stats === null ? '–' : `${stats.downloading} · ${stats.parsing}`}</dd>
          <dt>Failed</dt>
          <dd>{stats?.failed ?? '–'}</dd>
          <dt>GPU geometries · textures</dt>
          <dd>{stats === null ? '–' : `${stats.gpuGeometries} · ${stats.gpuTextures}`}</dd>
          <dt>Ground (ellipsoid)</dt>
          <dd>{ground}</dd>
        </dl>
        <button
          type="button"
          className="xr-enter xr-secondary"
          onClick={() => {
            const h = spike.current?.probeGround();
            setGround(h == null ? 'no hit yet' : `${h.toFixed(1)} m`);
          }}
        >
          Probe ground height
        </button>
        {stats !== null && stats.errors.length > 0 && (
          <>
            <h3>Errors</h3>
            <pre className="xr-report">{stats.errors.join('\n')}</pre>
          </>
        )}
        <button
          type="button"
          className="xr-enter xr-secondary"
          onClick={() => {
            void navigator.clipboard.writeText(report);
          }}
        >
          Copy report
        </button>
      </aside>
    </div>
  );
}
