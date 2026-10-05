import type { ReactNode } from 'react';

/** What was clicked: a person or robot of the crowd, or a car. */
export type Selected = { type: 'agent'; id: number } | { type: 'car'; id: number };

export interface SelectionDetails {
  title: string;
  /** The 3D model and its credit. */
  model: ReactNode;
  rows: [label: string, value: string][];
}

const CC_BY = <a href="https://creativecommons.org/licenses/by/4.0/">CC BY 4.0</a>;

/** The models the crowd and traffic draw, with their credits (see the Credits page). */
export const MODEL_CREDITS = {
  man: (
    <>
      <a href="https://sketchfab.com/3d-models/cool-man-ad14b71697dd4ea7836c1f06c75e5f72">
        Cool Man
      </a>{' '}
      by ardhanaputra, {CC_BY}
    </>
  ),
  woman: (
    <>
      <a href="https://sketchfab.com/3d-models/invisible-womantexturedrigged-031e16a761b64814a30f0cc888ac7aff">
        Invisible Woman
      </a>{' '}
      by CAPTAAINR, {CC_BY}
    </>
  ),
  robot: (
    <>
      <a href="https://sketchfab.com/3d-models/tesla-optimus-2fab5d31927f43729a99a6e8eaf1c7f5">
        Tesla optimus
      </a>{' '}
      by Mechamaner.V, {CC_BY}
    </>
  ),
  car: (
    <>
      <a href="https://sketchfab.com/3d-models/free-porsche-911-carrera-4s-d01b254483794de3819786d93e0e1ebf">
        Porsche 911 Carrera 4S
      </a>{' '}
      by Lionsharp Studios, {CC_BY}
    </>
  ),
};

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
];

/** "north-east" for a heading in radians clockwise from north. */
export function compass(headingRad: number): string {
  const sector = Math.round(headingRad / (Math.PI / 4)) % 8;
  return COMPASS[(sector + 8) % 8] ?? 'north';
}

export function SelectionCard({
  details,
  following,
  onFollow,
  onClose,
}: {
  details: SelectionDetails;
  following: boolean;
  onFollow: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="selection-card" aria-label="Selected">
      <header>
        <h2>{details.title}</h2>
        <button type="button" className="selection-close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </header>
      <p className="selection-model">{details.model}</p>
      <dl>
        {details.rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <button
        type="button"
        className="selection-follow"
        aria-pressed={following}
        onClick={onFollow}
      >
        {following ? 'Stop following' : 'Follow'}
      </button>
    </aside>
  );
}
