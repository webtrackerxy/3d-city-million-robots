import {
  HUMAN_LOD_TRIANGLES,
  IMPOSTOR_THRESHOLD,
  LOD_THRESHOLDS,
  LodPreset,
  loadCharacter,
  pxPerRadian,
  ROBOT_LOD_TRIANGLES,
} from '@city/render';
import { useEffect, useRef, useState } from 'react';
import { type LodLabel, type LodViewer, startLodViewer, type ViewerStats } from './lod-viewer.ts';
import './lod.css';

interface ModelChoice {
  id: string;
  name: string;
  url: string;
  targets: readonly number[];
  targetHeight?: number;
}

const MODELS: ModelChoice[] = [
  {
    id: 'optimus',
    name: 'Optimus robot',
    url: '/models/optimus.glb',
    targets: ROBOT_LOD_TRIANGLES,
    targetHeight: 1.75,
  },
  {
    id: 'woman',
    name: 'Woman',
    url: '/models/woman.glb',
    targets: HUMAN_LOD_TRIANGLES,
    targetHeight: 1.75,
  },
  {
    id: 'eric',
    name: 'Man',
    url: '/models/man.glb',
    targets: HUMAN_LOD_TRIANGLES,
    targetHeight: 1.8,
  },
];
const CLIPS = ['walk', 'idle', 'run'];
const SPEEDS = [0.25, 1, 2];

/** Where the crowd switches: pixel heights, and the distance at 1080p / 60° for a 1.8 m agent. */
const THRESHOLDS = LOD_THRESHOLDS[LodPreset.Brief];
const PX_PER_RAD = pxPerRadian(1080, Math.PI / 3);
const metres = (px: number) => (1.8 * PX_PER_RAD) / px;
function band(lod: number): string {
  const near = lod === 0 ? 0 : metres(THRESHOLDS[lod - 1] ?? 1);
  const far = metres(lod < THRESHOLDS.length ? (THRESHOLDS[lod] ?? 1) : IMPOSTOR_THRESHOLD.brief);
  return `${near.toFixed(0)}–${far.toFixed(0)} m`;
}

/**
 * LOD test (/lod): a character's five mesh LODs side by side — the simplified geometry the crowd
 * bakes and instances — animated together, with triangle counts and the distance band where the
 * crowd draws each one. Below LOD4 the crowd switches to impostors.
 */
export function LodPage() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const viewer = useRef<LodViewer | null>(null);
  const [ready, setReady] = useState(false);
  const [model, setModel] = useState(MODELS[0]?.id ?? 'optimus');
  const [clip, setClip] = useState('walk');
  const [wireframe, setWireframe] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [labels, setLabels] = useState<LodLabel[]>([]);
  const [stats, setStats] = useState<ViewerStats | null>(null);
  const [triangles, setTriangles] = useState<number[]>([]);
  const [source, setSource] = useState<{ triangles: number; bones: number } | null>(null);
  const [status, setStatus] = useState('Loading…');

  useEffect(() => {
    if (canvas.current === null) return;
    let cancelled = false;
    let started: LodViewer | null = null;
    void startLodViewer(canvas.current, setLabels, setStats)
      .then((v) => {
        if (cancelled) {
          v.dispose();
          return;
        }
        started = v;
        viewer.current = v;
        setReady(true);
      })
      .catch((e: unknown) => {
        setStatus(`WebGPU failed: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      cancelled = true;
      started?.dispose();
      viewer.current = null;
    };
  }, []);

  useEffect(() => {
    const choice = MODELS.find((m) => m.id === model);
    if (!ready || choice === undefined) return;
    const run = { cancelled: false };
    const isCancelled = () => run.cancelled;
    void loadCharacter(choice.url, undefined, { targetHeight: choice.targetHeight })
      .then(async (character) => {
        if (run.cancelled) return;
        setStatus('Building LODs…');
        setSource({ triangles: character.sourceTriangles, bones: character.bones });
        const counts = await viewer.current?.show(character, choice.targets, clip);
        if (isCancelled()) return;
        setTriangles(counts ?? []);
        setStatus('');
      })
      .catch((e: unknown) => {
        setStatus(`${choice.url}: ${e instanceof Error ? e.message : String(e)}`);
      });
    return () => {
      run.cancelled = true;
    };
    // The clip is applied separately; a model change keeps the current one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, model]);

  return (
    <div className="lod-page">
      <canvas ref={canvas} className="lod-canvas" />
      {labels.map((label) =>
        label.visible && label.lod < triangles.length ? (
          <div key={label.lod} className="lod-label" style={{ left: label.x, top: label.y }}>
            <b>LOD{label.lod}</b>
            <span>{(triangles[label.lod] ?? 0).toLocaleString()} tris</span>
            <span>{band(label.lod)}</span>
          </div>
        ) : null,
      )}
      <aside className="lod-panel">
        <h2>LOD test</h2>
        <label>
          Model{' '}
          <select
            value={model}
            onChange={(e) => {
              setModel(e.target.value);
              setStatus('Loading…');
              setTriangles([]);
            }}
          >
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <div className="lod-segmented">
          {CLIPS.map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={clip === c}
              onClick={() => {
                setClip(c);
                viewer.current?.setClip(c);
              }}
            >
              {c}
            </button>
          ))}
        </div>
        <div className="lod-segmented">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={speed === s}
              onClick={() => {
                setSpeed(s);
                viewer.current?.setSpeed(s);
              }}
            >
              {s}×
            </button>
          ))}
        </div>
        <label className="lod-check">
          <input
            type="checkbox"
            checked={wireframe}
            onChange={(e) => {
              setWireframe(e.target.checked);
              viewer.current?.setWireframe(e.target.checked);
            }}
          />
          Wireframe
        </label>
        {status !== '' && <p className="lod-status">{status}</p>}
        <dl className="lod-stats">
          <dt>Source</dt>
          <dd>
            {source === null
              ? '—'
              : `${source.triangles.toLocaleString()} tris · ${source.bones} bones`}
          </dd>
          <dt>Frame</dt>
          <dd>
            {stats === null
              ? '—'
              : `${stats.fps.toFixed(0)} fps · ${stats.drawCalls} draws · ${stats.triangles.toLocaleString()} tris`}
          </dd>
        </dl>
        <p className="lod-note">
          Distances are where the crowd draws each LOD (brief preset, 1.8 m agent, 1080p, 60°);
          beyond LOD4 it draws impostors. Drag to orbit, scroll to zoom.
        </p>
      </aside>
    </div>
  );
}
