import { describe, expect, it } from 'vitest';
import { DEFAULT_SWEEP, parseScenario, RenderPathKind, TEST_RIG_MODEL } from './scenario.ts';

describe('parseScenario', () => {
  it('defaults to an interactive Path B run of the test rig', () => {
    expect(parseScenario('')).toEqual({
      path: RenderPathKind.B,
      models: [TEST_RIG_MODEL],
      clip: undefined,
      tris: undefined,
      robot: undefined,
      robotShare: 0,
      robotClip: undefined,
      robotSkin: 'authored',
      robotHeight: 1.75,
      agents: 500,
      sweep: DEFAULT_SWEEP,
      warmupMs: 2000,
      measureMs: 5000,
      autorun: false,
      seed: 1,
      lod: null,
      impostors: true,
      lodPreset: 'brief',
      lodColours: false,
      fade: true,
      fadeMs: 300,
      tint: true,
      layout: 'crowd',
      strategy: 'events',
      warnings: [],
    });
  });

  it('reads the robot family parameters', () => {
    expect(parseScenario('?robot=/models/RobotExpressive.glb')).toMatchObject({
      robot: '/models/RobotExpressive.glb',
      robotShare: 0.25,
    });
    expect(
      parseScenario('?robot=/r.glb&robots=1&robotClip=Walking&robotSkin=rigid&robotHeight=1.6'),
    ).toMatchObject({
      robotShare: 1,
      robotClip: 'Walking',
      robotSkin: 'rigid',
      robotHeight: 1.6,
      warnings: [],
    });
    expect(parseScenario('?robots=2&robotSkin=soft&robotHeight=0').warnings).toHaveLength(3);
  });

  it('reads the transfer strategy', () => {
    expect(parseScenario('?path=transfer&strategy=ranges')).toMatchObject({
      path: 'transfer',
      strategy: 'ranges',
    });
    expect(parseScenario('?strategy=x').warnings).toHaveLength(1);
  });

  it('reads the appearance parameters', () => {
    expect(parseScenario('?tint=0&layout=lineup')).toMatchObject({ tint: false, layout: 'lineup' });
  });

  it('reads the LOD debug parameters', () => {
    expect(parseScenario('?lod=3&lodPreset=density&lodColours=1&fade=0&fadeMs=2000')).toMatchObject(
      {
        lod: 3,
        lodPreset: 'density',
        lodColours: true,
        fade: false,
        fadeMs: 2000,
        warnings: [],
      },
    );
    expect(parseScenario('?lod=auto').lod).toBeNull();
    expect(parseScenario('?lod=impostor&impostors=0')).toMatchObject({ lod: 5, impostors: false });
    expect(parseScenario('?lod=7&lodPreset=x').warnings).toHaveLength(2);
  });

  it('reads every parameter', () => {
    const scenario = parseScenario(
      '?path=idle&model=/models/Xbot.glb,%20/models/Soldier.glb&clip=walk&tris=1200&agents=42&sweep=10,%2020&warmup=0.5&measure=3&autorun=1&seed=9',
    );
    expect(scenario).toMatchObject({
      path: RenderPathKind.Idle,
      models: ['/models/Xbot.glb', '/models/Soldier.glb'],
      clip: 'walk',
      tris: 1200,
      agents: 42,
      sweep: [10, 20],
      warmupMs: 500,
      measureMs: 3000,
      autorun: true,
      seed: 9,
      warnings: [],
    });
  });

  it('falls back to defaults and explains invalid values', () => {
    const scenario = parseScenario('?path=z&agents=-3&sweep=1,x&measure=0');
    expect(scenario.path).toBe(RenderPathKind.B);
    expect(scenario.agents).toBe(500);
    expect(scenario.sweep).toEqual(DEFAULT_SWEEP);
    expect(scenario.measureMs).toBe(5000);
    expect(scenario.warnings).toHaveLength(4);
  });
});
