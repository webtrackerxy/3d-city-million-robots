import { MESH_LOD_COUNT, RENDER_LOD_DEBUG_COLOURS, RenderLod } from '@city/core-types';
import { IMPOSTOR_THRESHOLD, LOD_THRESHOLDS, LodPreset } from '@city/render';
import type { LodControls } from '../paths/render-path.ts';
import { formatInteger } from './format.ts';

/** Mesh LODs 0–4 and the impostor. */
const LODS = Array.from({ length: MESH_LOD_COUNT + 1 }, (_, lod) => lod);
const lodName = (lod: number) => (lod === RenderLod.Impostor ? 'Impostor' : `LOD${lod}`);

interface Props {
  /** Loaded family keys, humans first. */
  families: readonly string[];
  controls: LodControls;
  gauges: Readonly<Record<string, number>>;
  onChange: (controls: LodControls) => void;
}

/** LOD debug controls and the GPU's visible counts per LOD (read back asynchronously). */
export function LodPanel({ families, controls, gauges, onChange }: Props) {
  const thresholds = LOD_THRESHOLDS[controls.preset];
  const humanBases = families.filter((family) => family !== 'robot').length;
  const visibleTotal = gauges['agents.visible'];

  return (
    <section>
      <h2>Level of detail</h2>
      <div className="buttons" role="group" aria-label="LOD mode">
        <button
          type="button"
          className={controls.forced === null ? 'active' : undefined}
          onClick={() => {
            onChange({ ...controls, forced: null });
          }}
        >
          Auto
        </button>
        {LODS.map((lod) => (
          <button
            key={lod}
            type="button"
            className={controls.forced === lod ? 'active' : undefined}
            onClick={() => {
              onChange({ ...controls, forced: lod });
            }}
          >
            {lodName(lod)}
          </button>
        ))}
      </div>
      <div className="buttons" role="group" aria-label="LOD thresholds">
        {Object.values(LodPreset).map((preset) => (
          <button
            key={preset}
            type="button"
            className={controls.preset === preset ? 'active' : undefined}
            onClick={() => {
              onChange({ ...controls, preset });
            }}
          >
            {preset}
          </button>
        ))}
        <button
          type="button"
          aria-pressed={controls.debugColours}
          className={controls.debugColours ? 'active' : undefined}
          onClick={() => {
            onChange({ ...controls, debugColours: !controls.debugColours });
          }}
        >
          Colours
        </button>
        <button
          type="button"
          aria-pressed={controls.impostors}
          className={controls.impostors ? 'active' : undefined}
          onClick={() => {
            onChange({ ...controls, impostors: !controls.impostors });
          }}
        >
          Impostors
        </button>
        <button
          type="button"
          aria-pressed={controls.fade}
          className={controls.fade ? 'active' : undefined}
          onClick={() => {
            onChange({ ...controls, fade: !controls.fade });
          }}
        >
          Crossfade
        </button>
      </div>

      <table className="results lod-table">
        <thead>
          <tr>
            <th>LOD</th>
            <th>Below px</th>
            {families.map((family) => (
              <th key={family}>
                {family === 'robot'
                  ? 'Robot'
                  : `Human${humanBases > 1 ? ` ${Number(family.slice(5)) + 1}` : ''}`}{' '}
                tris
              </th>
            ))}
            <th>Visible</th>
          </tr>
        </thead>
        <tbody>
          {LODS.map((lod) => {
            const [r, g, b] = RENDER_LOD_DEBUG_COLOURS[lod] ?? [1, 1, 1];
            return (
              <tr key={lod}>
                <td>
                  <span
                    className="swatch"
                    style={{ background: `rgb(${r * 255} ${g * 255} ${b * 255})` }}
                  />
                  {lod === RenderLod.Impostor ? 'Imp.' : lod}
                </td>
                <td>
                  {lod === 0
                    ? '–'
                    : lod === RenderLod.Impostor
                      ? controls.impostors
                        ? IMPOSTOR_THRESHOLD[controls.preset]
                        : 'off'
                      : thresholds[lod - 1]}
                </td>
                {families.map((family) => (
                  <td key={family}>
                    {lod === RenderLod.Impostor
                      ? 2
                      : formatInteger(gauges[`lod.${family}.triangles${lod}`])}
                  </td>
                ))}
                <td>{formatInteger(gauges[`lod.visible${lod}`])}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="hint">
        Visible after frustum culling: {formatInteger(visibleTotal)}. Agents mid-crossfade are drawn
        in two LODs.
      </p>
    </section>
  );
}
