import type { AdapterReport } from '@city/metrics';
import type { CharacterInfo } from '@city/render';
import type { Scenario } from './scenario.ts';
import type { StepResult } from './sweep-runner.ts';

/** /2: `character` became `characters` (one per skeleton family); steps gained `lodVisible`. */
export const BENCHMARK_RESULT_SCHEMA = 'city-benchmark/2';

/** One sweep's output. This JSON is the input to the step 0.11 report generator. */
export interface BenchmarkResult {
  schema: typeof BENCHMARK_RESULT_SCHEMA;
  createdAt: string;
  userAgent: string;
  devicePixelRatio: number;
  canvas: { width: number; height: number };
  crossOriginIsolated: boolean;
  adapter: AdapterReport;
  scenario: Omit<Scenario, 'warnings' | 'autorun'>;
  /** Families actually loaded (humans first), after defaults were resolved. */
  characters: CharacterInfo[];
  steps: StepResult[];
}

export function resultFileName(result: BenchmarkResult): string {
  const stamp = result.createdAt.replace(/[:.]/g, '-');
  return `benchmark-path-${result.scenario.path}-${stamp}.json`;
}
