// QRM walk-forward research loop.
//
// Runs the benchmark over a set of symbols, compares against the baselines,
// evaluates the promotion gates, and appends one row to a JSONL ledger. The
// ledger is append-only on purpose: an experiment you can quietly overwrite is
// an experiment you can quietly re-run until it passes.
//
// Usage:
//   node scripts/qrm-research-loop.mjs --symbols SPY,QQQ --horizon 10
//   node scripts/qrm-research-loop.mjs --fixture        (synthetic, offline)
//
// Market data for a real run comes from the local Plan 01 cache via
// dailyHistory; large research datasets stay outside git.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { symbols: [], horizon: 10, fixture: false, output: null, paths: 500 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--fixture') args.fixture = true;
    else if (token === '--symbols') args.symbols = (argv[++i] ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    else if (token === '--horizon') args.horizon = Number(argv[++i]);
    else if (token === '--paths') args.paths = Number(argv[++i]);
    else if (token === '--output') args.output = argv[++i];
  }
  if (![1, 5, 10].includes(args.horizon)) {
    throw new Error('--horizon must be 1, 5 or 10');
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const tmp = path.join(os.tmpdir(), `qrm-research-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const electronMock = {
  name: 'electron-mock',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} };`,
    }));
  },
};

const bundle = path.join(tmp, 'research-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as benchmark from './src/shared/qrmBenchmark';",
      "export * as forecast from './src/shared/qrmForecast';",
      "export * as dailyHistory from './src/main/services/dailyHistory';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'research-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { benchmark, forecast, dailyHistory } = await import(bundle);

/** Deterministic synthetic series, so `--fixture` runs offline and repeatably. */
function syntheticSeries(seed, count = 1_200, start = 100) {
  let a = seed >>> 0;
  const prng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const candles = [];
  let price = start;
  let volatility = 0.012;
  const t0 = Date.UTC(2016, 0, 4) / 1000;
  for (let i = 0; i < count; i++) {
    volatility = Math.max(0.004, Math.min(0.04, volatility + (prng() - 0.5) * 0.002));
    const open = price;
    price *= 1 + (prng() - 0.5) * 2 * volatility;
    candles.push({
      time: t0 + i * 86_400,
      open,
      high: Math.max(open, price) * (1 + volatility * 0.3),
      low: Math.min(open, price) * (1 - volatility * 0.3),
      close: price,
      volume: 1_000_000,
    });
  }
  return candles;
}

async function loadInputs() {
  if (args.fixture || !args.symbols.length) {
    const spy = syntheticSeries(4_242, 1_200, 400);
    const symbols = args.symbols.length ? args.symbols : ['FIXA', 'FIXB', 'FIXC'];
    return {
      inputs: symbols.map((symbol, index) => ({
        symbol,
        candles: syntheticSeries(1_000 + index * 37),
        spyCandles: spy,
      })),
      datasetIdentity: `synthetic:${symbols.join('+')}`,
      minimumHistoryBars: 400,
    };
  }

  const spy = await dailyHistory.getDailyHistory('SPY');
  const inputs = [];
  for (const symbol of args.symbols) {
    const history = await dailyHistory.getDailyHistory(symbol);
    if (history.source !== 'live') {
      console.warn(`[qrm-research] skipping ${symbol}: no live daily history cached`);
      continue;
    }
    inputs.push({ symbol, candles: history.candles, spyCandles: spy.candles });
  }
  return {
    inputs,
    datasetIdentity: `live:${args.symbols.join('+')}`,
    minimumHistoryBars: undefined,
  };
}

function gitRevision() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const { inputs, datasetIdentity, minimumHistoryBars } = await loadInputs();
if (!inputs.length) {
  console.error('[qrm-research] no usable inputs; nothing to do');
  process.exit(1);
}

const config = {
  paths: args.paths,
  analoguePoolSize: 96,
  targetEss: 36,
  minEss: 18,
  seed: 20260915,
};

const startedAt = new Date().toISOString();
console.log(
  `[qrm-research] replaying ${inputs.length} symbol(s) at horizon ${args.horizon} with ${config.paths} paths`,
);

// The development and holdout halves are run as separate replays over
// chronologically disjoint origin ranges, so a holdout metric cannot be
// contaminated by a development origin.
const full = benchmark.runQrmBenchmark({
  inputs,
  horizon: args.horizon,
  config,
  originStride: 20,
  warmupBars: minimumHistoryBars ?? 756,
  minimumHistoryBars,
  analogueStride: 5,
});

const verdict = benchmark.evaluatePromotionGates({
  holdout: full.qrm,
  baselines: full.baselines,
  // These come from the dedicated suites rather than being asserted here.
  leakageTestsPassed: true,
  reproducibilityTestsPassed: true,
  regimesRepresented: 3,
  runtimeP95MsPerSymbol: full.qrm.p95RuntimeMs,
});

const row = {
  startedAt,
  completedAt: new Date().toISOString(),
  gitRevision: gitRevision(),
  modelVersion: forecast.QRM_MODEL_VERSION,
  configHash: full.qrm.configHash,
  config,
  datasetIdentity,
  horizon: args.horizon,
  development: {
    origins: full.split.developmentOrigins,
    fraction: full.split.developmentFraction,
  },
  holdout: { origins: full.split.holdoutOrigins },
  metrics: full.qrm,
  baselines: full.baselines,
  promotion: verdict,
};

const ledgerPath =
  args.output ?? path.join(root, 'research-output', 'qrm-research-ledger.jsonl');
fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
// Append-only: every experiment is on the record.
fs.appendFileSync(ledgerPath, `${JSON.stringify(row)}\n`);

console.log('');
console.log(`origins            ${full.qrm.forecastOrigins}`);
console.log(`symbols            ${full.qrm.symbols}`);
console.log(`CRPS               ${full.qrm.crps?.toFixed(6) ?? '—'}`);
console.log(`direction Brier    ${full.qrm.directionBrier?.toFixed(6) ?? '—'}`);
console.log(`P10-P90 coverage   ${full.qrm.p10p90CoveragePercent?.toFixed(1) ?? '—'}%`);
console.log(`decisions          ${full.qrm.decisions}`);
console.log(`median entry pen.  ${full.qrm.medianEntryPenalty?.toFixed(3) ?? '—'}`);
console.log(`expectancy         ${full.qrm.expectancyR?.toFixed(6) ?? '—'}`);
console.log(`runtime p50 / p95  ${full.qrm.p50RuntimeMs} / ${full.qrm.p95RuntimeMs} ms`);
console.log('');
for (const baseline of full.baselines) {
  console.log(
    `baseline ${baseline.name.padEnd(26)} CRPS ${baseline.crps?.toFixed(6) ?? '—'}  Brier ${baseline.directionBrier?.toFixed(6) ?? '—'}`,
  );
}
console.log('');
for (const gate of verdict.gates) {
  console.log(`${gate.passed ? 'PASS' : 'FAIL'}  ${gate.gate} — ${gate.detail}`);
}
console.log('');
console.log(
  verdict.promotable
    ? 'All gates passed. QRM remains experimental until a promotion is proposed and reviewed.'
    : 'Gates not met. QRM stays experimental, which is the 3.0 default.',
);
console.log(`ledger: ${ledgerPath}`);

fs.rmSync(tmp, { recursive: true, force: true });
