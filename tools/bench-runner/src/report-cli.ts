/**
 * Regenerates the Stage 0 report from saved matrix runs, without re-running anything:
 *
 *   yarn workspace @city/bench-runner report docs/benchmarks/stage0-matrix/<machine>-<date>.json
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunRecord } from './aggregate.ts';
import { writeReport } from './main.ts';

const file = process.argv[2];
if (file === undefined) throw new Error('Usage: report <matrix-runs.json>');
// Relative to the repository root (`yarn workspace` runs scripts from the package folder).
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const rawFile = resolve(root, file);
const saved = JSON.parse(readFileSync(rawFile, 'utf8')) as {
  machine: string;
  createdAt: string;
  environment: Parameters<typeof writeReport>[0]['environment'];
  repetitions: number;
  runs: RunRecord[];
};
writeReport({ ...saved, rawFile, benchDir: resolve(dirname(rawFile), '..') });
console.log(`Wrote docs/benchmarks/stage0-${saved.machine}.md`);
