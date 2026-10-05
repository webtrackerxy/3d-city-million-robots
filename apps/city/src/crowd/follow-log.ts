import type { FollowKind } from '@city/sim';

/** Journey of the followed agent, as the panel lists it. */
export interface FollowLog {
  agent: number;
  kind: FollowKind;
  seed: number;
  lines: { at: number; text: string }[];
  last: string;
}
