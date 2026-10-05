import type { MetricsBus } from '@city/metrics';
import { type BakedCharacter, bakeCharacter } from './bake-character.ts';
import { buildLodChain, type LodChain } from './build-lods.ts';
import { type CharacterSource, loadCharacter } from './load-character.ts';
import { HUMAN_LOD_TRIANGLES, ROBOT_LOD_TRIANGLES } from './lod-policy.ts';

/** `human0`, `human1`, … per base mesh, then `robot`. */
export type FamilyKey = `human${number}` | 'robot';

/** "Robots", "Humans" or "Human base 2" for display. */
export function familyLabel(key: string, humanBases: number): string {
  if (key === 'robot') return 'Robots';
  return humanBases > 1 ? `Human base ${Number(key.slice(5)) + 1}` : 'Humans';
}

/** What panels and result files report about one loaded family. */
export interface CharacterInfo {
  key: FamilyKey;
  model: string;
  clip: string;
  triangles: number;
  sourceTriangles: number;
  bones: number;
  /** Skin influences per sub-mesh as drawn, e.g. [4, 4, 1]. */
  influences: (1 | 4)[];
  /** Rigid bone-parented parts or foreign skins were merged onto one skeleton. */
  mergedParts: boolean;
  /** LOD triangles per character, when LODs were built. */
  lodTriangles: number[] | null;
}

/** One skeleton family, ready for any render path. */
export interface LoadedFamily {
  key: FamilyKey;
  robot: boolean;
  source: CharacterSource;
  baked: BakedCharacter;
  lodChain: LodChain | null;
  info: CharacterInfo;
}

export interface FamilySpec {
  key: FamilyKey;
  /** glTF URL, or TEST_RIG_MODEL. */
  model: string;
  /** Clip to play; undefined prefers a walk-like clip. */
  clip?: string | undefined;
  /** Decimate the source mesh to about this many triangles (humans). */
  targetTriangles?: number | undefined;
  /** Scale the model to this height in metres (robots). */
  targetHeight?: number | undefined;
  /** Merge rigid bone-parented parts onto one skeleton (robots). */
  rigid?: boolean;
  /** Bake a tint mask so clothing and skin can be recoloured per agent (humans). */
  tintMask?: boolean;
  withLods: boolean;
}

/** load → bake every clip → LOD chain, identically for humans and robots. */
export async function loadFamily(
  spec: FamilySpec,
  bus: MetricsBus,
  progress: (message: string) => void = () => undefined,
): Promise<LoadedFamily> {
  const robot = spec.key === 'robot';
  progress(`Loading ${spec.model}…`);
  const source = await loadCharacter(spec.model, spec.clip, {
    targetTriangles: spec.targetTriangles,
    targetHeight: spec.targetHeight,
    rigid: spec.rigid ?? false,
    tintMask: spec.tintMask ?? false,
  });
  progress(`Baking ${spec.key} animation…`);
  const baked = bakeCharacter(source, bus, spec.key);
  let lodChain: LodChain | null = null;
  if (spec.withLods) {
    progress(`Building ${spec.key} LODs…`);
    lodChain = await buildLodChain(source, robot ? ROBOT_LOD_TRIANGLES : HUMAN_LOD_TRIANGLES);
    lodChain.triangles.forEach((triangles, lod) => {
      bus.setGauge(`lod.${spec.key}.triangles${lod}`, triangles);
    });
  }
  return {
    key: spec.key,
    robot,
    source,
    baked,
    lodChain,
    info: {
      key: spec.key,
      model: source.model,
      clip: source.clip.name,
      triangles: source.triangles,
      sourceTriangles: source.sourceTriangles,
      bones: source.bones,
      influences: source.influences,
      mergedParts: source.mergedParts,
      lodTriangles: lodChain?.triangles ?? null,
    },
  };
}
