import type { MetricsBus } from '@city/metrics';
import { type FamilyKey, type LoadedFamily, loadFamily } from '@city/render';
import type { Scenario } from '../harness/scenario.ts';

export type { CharacterInfo, LoadedFamily } from '@city/render';

/**
 * Loads the families a scenario asks for — one per human base mesh unless the crowd is all
 * robots, plus robots when a robot model is given and the share is above zero. Human bases come
 * first, the robot last.
 */
export async function loadFamilies(
  scenario: Scenario,
  bus: MetricsBus,
  withLods: boolean,
  progress: (message: string) => void,
): Promise<LoadedFamily[]> {
  const wanted: { key: FamilyKey; model: string }[] = [];
  if (scenario.robot === undefined || scenario.robotShare < 1) {
    scenario.models.forEach((model, base) => {
      wanted.push({ key: `human${base}`, model });
    });
  }
  if (scenario.robot !== undefined && scenario.robotShare > 0) {
    wanted.push({ key: 'robot', model: scenario.robot });
  }
  const families: LoadedFamily[] = [];
  for (const { key, model } of wanted) {
    const robot = key === 'robot';
    families.push(
      await loadFamily(
        {
          key,
          model,
          clip: robot ? scenario.robotClip : scenario.clip,
          targetTriangles: robot ? undefined : scenario.tris,
          targetHeight: robot ? scenario.robotHeight : undefined,
          rigid: robot && scenario.robotSkin === 'rigid',
          tintMask: !robot && scenario.tint,
          withLods,
        },
        bus,
        progress,
      ),
    );
  }
  return families;
}
