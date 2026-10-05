import { BuildingType } from '@city/core-types';

/**
 * Time-of-day demand, v1 (implementation plan §15: destinations sampled by building capacity and
 * type; stations are sources and sinks with a time-of-day profile).
 *
 * The day is five periods. Per period and building type:
 * - `destinationWeight` multiplies a building's capacity when trips pick destinations (morning:
 *   offices; evening: stations and homes);
 * - `stayMinutes` is the mean time a person stays in a building of that type before leaving, which
 *   sets the rate at which building aggregates emit people (offices hold them all day, homes all
 *   night; stations — the world beyond the region — send commuters in the morning).
 *
 * Numbers are plausible guesses to be calibrated against footfall counts later; the structure is
 * what matters here.
 */
export const Period = { Night: 0, Morning: 1, Midday: 2, Evening: 3, Late: 4 } as const;
export type Period = (typeof Period)[keyof typeof Period];
export const PERIODS = 5;

export function periodOf(timeOfDayMs: number): Period {
  const hour = (((timeOfDayMs / 3_600_000) % 24) + 24) % 24;
  if (hour < 6) return Period.Night;
  if (hour < 10) return Period.Morning;
  if (hour < 16) return Period.Midday;
  if (hour < 20) return Period.Evening;
  return Period.Late;
}

type Row = Record<BuildingType, number>;
const row = (values: Partial<Row>, fallback: number): Row => ({
  [BuildingType.Other]: values[BuildingType.Other] ?? fallback,
  [BuildingType.Residential]: values[BuildingType.Residential] ?? fallback,
  [BuildingType.Office]: values[BuildingType.Office] ?? fallback,
  [BuildingType.Commercial]: values[BuildingType.Commercial] ?? fallback,
  [BuildingType.Retail]: values[BuildingType.Retail] ?? fallback,
  [BuildingType.Industrial]: values[BuildingType.Industrial] ?? fallback,
  [BuildingType.Public]: values[BuildingType.Public] ?? fallback,
  [BuildingType.Transport]: values[BuildingType.Transport] ?? fallback,
});
const R = BuildingType.Residential;
const O = BuildingType.Office;
const C = BuildingType.Commercial;
const S = BuildingType.Retail;
const P = BuildingType.Public;
const T = BuildingType.Transport;

export const DESTINATION_WEIGHT: readonly Row[] = [
  /* night   */ row({ [R]: 3, [T]: 1, [S]: 0.2, [O]: 0.1 }, 0.2),
  /* morning */ row({ [O]: 3, [C]: 2, [P]: 1.5, [S]: 0.5, [R]: 0.3, [T]: 0.5 }, 0.5),
  /* midday  */ row({ [S]: 2.5, [P]: 1.5, [C]: 1.5, [O]: 1, [R]: 0.5, [T]: 0.7 }, 0.7),
  /* evening */ row({ [T]: 3, [R]: 2.5, [S]: 1.5, [P]: 0.5, [O]: 0.3 }, 0.5),
  /* late    */ row({ [R]: 3, [T]: 1, [S]: 0.5, [O]: 0.1 }, 0.3),
];

export const STAY_MINUTES: readonly Row[] = [
  /* night   */ row({ [R]: 480, [O]: 240, [T]: 600, [S]: 60 }, 120),
  /* morning */ row({ [R]: 45, [O]: 240, [C]: 180, [T]: 40, [S]: 30, [P]: 90 }, 60),
  /* midday  */ row({ [R]: 180, [O]: 180, [C]: 120, [T]: 180, [S]: 30, [P]: 60 }, 60),
  /* evening */ row({ [R]: 360, [O]: 25, [C]: 40, [T]: 240, [S]: 40, [P]: 60 }, 60),
  /* late    */ row({ [R]: 480, [O]: 120, [T]: 480, [S]: 60 }, 120),
];

/** Share of the population on the streets at the start, by period (the rest are inside). */
export const START_WALKING: readonly number[] = [0.005, 0.05, 0.04, 0.05, 0.015];
