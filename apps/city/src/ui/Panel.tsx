import { BuildingType, NO_BUILDING, NodeFlag } from '@city/core-types';
import type { NavTile, RegionManifest } from '@city/formats';
import type { FollowKind } from '@city/sim';
import type { FollowLog } from '../crowd/follow-log.ts';
import type { BasemapId } from '../map/basemaps.ts';
import type { CrowdStats } from '../crowd/crowd-layer.ts';
import type { ProfileName, RouteResult } from '../routing/protocol.ts';
import type { TrafficStats } from '../traffic/traffic-layer.ts';
import type { Layers, ViewStats } from '../scene/city-view.ts';
import type { NetworkColouring } from '../scene/network-geometry.ts';
import { useEffect, useState } from 'react';
import { regionTitle } from './region-title.ts';

export interface RouteSummary {
  origin: number | null;
  destination: number | null;
  result: RouteResult | null;
}

/** The base map's camera, for the Render section. */
export interface MapView {
  zoom: number;
  /** Tilt from straight down, and heading clockwise from north, in degrees. */
  pitch: number;
  bearing: number;
  lng: number;
  lat: number;
}

/** Agents of each model: the population is their sum. */
export interface CrowdMix {
  robots: number;
  women: number;
  men: number;
}

interface CrowdControls {
  follow: FollowLog | null;
  onFollow: (kind: FollowKind) => void;
  onStopFollowing: () => void;
  mix: CrowdMix;
  timeScale: number;
  status: string;
  stats: CrowdStats | null;
  onMix: (mix: CrowdMix) => void;
  onTimeScale: (scale: number) => void;
}

interface TrafficControls {
  /** Cars requested; null = the region's default. */
  cars: number | null;
  status: string;
  stats: TrafficStats | null;
  onCars: (cars: number) => void;
}

interface PanelProps {
  manifest: RegionManifest;
  tile: NavTile;
  bytes: number;
  layers: Layers;
  stats: ViewStats | null;
  profile: ProfileName;
  route: RouteSummary;
  routeBreakdown: { mappedCrossings: number; implicitCrossings: number; steps: number } | null;
  onLayers: (layers: Layers) => void;
  /** The map under the city; null without a base map (`?basemap=none`). */
  basemap: BasemapId | null;
  onBasemap: (basemap: BasemapId) => void;
  /** The base map's live camera; null without a base map. */
  mapView: MapView | null;
  /** With 3D tiles on: their ground at the view, metres above the ellipsoid (null: measuring). */
  tilesGround?: number | null | undefined;
  /** Places in this region the camera can fly to (empty without a base map). */
  places: { id: string; name: string }[];
  onPlace: (id: string) => void;
  crowd: CrowdControls;
  traffic: TrafficControls;
  onProfile: (profile: ProfileName) => void;
  onRandomRoute: () => void;
  onClearRoute: () => void;
}

const percent = (v: number) => `${(v * 100).toFixed(1)} %`;
const QA_ROWS: [key: string, label: string, format?: (v: number) => string][] = [
  ['graph.lengthM', 'Network length', (v) => `${(v / 1000).toFixed(1)} km`],
  ['sidewalks.inferredLengthM', '… inferred sidewalks', (v) => `${(v / 1000).toFixed(1)} km`],
  ['graph.connectedShare', 'Connected (by length)', percent],
  ['entrances.connectedShare', 'Entrances connected', percent],
  ['entrances.buildingsReachableShare', 'Buildings reachable', percent],
  ['sidewalks.mappedCrossings', 'Mapped crossings'],
  ['sidewalks.implicitCrossings', 'Implicit crossings'],
  ['entrances.mapped', 'Mapped entrances'],
  ['entrances.synthetic', 'Synthetic entrances'],
  ['graph.danglingEnds', 'Dead ends'],
  ['buildings.buildings', 'Buildings'],
  ['buildings.heightDefault', 'Height defaulted'],
];

const LEGENDS: Record<NetworkColouring, [string, string][]> = {
  source: [
    ['#ccccc7', 'Mapped in OSM'],
    ['#33ccff', 'Inferred sidewalk'],
    ['#ffd91a', 'Crossing'],
    ['#ff661a', 'Implicit crossing'],
    ['#f259f2', 'Entrance link'],
  ],
  type: [
    ['#d9d9cc', 'Footway / path'],
    ['#ffd91a', 'Crossing'],
    ['#ff5933', 'Steps'],
    ['#4dd9e6', 'Pedestrian area'],
    ['#66cc66', 'Shared path'],
    ['#b380ff', 'Corridor'],
    ['#f259f2', 'Entrance link'],
  ],
  component: [
    ['#59d973', 'Largest component'],
    ['linear-gradient(90deg,#e05a5a,#e0c05a,#5ab0e0,#b05ae0)', 'Others, one hue each'],
  ],
};

const BUILDING_TYPES: Partial<Record<number, string>> = Object.fromEntries(
  Object.entries(BuildingType).map(([k, v]) => [v, k]),
);
const WALK_SPEED: Record<ProfileName, number> = { pedestrian: 1.34, robot: 1.2 };

/** Narrow screens open with the panel collapsed, so the map is visible. */
const COMPACT = '(max-width: 640px)';

export function Panel(props: PanelProps) {
  const { manifest, bytes, layers, stats, onLayers, basemap, onBasemap } = props;
  const transparency = Math.round((1 - layers.buildingOpacity) * 100);
  const [open, setOpen] = useState(() => !window.matchMedia(COMPACT).matches);
  // Follows the screen size too: a page loaded in a background window can start 0 px wide.
  useEffect(() => {
    const query = window.matchMedia(COMPACT);
    const update = () => {
      setOpen(!query.matches);
    };
    query.addEventListener('change', update);
    return () => {
      query.removeEventListener('change', update);
    };
  }, []);
  const toggle = (
    key: 'buildings' | 'labels' | 'network' | 'showOtherLevels' | 'deadEnds' | 'entrances',
    label: string,
  ) => (
    <label className="toggle">
      <input
        type="checkbox"
        checked={layers[key]}
        onChange={(e) => {
          onLayers({ ...layers, [key]: e.target.checked });
        }}
      />
      {label}
    </label>
  );
  return (
    <aside className="panel">
      <header className="panel-header">
        <div>
          <h1>{regionTitle(manifest.region)}</h1>
          <p className="sub">
            Region <code>{manifest.region}</code> · format v{manifest.version} ·{' '}
            {(bytes / 1024).toFixed(0)} KiB
          </p>
        </div>
        <button
          type="button"
          className="panel-toggle"
          aria-expanded={open}
          aria-controls="panel-body"
          aria-label={open ? 'Collapse panel' : 'Expand panel'}
          onClick={() => {
            setOpen(!open);
          }}
        >
          <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
            <path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" />
          </svg>
        </button>
      </header>

      {/* Hidden rather than unmounted, so the sections keep their state. */}
      <div id="panel-body" className="panel-body" hidden={!open}>
        {props.places.length > 0 && (
          <section>
            <h2>Places</h2>
            <div className="places">
              {props.places.map((place) => (
                <button
                  key={place.id}
                  type="button"
                  onClick={() => {
                    props.onPlace(place.id);
                  }}
                >
                  {place.name}
                </button>
              ))}
            </div>
          </section>
        )}
        <CrowdSection {...props.crowd} fps={stats?.fps ?? null} />
        <TrafficSection {...props.traffic} />

        <RouteSection {...props} />

        <section>
          <h2>Layers</h2>
          {basemap !== null && (
            <div className="crowd-kind">
              <span className="crowd-kind-label">Map type</span>
              <Segmented
                label="Map type"
                value={basemap}
                options={[
                  ['vector', 'Streets'],
                  ['satellite', 'Satellite'],
                ]}
                onChange={onBasemap}
              />
            </div>
          )}
          {toggle('buildings', 'Buildings')}
          <label className="range">
            <span>
              Building transparency <b>{transparency} %</b>
            </span>
            <input
              type="range"
              min={0}
              max={90}
              step={10}
              value={transparency}
              onChange={(e) => {
                onLayers({ ...layers, buildingOpacity: 1 - Number(e.target.value) / 100 });
              }}
            />
          </label>
          {toggle('labels', 'Building names')}
          {toggle('network', 'Pedestrian network')}
          {toggle('entrances', 'Entrances')}
          {toggle('showOtherLevels', 'Ways on other levels')}
          {toggle('deadEnds', 'Dead ends')}
          <Segmented
            label="Network colouring"
            value={layers.colouring}
            options={[
              ['source', 'Source'],
              ['type', 'Edge type'],
              ['component', 'Component'],
            ]}
            onChange={(colouring) => {
              onLayers({ ...layers, colouring });
            }}
          />
          <ul className="legend">
            {LEGENDS[layers.colouring].map(([colour, label]) => (
              <li key={label}>
                <span style={{ background: colour }} />
                {label}
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h2>Pipeline QA</h2>
          <dl className="qa">
            <div className="row">
              <dt>Nodes / edges · tiles</dt>
              <dd>
                {props.tile.nodes.x.length.toLocaleString()} /{' '}
                {props.tile.edges.from.length.toLocaleString()} · {manifest.tiles.length} ×{' '}
                {manifest.tileSizeM} m
              </dd>
            </div>
            {QA_ROWS.map(([key, label, format]) => {
              const value = manifest.qa[key];
              if (value === undefined) return null;
              return (
                <div key={key} className="row">
                  <dt>{label}</dt>
                  <dd>{format ? format(value) : value.toLocaleString()}</dd>
                </div>
              );
            })}
          </dl>
        </section>

        {stats !== null && (
          <section>
            <h2>Render</h2>
            <dl className="qa">
              <div className="row">
                <dt>Frame rate</dt>
                <dd>{stats.fps.toFixed(0)} fps</dd>
              </div>
              <div className="row">
                <dt>Buildings drawn</dt>
                <dd>{stats.buildingsDrawn.toLocaleString()}</dd>
              </div>
              <div className="row">
                <dt>Line segments</dt>
                <dd>{stats.networkSegments.toLocaleString()}</dd>
              </div>
              {props.mapView !== null && (
                <>
                  <div className="row">
                    <dt>Zoom · tilt · heading</dt>
                    <dd>
                      {props.mapView.zoom.toFixed(2)} · {props.mapView.pitch.toFixed(0)}° ·{' '}
                      {((props.mapView.bearing + 360) % 360).toFixed(0)}°
                    </dd>
                  </div>
                  <div className="row">
                    <dt>Centre</dt>
                    <dd>
                      {props.mapView.lat.toFixed(5)}, {props.mapView.lng.toFixed(5)}
                    </dd>
                  </div>
                  {props.tilesGround !== undefined && (
                    <div className="row">
                      <dt>3D tiles ground</dt>
                      <dd>
                        {props.tilesGround === null
                          ? 'measuring…'
                          : `${props.tilesGround.toFixed(1)} m above ellipsoid`}
                      </dd>
                    </div>
                  )}
                  <button
                    type="button"
                    className="copy-view"
                    onClick={() => {
                      const v = props.mapView;
                      if (v === null) return;
                      const camera = {
                        lat: Number(v.lat.toFixed(6)),
                        lng: Number(v.lng.toFixed(6)),
                        zoom: Number(v.zoom.toFixed(2)),
                        pitch: Number(v.pitch.toFixed(1)),
                        bearing: Number(v.bearing.toFixed(1)),
                      };
                      void navigator.clipboard.writeText(JSON.stringify(camera));
                    }}
                  >
                    Copy view
                  </button>
                </>
              )}
            </dl>
          </section>
        )}

        <footer>
          {manifest.build.attribution} · built {manifest.build.createdAt.slice(0, 10)} from{' '}
          <code>{manifest.build.source.split('/').pop()}</code>
          <br />
          Man model:{' '}
          <a href="https://sketchfab.com/3d-models/cool-man-ad14b71697dd4ea7836c1f06c75e5f72">
            Cool Man
          </a>{' '}
          by <a href="https://sketchfab.com/ardhanaputra">ardhanaputra</a>,{' '}
          <a href="http://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>
          <br />
          <a href="/credits">All credits and sources</a>
        </footer>
      </div>
    </aside>
  );
}

function CrowdSection({
  follow,
  onFollow,
  onStopFollowing,
  mix,
  timeScale,
  status,
  stats,
  fps,
  onMix,
  onTimeScale,
}: CrowdControls & { fps: number | null }) {
  const kinds: { key: keyof CrowdMix; label: string; counts: [string, string][] }[] = [
    { key: 'robots', label: 'Robots', counts: COUNTS },
    { key: 'women', label: 'Woman', counts: HUMAN_COUNTS },
    { key: 'men', label: 'Man', counts: HUMAN_COUNTS },
  ];
  const total = mix.robots + mix.women + mix.men;
  return (
    <section>
      <h2>Crowd</h2>
      {kinds.map(({ key, label, counts }) => (
        <div key={key} className="crowd-kind">
          <span className="crowd-kind-label">{label}</span>
          <Segmented
            label={label}
            value={String(mix[key])}
            options={counts}
            onChange={(value) => {
              onMix({ ...mix, [key]: Number(value) });
            }}
          />
        </div>
      ))}
      <p className="hint">{total.toLocaleString()} in total</p>
      <Segmented
        label="Time"
        value={String(timeScale)}
        options={[
          ['0', 'Pause'],
          ['1', '1×'],
          ['4', '4×'],
          ['16', '16×'],
        ]}
        onChange={(value) => {
          onTimeScale(Number(value));
        }}
      />
      {status !== '' && <p className="hint">{status}</p>}
      <div className="crowd-kind">
        <span className="crowd-kind-label">Roof view · follow someone on a roof</span>
        <Segmented
          label="Roof view"
          value={follow?.kind ?? 'off'}
          options={[
            ['off', 'Off'],
            ['human', 'Person'],
            ['robot', 'Robot'],
          ]}
          onChange={(value) => {
            if (value === 'off') onStopFollowing();
            else onFollow(value);
          }}
        />
      </div>
      {follow !== null && (
        <ol className="journey">
          {follow.lines.map((line, i) => (
            <li key={i}>
              <span>{formatClock(line.at)}</span> {line.text}
            </li>
          ))}
        </ol>
      )}
      {stats !== null && (
        <dl className="qa">
          <div className="row">
            <dt>Time of day</dt>
            <dd>{formatClock(stats.timeOfDayMs / 1000)}</dd>
          </div>
          <div className="row">
            <dt>Population · rows · aggregated</dt>
            <dd>
              {stats.population.toLocaleString()} · {stats.rows.toLocaleString()} ·{' '}
              {stats.aggregated.toLocaleString()}
            </dd>
          </div>
          <div className="row">
            <dt>Walking · waiting · on roofs · indoors</dt>
            <dd>
              {stats.walking.toLocaleString()} · {stats.waiting.toLocaleString()} ·{' '}
              {stats.onRoof.toLocaleString()} · {stats.indoor.toLocaleString()}
            </dd>
          </div>
          <div className="row">
            <dt>Near tier (T0) · tables</dt>
            <dd>
              {stats.nearTier.toLocaleString()} · {stats.tablesBuilt.toLocaleString()}
            </dd>
          </div>
          <div className="row">
            <dt>Visible · triangles · LOD bias</dt>
            <dd>
              {stats.visibleAgents.toLocaleString()} · {(stats.visibleTriangles / 1e6).toFixed(1)}M
              · {stats.lodBias.toFixed(2)}
            </dd>
          </div>
          <div className="row">
            <dt>Sim clock</dt>
            <dd>{formatClock(stats.simSeconds)}</dd>
          </div>
          <div className="row">
            <dt>Worker per sim second</dt>
            <dd>{stats.workerMsPerSimSecond.toFixed(1)} ms</dd>
          </div>
          <div className="row">
            <dt>Records · this frame</dt>
            <dd>
              {Math.round(stats.recordsPerSecond).toLocaleString()}/s · {stats.uploaded}
            </dd>
          </div>
          {fps !== null && (
            <div className="row">
              <dt>Frame rate</dt>
              <dd>{fps.toFixed(0)} fps</dd>
            </div>
          )}
        </dl>
      )}
    </section>
  );
}

function formatClock(seconds: number): string {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function RouteSection({
  tile,
  profile,
  route,
  routeBreakdown,
  onProfile,
  onRandomRoute,
  onClearRoute,
}: PanelProps) {
  const { origin, destination, result } = route;
  const place = (node: number) => {
    const building = tile.nodes.buildingId[node];
    const synthetic = (tile.nodes.flags[node] & NodeFlag.SyntheticEntrance) !== 0;
    if (building === NO_BUILDING) return `node ${node}`;
    const type = BUILDING_TYPES[tile.buildings.type[building]] ?? 'Other';
    return `${type} building #${building}${synthetic ? ' (synthetic door)' : ''}`;
  };
  return (
    <section className="route">
      <h2>Route</h2>
      <Segmented
        label="Profile"
        value={profile}
        options={[
          ['pedestrian', 'Pedestrian'],
          ['robot', 'Robot'],
        ]}
        onChange={onProfile}
      />
      {origin === null ? (
        <p className="hint">Click near a building entrance to start, then click a second one.</p>
      ) : (
        <dl className="qa">
          <div className="row">
            <dt>From</dt>
            <dd>{place(origin)}</dd>
          </div>
          <div className="row">
            <dt>To</dt>
            <dd>{destination === null ? 'click a destination' : place(destination)}</dd>
          </div>
          {result !== null && !result.found && (
            <p className="warn">No {profile} route: these entrances are not connected.</p>
          )}
          {result?.found === true && (
            <>
              <div className="row">
                <dt>Distance</dt>
                <dd>{result.lengthM.toFixed(0)} m</dd>
              </div>
              <div className="row">
                <dt>Time at {WALK_SPEED[profile]} m/s</dt>
                <dd>{formatTime(result.lengthM / WALK_SPEED[profile])}</dd>
              </div>
              {routeBreakdown !== null && (
                <div className="row">
                  <dt>Crossings · steps</dt>
                  <dd>
                    {routeBreakdown.mappedCrossings} mapped, {routeBreakdown.implicitCrossings}{' '}
                    implicit · {routeBreakdown.steps}
                  </dd>
                </div>
              )}
              <div className="row">
                <dt>A* search</dt>
                <dd>
                  {result.cached ? 'cached' : `${result.ms.toFixed(2)} ms`} ·{' '}
                  {result.expanded.toLocaleString()} nodes
                </dd>
              </div>
            </>
          )}
        </dl>
      )}
      <div className="buttons">
        <button type="button" onClick={onRandomRoute}>
          Random route
        </button>
        <button type="button" onClick={onClearRoute} disabled={origin === null}>
          Clear
        </button>
      </div>
    </section>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => {
            onChange(option);
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m} min ${s} s` : `${s} s`;
}

function TrafficSection({ cars, status, stats, onCars }: TrafficControls) {
  const value = cars === null ? (stats === null ? '' : String(stats.cars)) : String(cars);
  return (
    <section>
      <h2>Traffic</h2>
      <Segmented
        label="Cars"
        value={value}
        options={[
          ['0', 'Off'],
          ['1000', '1k'],
          ['5000', '5k'],
          ['20000', '20k'],
          ['50000', '50k'],
          ['100000', '100k'],
        ]}
        onChange={(next) => {
          onCars(Number(next));
        }}
      />
      {status !== '' && <p className="hint">{status}</p>}
      {stats !== null && (
        <dl className="qa">
          <div className="row">
            <dt>Cars · roads</dt>
            <dd>
              {stats.cars.toLocaleString()} · {stats.roadKm.toFixed(0)} km
            </dd>
          </div>
          <div className="row">
            <dt>Drawn LOD0–3 · boxes</dt>
            <dd>
              {stats.drawn
                .slice(0, -1)
                .map((n) => n.toLocaleString())
                .join(' · ')}{' '}
              · {(stats.drawn.at(-1) ?? 0).toLocaleString()}
            </dd>
          </div>
          <div className="row">
            <dt>Worker per tick</dt>
            <dd>{stats.stepMs.toFixed(1)} ms</dd>
          </div>
        </dl>
      )}
    </section>
  );
}

const COUNTS: [string, string][] = [
  ['0', 'Off'],
  ['1000', '1k'],
  ['10000', '10k'],
  ['100000', '100k'],
  ['500000', '500k'],
  ['1000000', '1M'],
];
const HUMAN_COUNTS: [string, string][] = [
  ['0', 'Off'],
  ['1000', '1k'],
  ['10000', '10k'],
  ['100000', '100k'],
  ['250000', '250k'],
  ['500000', '500k'],
];
