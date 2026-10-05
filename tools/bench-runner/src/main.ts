/**
 * Step 0.11: automated Stage 0 benchmark matrix.
 *
 *   yarn workspace @city/bench-runner matrix [--reps 3] [--only id,id] [--machine name] [--max-load 6]
 *                                              [--merge docs/benchmarks/stage0-matrix/<file>.json]
 *
 * `--merge` (path relative to the repository root) re-runs only the `--only` entries and replaces
 * them in an earlier results file.
 *
 * Builds the benchmark app, serves the production build with `vite preview` (COOP/COEP headers),
 * runs every matrix entry in headless Chrome via Playwright, repeats it, records the machine load
 * around every run, and writes the raw runs plus the report `docs/benchmarks/stage0-<machine>.md`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem, type as osType } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright-core';
import type { ResultLite, RunRecord } from './aggregate.ts';
import { entryUrl, MATRIX } from './matrix.ts';
import { buildReport, type SimBenchResult } from './report.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const argument = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const repetitions = Number(argument('reps') ?? 3);
const only = argument('only')?.split(',');
const maxLoad = Number(argument('max-load') ?? Math.max(4, cpus().length * 0.6));
const machine = argument('machine') ?? machineName();
/** Re-run only some entries and merge them into an earlier results file (replacing them). */
const mergeArgument = argument('merge');
// Relative to the repository root (`yarn workspace` runs scripts from the package folder).
const mergeInto = mergeArgument === undefined ? undefined : resolve(root, mergeArgument);
if (mergeInto !== undefined && !existsSync(mergeInto)) {
  throw new Error(`--merge file not found: ${mergeInto}`);
}
const PORT = 4179;
/** A run is discarded when the load after it exceeds the limit by this factor. */
const DISTURBED_FACTOR = 1.5;
const MAX_ATTEMPTS = 3;
const RUN_TIMEOUT_MS = 10 * 60_000;
const LAB_ARGS = ['--enable-unsafe-webgpu', '--disable-frame-rate-limit', '--disable-gpu-vsync'];
const CAPPED_ARGS = ['--enable-unsafe-webgpu'];

function machineName(): string {
  return (cpus()[0]?.model ?? 'unknown')
    .toLowerCase()
    .replace(/apple\s+/, '')
    .replace(/[^a-z0-9]+/g, '');
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Waits (up to 5 minutes) for the 1-minute load average to drop below the limit. */
async function waitForQuiet(): Promise<number> {
  const deadline = Date.now() + 5 * 60_000;
  let load = loadavg()[0] ?? 0;
  while (load > maxLoad && Date.now() < deadline) {
    console.log(`  load ${load.toFixed(1)} > ${maxLoad}; waiting…`);
    await sleep(15_000);
    load = loadavg()[0] ?? 0;
  }
  return load;
}

async function startPreview(): Promise<() => void> {
  console.log('Building the benchmark app…');
  execFileSync('yarn', ['workspace', '@city/city', 'build'], { cwd: root, stdio: 'inherit' });
  const server = spawn(
    'yarn',
    ['workspace', '@city/city', 'preview', '--port', String(PORT), '--strictPort'],
    {
      cwd: root,
      stdio: 'ignore',
    },
  );
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(`http://localhost:${PORT}/`);
      if (response.ok) return () => server.kill();
    } catch {
      // Not listening yet.
    }
    await sleep(500);
  }
  server.kill();
  throw new Error('vite preview did not start');
}

async function runOnce(browser: Browser, url: string): Promise<ResultLite> {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  try {
    await page.goto(url);
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const state = await page
        .evaluate(
          () =>
            (
              window as unknown as {
                __cityBenchmark?: { status: string; result?: unknown; error?: string };
              }
            ).__cityBenchmark,
        )
        .catch(() => undefined);
      if (state?.status === 'done' && state.result !== undefined) return state.result as ResultLite;
      if (state?.status === 'failed') throw new Error(state.error ?? 'benchmark failed');
      await sleep(1000);
    }
    throw new Error('timed out');
  } finally {
    await page.close();
  }
}

async function main(): Promise<void> {
  const stopPreview = await startPreview();
  const origin = `http://localhost:${PORT}`;
  const entries = MATRIX.filter((entry) => only === undefined || only.includes(entry.id));
  const browsers = {
    lab: await chromium.launch({ channel: 'chrome', headless: true, args: LAB_ARGS }),
    capped: await chromium.launch({ channel: 'chrome', headless: true, args: CAPPED_ARGS }),
  };
  // The headless user agent reports a reduced version; ask the browser itself.
  const chromeVersion = browsers.lab.version();
  const runs: RunRecord[] = [];
  const started = new Date();
  try {
    // Repetitions are interleaved (all entries, then again) so slow drift hits every entry alike.
    for (let repetition = 1; repetition <= repetitions; repetition++) {
      for (const entry of entries) {
        const url = entryUrl(origin, entry);
        // Other work on the machine (a build starting mid-run) invalidates a measurement: the run
        // is kept as a record but marked, and redone once the machine is quiet again.
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
          const loadBefore = await waitForQuiet();
          const t0 = performance.now();
          process.stdout.write(
            `[${repetition}/${repetitions}] ${entry.id}${attempt > 1 ? ` (attempt ${attempt})` : ''} … `,
          );
          let result: ResultLite | null = null;
          let error: string | undefined;
          try {
            result = await runOnce(entry.capped === true ? browsers.capped : browsers.lab, url);
          } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
          }
          const loadAfter = loadavg()[0] ?? 0;
          const disturbed = loadAfter > maxLoad * DISTURBED_FACTOR;
          runs.push({
            entryId: entry.id,
            repetition,
            url,
            loadBefore,
            loadAfter,
            wallMs: performance.now() - t0,
            result: disturbed ? null : result,
            ...(error !== undefined
              ? { error }
              : disturbed
                ? { error: `disturbed: load rose to ${loadAfter.toFixed(1)}` }
                : {}),
          });
          const seconds = ((performance.now() - t0) / 1000).toFixed(0);
          if (error !== undefined) {
            console.log(`FAILED: ${error}`);
            break;
          }
          if (!disturbed) {
            console.log(`${seconds} s`);
            break;
          }
          console.log(`${seconds} s, discarded (load ${loadAfter.toFixed(1)})`);
        }
      }
    }
  } finally {
    await browsers.lab.close();
    await browsers.capped.close();
    stopPreview();
  }

  const benchDir = join(root, 'docs/benchmarks');
  const rawDir = join(benchDir, 'stage0-matrix');
  mkdirSync(rawDir, { recursive: true });
  let rawFile = join(rawDir, `${machine}-${started.toISOString().slice(0, 10)}.json`);
  if (mergeInto !== undefined) {
    rawFile = mergeInto;
    const previous = JSON.parse(readFileSync(rawFile, 'utf8')) as { runs: RunRecord[] };
    const rerun = new Set(runs.map((run) => run.entryId));
    runs.unshift(...previous.runs.filter((run) => !rerun.has(run.entryId)));
  }
  const firstResult = runs.find((run) => run.result !== null)?.result ?? undefined;
  const environment = {
    cpu: `${cpus()[0]?.model ?? 'unknown'} (${cpus().length} cores)`,
    memoryGb: Math.round(totalmem() / 2 ** 30),
    os: `${osType()} ${release()}`,
    browser: `Chrome ${chromeVersion}`,
    adapter:
      firstResult === undefined
        ? 'unknown'
        : `${firstResult.adapter.vendor} / ${firstResult.adapter.architecture}`,
    canvas:
      firstResult === undefined
        ? 'unknown'
        : `${firstResult.canvas.width} × ${firstResult.canvas.height}`,
  };
  writeFileSync(
    rawFile,
    `${JSON.stringify({ schema: 'city-bench-matrix/1', machine, createdAt: started.toISOString(), environment, repetitions, maxLoad, runs }, null, 2)}\n`,
  );

  writeReport({
    machine,
    createdAt: started.toISOString(),
    environment,
    repetitions,
    runs,
    rawFile,
    benchDir,
  });
  console.log(`Wrote ${relative(root, rawFile)} and docs/benchmarks/stage0-${machine}.md`);
}

export function writeReport(options: {
  machine: string;
  createdAt: string;
  environment: Parameters<typeof buildReport>[0]['environment'];
  repetitions: number;
  runs: RunRecord[];
  rawFile: string;
  benchDir: string;
}): void {
  const simFile = join(options.benchDir, `stage0-sim-${options.machine}.json`);
  const fallbackSim = join(options.benchDir, 'stage0-sim-m1pro.json');
  const simPath = existsSync(simFile) ? simFile : existsSync(fallbackSim) ? fallbackSim : null;
  const simBench =
    simPath === null
      ? null
      : (JSON.parse(readFileSync(simPath, 'utf8')) as { results: SimBenchResult[] }).results;
  const decisionsDir = join(root, 'docs/decisions');
  const decisions = existsSync(decisionsDir)
    ? readdirSync(decisionsDir)
        .filter((file) => file.endsWith('.md'))
        .sort()
        .map((file) => ({
          file: relative(options.benchDir, join(decisionsDir, file)),
          title: /^#\s+(.+)$/m.exec(readFileSync(join(decisionsDir, file), 'utf8'))?.[1] ?? file,
        }))
    : [];
  const markdown = buildReport({
    machine: options.machine,
    createdAt: options.createdAt,
    environment: options.environment,
    repetitions: options.repetitions,
    matrix: MATRIX,
    runs: options.runs,
    simBench,
    decisions,
    rawFile: relative(options.benchDir, options.rawFile),
  });
  writeFileSync(join(options.benchDir, `stage0-${options.machine}.md`), markdown);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
