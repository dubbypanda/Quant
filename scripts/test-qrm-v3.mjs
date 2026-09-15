// QRM-3 tests (docs/quant-v3/05, sections 23-25 and Tasks 1-8).
//
// Three families, matching the document:
//   * data-leakage tests — no future row may influence a point-in-time state,
//     an analogue, or a replayed forecast;
//   * reproducibility tests — same seed and config give identical output;
//   * statistical tests — ESS monotonicity, weighted quantiles, coverage,
//     and CRPS against baselines.
//
// Fixtures are small and synthetic, generated deterministically in-process.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-qrm-test-${process.pid}`);
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

const bundle = path.join(tmp, 'qrm-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as qrm from './src/shared/qrm';",
      "export * as state from './src/shared/qrmState';",
      "export * as analogue from './src/shared/qrmAnalogue';",
      "export * as bootstrap from './src/shared/qrmBootstrap';",
      "export * as forecast from './src/shared/qrmForecast';",
      "export * as decision from './src/shared/qrmDecision';",
      "export * as benchmark from './src/shared/qrmBenchmark';",
      "export * as service from './src/main/services/qrmService';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'qrm-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { qrm, state, analogue, bootstrap, forecast, decision, benchmark, service } =
  await import(bundle);

const DAY = 86_400;
const T0 = Date.UTC(2016, 0, 4) / 1000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic daily series with volatility clustering, so the bootstrap has
 *  something real to preserve. */
function series({ count = 1200, seed = 42, start = 100 } = {}) {
  const prng = mulberry32(seed);
  const candles = [];
  let price = start;
  let volatility = 0.01;
  for (let i = 0; i < count; i++) {
    // Slowly varying volatility: this is the clustering an independent daily
    // bootstrap would destroy.
    volatility = Math.max(0.004, Math.min(0.04, volatility + (prng() - 0.5) * 0.002));
    const move = (prng() - 0.5) * 2 * volatility;
    const open = price;
    price *= 1 + move;
    candles.push({
      time: T0 + i * DAY,
      open,
      high: Math.max(open, price) * (1 + volatility * 0.3),
      low: Math.min(open, price) * (1 - volatility * 0.3),
      close: price,
      volume: 1_000_000 * (0.6 + prng()),
    });
  }
  return candles;
}

const ASSET = series({ count: 1200, seed: 42 });
const SPY = series({ count: 1200, seed: 4242, start: 400 });

// ---------------------------------------------------------------------------
console.log('--- Test 1: Point-in-time state reads no future row (leakage) ---');
{
  const cutoff = 900;
  const full = state.buildQrmStateAt(ASSET, SPY, cutoff);
  assert.ok(full, 'a state is produced with ample history');
  assert.equal(full.asOf, ASSET[cutoff].time, 'the state is stamped at the cutoff bar');

  // Truncating the series AT the cutoff must not change the state at all. If
  // any statistic read a later bar, these would differ.
  const truncated = state.buildQrmStateAt(ASSET.slice(0, cutoff + 1), SPY, cutoff);
  assert.deepEqual(truncated, full, 'future bars cannot influence the state');

  // Corrupting every future bar must likewise change nothing.
  const poisoned = ASSET.map((candle, index) =>
    index > cutoff
      ? { ...candle, open: 1e6, high: 1e6, low: 1e6, close: 1e6, volume: 1e12 }
      : candle,
  );
  assert.deepEqual(
    state.buildQrmStateAt(poisoned, SPY, cutoff),
    full,
    'poisoned future bars cannot leak into the state',
  );

  // The benchmark is cut off too: a future SPY bar is just as much of a leak.
  const poisonedSpy = SPY.map((candle) =>
    candle.time > ASSET[cutoff].time
      ? { ...candle, open: 1e6, high: 1e6, low: 1e6, close: 1e6 }
      : candle,
  );
  assert.deepEqual(
    state.buildQrmStateAt(ASSET, poisonedSpy, cutoff),
    full,
    'poisoned future benchmark bars cannot leak either',
  );

  // Clamping, and the unclamped diagnostic value.
  const train = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 1 : 1.2));
  const extreme = state.robustStandardize(500, train);
  assert.equal(extreme.z, state.QRM_Z_CLAMP, 'the model input is clamped');
  assert.ok(extreme.rawZ > state.QRM_Z_CLAMP, 'the raw value is retained for diagnostics');
  assert.equal(state.robustStandardize(1, [1, 2, 3]), null, 'too few training samples');

  // Insufficient history yields null rather than a partial vector.
  assert.equal(state.buildQrmStateAt(ASSET.slice(0, 40), SPY, 39), null);
  assert.equal(state.buildQrmStateAt(ASSET, SPY, -1), null);
  assert.equal(state.buildQrmStateAt(ASSET, SPY, 99_999), null);

  // Regime stays categorical — never an ordinal number.
  assert.equal(typeof full.regime, 'string');
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Analogues fully realise their horizon before the cutoff ---');
{
  const cutoff = 900;
  const horizons = [1, 5, 10];
  const records = analogue.buildAnalogueRecords({
    candles: ASSET,
    spyCandles: SPY,
    cutoffIndex: cutoff,
    horizons,
    stateBuilder: state.buildQrmStateAt,
    stride: 5,
  });
  assert.ok(records.length > 20, `expected analogues, got ${records.length}`);

  const maxHorizon = Math.max(...horizons);
  for (const record of records) {
    // Every origin is strictly earlier than the cutoff by at least the longest
    // horizon, so its outcome was realised before inference.
    const originIndex = ASSET.findIndex((candle) => candle.time === record.time);
    assert.ok(originIndex >= 0);
    assert.ok(
      originIndex + maxHorizon <= cutoff - 1,
      `analogue at ${originIndex} leaks into the cutoff at ${cutoff}`,
    );
    for (const horizon of horizons) {
      assert.ok(Number.isFinite(record.forwardReturns[horizon]));
      assert.ok(record.forwardMfe[horizon] >= 0, 'MFE is a non-negative magnitude');
      assert.ok(record.forwardMae[horizon] >= 0, 'MAE is a non-negative magnitude');
    }
    assert.ok(record.subsequentDailyReturns.length > 0);
  }

  // Poisoning the future cannot change the analogue set for this cutoff.
  const poisoned = ASSET.map((candle, index) =>
    index > cutoff ? { ...candle, close: 1e6, high: 1e6, low: 1e6, open: 1e6 } : candle,
  );
  const poisonedRecords = analogue.buildAnalogueRecords({
    candles: poisoned,
    spyCandles: SPY,
    cutoffIndex: cutoff,
    horizons,
    stateBuilder: state.buildQrmStateAt,
    stride: 5,
  });
  assert.deepEqual(
    poisonedRecords.map((record) => record.forwardReturns[10]),
    records.map((record) => record.forwardReturns[10]),
    'analogue outcomes cannot come from beyond the cutoff',
  );

  // Distance is zero against itself and grows with difference.
  const current = records[0].state;
  assert.equal(analogue.stateDistanceSquared(current, current), 0);
  assert.ok(analogue.stateDistanceSquared(current, records[5].state) > 0);

  // Regime compatibility is an explicit, named matrix.
  assert.equal(analogue.regimeCompatibility('trending-up', 'trending-up'), 1);
  assert.equal(analogue.regimeCompatibility('trending-up', 'breakout-compression'), 0.8);
  assert.equal(analogue.regimeCompatibility('trending-up', 'trending-down'), 0.3);
  assert.equal(analogue.regimeCompatibility('trending-down', 'trending-up'), 0.3);
  assert.equal(analogue.regimeCompatibility('trending-up', 'high-volatility'), 0.55);
  assert.equal(analogue.regimeCompatibility('range-bound', 'choppy'), 0.8);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: ESS monotonicity and kernel solving (statistical) ---');
{
  const distances = Array.from({ length: 128 }, (_, i) => (i * 0.05) ** 2);
  const multipliers = distances.map(() => 1);

  // The bisection in solveKernelTemperature is only valid because ESS rises
  // monotonically with temperature. That is asserted here rather than assumed.
  let previous = 0;
  for (const temperature of [0.001, 0.01, 0.1, 1, 10, 100, 1_000]) {
    const weights = distances.map((distance) =>
      Math.exp(-(distance - Math.min(...distances)) / temperature),
    );
    const ess = analogue.effectiveSampleSize(weights);
    assert.ok(
      ess >= previous - 1e-9,
      `ESS must not fall as temperature rises: ${ess} after ${previous}`,
    );
    previous = ess;
  }

  const solved = analogue.solveKernelTemperature(distances, multipliers, 40);
  assert.ok(solved.reachable, 'a target of 40 is reachable in a pool of 128');
  assert.ok(Math.abs(solved.ess - 40) / 40 < 0.05, `ESS landed at ${solved.ess}`);
  assert.ok(solved.temperature > 0);
  assert.ok(solved.iterations <= 24, 'bisection is bounded');

  // An unreachable target reports the best it could do rather than pretending.
  const tooHigh = analogue.solveKernelTemperature(distances, multipliers, 500);
  assert.equal(tooHigh.reachable, false);
  assert.ok(tooHigh.ess > 0, 'the maximum reachable ESS is still returned');
  assert.ok(tooHigh.ess <= distances.length + 1e-6);

  assert.equal(analogue.solveKernelTemperature([], [], 40).ess, 0);
  assert.equal(analogue.solveKernelTemperature([1], [1], 40).reachable, false);

  // Equal weights give ESS = n; one dominant weight gives ESS near 1.
  assert.ok(Math.abs(analogue.effectiveSampleSize([1, 1, 1, 1]) - 4) < 1e-9);
  assert.ok(analogue.effectiveSampleSize([1, 1e-9, 1e-9]) < 1.01);
  assert.equal(analogue.effectiveSampleSize([]), 0);
  assert.equal(analogue.effectiveSampleSize([0, 0]), 0);
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Weighted quantiles (statistical) ---');
{
  const { weightedQuantile } = analogue;

  // Single item.
  assert.equal(weightedQuantile([5], [1], 0.5), 5);
  assert.equal(weightedQuantile([5], [1], 0), 5);
  assert.equal(weightedQuantile([5], [1], 1), 5);

  // Equal weights reproduce the ordinary empirical quantile.
  const values = [1, 2, 3, 4, 5];
  const equal = values.map(() => 1);
  assert.equal(weightedQuantile(values, equal, 0.5), 3, 'median of 1..5');
  assert.equal(weightedQuantile(values, equal, 0), 1);
  assert.equal(weightedQuantile(values, equal, 1), 5);

  // Skewed weights move the median toward the heavy value.
  const skewed = weightedQuantile([1, 2, 3], [1, 1, 100], 0.5);
  assert.ok(skewed > 2.5, `a heavy top weight pulls the median up, got ${skewed}`);
  const skewedLow = weightedQuantile([1, 2, 3], [100, 1, 1], 0.5);
  assert.ok(skewedLow < 1.5, `a heavy bottom weight pulls it down, got ${skewedLow}`);

  // Duplicate values are handled deterministically.
  assert.equal(weightedQuantile([2, 2, 2], [1, 2, 3], 0.5), 2);
  assert.equal(weightedQuantile([1, 1, 9], [1, 1, 1], 0.1), 1);

  // Unnormalized weights are accepted and give the same answer as normalized.
  assert.ok(
    Math.abs(
      weightedQuantile(values, [2, 2, 2, 2, 2], 0.5) - weightedQuantile(values, equal, 0.5),
    ) < 1e-12,
    'scaling all weights changes nothing',
  );

  // Invalid inputs are rejected rather than silently coerced.
  assert.throws(() => weightedQuantile([], [], 0.5), RangeError);
  assert.throws(() => weightedQuantile([1, 2], [1], 0.5), RangeError);
  assert.throws(() => weightedQuantile([1, 2], [1, 0], 0.5), RangeError, 'zero weight');
  assert.throws(() => weightedQuantile([1, 2], [1, -1], 0.5), RangeError, 'negative weight');
  assert.throws(() => weightedQuantile([1, 2], [1, Number.NaN], 0.5), RangeError);
  assert.throws(() => weightedQuantile([1, 2], [1, 1], 1.5), RangeError, 'q out of range');
  assert.throws(() => weightedQuantile([1, 2], [1, 1], -0.1), RangeError);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Bootstrap determinism and block structure ---');
{
  const records = analogue.buildAnalogueRecords({
    candles: ASSET,
    spyCandles: SPY,
    cutoffIndex: 900,
    horizons: [1, 5, 10],
    stateBuilder: state.buildQrmStateAt,
    stride: 5,
  });
  const current = state.buildQrmStateAt(ASSET, SPY, 900);
  const pool = analogue.nearestAnalogues(current, records, 64);
  const kernel = analogue.solveKernelTemperature(
    pool.map((item) => item.distanceSquared),
    pool.map((item) => item.regimeMultiplier),
    40,
  );
  const weighted = analogue.weightAnalogues(pool, kernel.temperature);

  const weightSum = weighted.reduce((sum, item) => sum + item.weight, 0);
  assert.ok(Math.abs(weightSum - 1) < 1e-9, 'weights are normalized');

  const args = {
    analogues: weighted,
    horizons: [1, 5, 10],
    paths: 200,
    seed: 12345,
    blockLength: 5,
    symbol: 'TEST',
  };
  const first = bootstrap.simulateQrmPaths(args);
  const second = bootstrap.simulateQrmPaths(args);
  assert.equal(first.length, 200);
  // Reproducibility: same seed and config, byte-identical output.
  assert.deepEqual(
    first.map((path) => path.terminalReturns[10]),
    second.map((path) => path.terminalReturns[10]),
    'the same seed reproduces the same paths exactly',
  );

  const different = bootstrap.simulateQrmPaths({ ...args, seed: 999 });
  assert.notDeepEqual(
    first.map((path) => path.terminalReturns[10]),
    different.map((path) => path.terminalReturns[10]),
    'a different seed gives different paths',
  );

  // A different symbol with the same seed also differs, so two symbols in one
  // run do not share a path set.
  const otherSymbol = bootstrap.simulateQrmPaths({ ...args, symbol: 'OTHER' });
  assert.notDeepEqual(
    first.map((path) => path.terminalReturns[10]),
    otherSymbol.map((path) => path.terminalReturns[10]),
  );

  for (const path of first) {
    assert.equal(path.closes.length, 10, 'one close per session to the longest horizon');
    assert.ok(path.mfe[10] >= 0 && path.mae[10] >= 0, 'excursions are magnitudes');
    // MFE and MAE must bracket the terminal return.
    assert.ok(path.mfe[10] + 1e-12 >= Math.max(0, path.terminalReturns[10]));
    assert.ok(path.mae[10] + 1e-12 >= Math.max(0, -path.terminalReturns[10]));
    assert.ok(path.firstHit === null || path.firstHit === 'loss' || path.firstHit === 'gain');
  }

  // Shorter horizons are prefixes of longer ones.
  const sample = first[0];
  assert.ok(Math.abs(sample.terminalReturns[1] - (sample.closes[0] - 1)) < 1e-12);

  // Block length matters: L=1 is an independent daily bootstrap, and its
  // 10-day dispersion differs from L=10's. If continuation probability were
  // ignored these would coincide.
  const independent = bootstrap.simulateQrmPaths({ ...args, blockLength: 1, paths: 400 });
  const blocky = bootstrap.simulateQrmPaths({ ...args, blockLength: 10, paths: 400 });
  const spread = (paths) => {
    const values = paths.map((path) => path.terminalReturns[10]).sort((a, b) => a - b);
    return values[Math.floor(values.length * 0.9)] - values[Math.floor(values.length * 0.1)];
  };
  assert.ok(
    Math.abs(spread(independent) - spread(blocky)) > 1e-6,
    'block length changes the path distribution',
  );

  assert.deepEqual(bootstrap.simulateQrmPaths({ ...args, analogues: [] }), []);
  assert.equal(bootstrap.DEFAULT_BLOCK_LENGTH, 5);
  assert.equal(bootstrap.QRM_PATH_COUNTS.discovery, 500);
  assert.equal(bootstrap.QRM_PATH_COUNTS.research, 1_000);
  assert.equal(bootstrap.QRM_PATH_COUNTS.lab, 2_000);

  // Cancellation is honoured between batches.
  assert.throws(
    () =>
      bootstrap.simulateQrmPaths({
        ...args,
        paths: 1_000,
        isCancelled: () => true,
      }),
    /cancelled/i,
  );

  // Progress is reported.
  const seen = [];
  bootstrap.simulateQrmPaths({
    ...args,
    paths: 200,
    progressEvery: 50,
    onProgress: (completed, total) => seen.push([completed, total]),
  });
  assert.ok(seen.length >= 4, `progress was emitted: ${JSON.stringify(seen)}`);
  assert.deepEqual(seen[seen.length - 1], [200, 200], 'completion is reported');
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Forecast assembly, reproducibility and unavailability ---');
{
  const config = { paths: 300, analoguePoolSize: 64, targetEss: 30, minEss: 15, seed: 777 };
  const args = {
    symbol: 'TEST',
    candles: ASSET,
    spyCandles: SPY,
    config,
    cutoffIndex: 900,
    minimumHistoryBars: 400,
    analogueStride: 5,
  };

  const first = forecast.buildQrmForecast(args);
  assert.equal(first.status, 'ready', JSON.stringify(first.warnings));
  assert.ok(first.snapshot);
  assert.equal(first.snapshot.symbol, 'TEST');
  assert.equal(first.snapshot.distributions.length, 3);
  assert.ok(first.snapshot.diagnostics.effectiveSampleSize >= 15);
  assert.ok(first.snapshot.diagnostics.analogueCount > 0);
  assert.equal(first.snapshot.diagnostics.dataCutoffTime, ASSET[900].time);
  assert.equal(first.snapshot.source, 'live');

  // Reproducibility: identical config and seed, identical distributions.
  const second = forecast.buildQrmForecast(args);
  assert.deepEqual(
    second.snapshot.distributions,
    first.snapshot.distributions,
    'the same config reproduces the same distributions',
  );
  assert.equal(second.snapshot.id, first.snapshot.id, 'the snapshot id is deterministic');

  // The id encodes model version, config hash and cutoff, so a config change
  // produces a different identity.
  const reconfigured = forecast.buildQrmForecast({
    ...args,
    config: { ...config, paths: 301 },
  });
  assert.notEqual(reconfigured.snapshot.id, first.snapshot.id);
  assert.notEqual(
    forecast.qrmConfigHash({ ...forecast.DEFAULT_QRM_CONFIG, seed: 1 }),
    forecast.qrmConfigHash({ ...forecast.DEFAULT_QRM_CONFIG, seed: 2 }),
  );

  // Quantiles are ordered and the band has real width.
  for (const distribution of first.snapshot.distributions) {
    const { p10, p25, p50, p75, p90 } = distribution.terminalReturn;
    assert.ok(p10 <= p25 && p25 <= p50 && p50 <= p75 && p75 <= p90, 'quantiles are ordered');
    assert.ok(p90 > p10, 'the band has width');
    assert.ok(distribution.probabilityPositive >= 0 && distribution.probabilityPositive <= 1);
    assert.ok(distribution.mfe.p50 >= 0 && distribution.mae.p50 >= 0);
  }

  // The direct weighted distribution is produced as the baseline the bootstrap
  // must justify itself against.
  assert.ok(first.directWeighted, 'the simpler baseline object is available');
  assert.ok(Number.isFinite(first.directWeighted[10].terminalReturn.p50));

  // Insufficient history is `unavailable` with a reason, not a lowered standard.
  const short = forecast.buildQrmForecast({
    ...args,
    candles: ASSET.slice(0, 200),
    cutoffIndex: 199,
    minimumHistoryBars: undefined,
  });
  assert.equal(short.status, 'unavailable');
  assert.equal(short.reason, 'insufficient-history');
  assert.equal(short.snapshot, null);
  assert.ok(short.warnings[0].includes('756'), short.warnings[0]);

  // Point-in-time: a forecast at a cutoff is unchanged by poisoning the future.
  const poisoned = ASSET.map((candle, index) =>
    index > 900 ? { ...candle, open: 1e6, high: 1e6, low: 1e6, close: 1e6 } : candle,
  );
  const fromPoisoned = forecast.buildQrmForecast({ ...args, candles: poisoned });
  assert.deepEqual(
    fromPoisoned.snapshot.distributions,
    first.snapshot.distributions,
    'a replayed forecast cannot see beyond its cutoff',
  );

  assert.equal(forecast.QRM_MINIMUM_HISTORY_BARS, 756);
  assert.equal(forecast.DEFAULT_QRM_CONFIG.targetEss, 40);
  assert.equal(forecast.DEFAULT_QRM_CONFIG.minEss, 20);
  assert.equal(forecast.DEFAULT_QRM_CONFIG.analoguePoolSize, 128);
  assert.deepEqual(forecast.DEFAULT_QRM_CONFIG.horizons, [1, 5, 10]);

  // Section 10 labels: a sampled range is never called a confidence interval
  // without measured coverage.
  assert.ok(/sampled range/i.test(forecast.QRM_BAND_LABEL));
  assert.ok(!/confidence/i.test(forecast.QRM_BAND_LABEL));
  assert.ok(/not yet measured/i.test(forecast.qrmCoverageLabel(null)));
  assert.ok(/77%/.test(forecast.qrmCoverageLabel(77)));
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: Benchmark scoring, baselines and split ---');
{
  const result = benchmark.runQrmBenchmark({
    inputs: [{ symbol: 'TEST', candles: ASSET, spyCandles: SPY }],
    horizon: 10,
    config: { paths: 120, analoguePoolSize: 48, targetEss: 24, minEss: 12, seed: 31337 },
    originStride: 40,
    warmupBars: 500,
    minimumHistoryBars: 400,
    analogueStride: 10,
    maximumOriginsPerSymbol: 8,
  });

  assert.ok(result.qrm.forecastOrigins > 0, 'origins were replayed');
  assert.equal(result.qrm.symbols, 1);
  assert.ok(result.qrm.crps !== null);
  assert.ok(result.qrm.crps >= 0, 'CRPS is a non-negative loss');
  assert.ok(result.qrm.directionBrier !== null);
  assert.ok(
    result.qrm.directionBrier >= 0 && result.qrm.directionBrier <= 1,
    'Brier is within [0, 1]',
  );
  assert.ok(result.qrm.p10p90CoveragePercent !== null);
  assert.ok(
    result.qrm.p10p90CoveragePercent >= 0 && result.qrm.p10p90CoveragePercent <= 100,
  );
  assert.ok(result.qrm.medianBandWidthPercent > 0);
  assert.ok(result.qrm.p50RuntimeMs >= 0);
  assert.ok(result.qrm.p95RuntimeMs >= result.qrm.p50RuntimeMs);
  assert.ok(result.qrm.configHash.length > 0);

  // Every experiment carries its baselines; a model with no baseline always
  // looks good.
  const names = result.baselines.map((baseline) => baseline.name).sort();
  assert.deepEqual(names, ['historical-unconditional', 'momentum-sign', 'zero-return']);
  const zero = result.baselines.find((baseline) => baseline.name === 'zero-return');
  assert.ok(zero.crps !== null && zero.crps >= 0);
  assert.equal(
    zero.directionBrier !== null,
    true,
    'the coin-flip baseline has a Brier score',
  );
  const momentum = result.baselines.find((baseline) => baseline.name === 'momentum-sign');
  assert.equal(momentum.crps, null, 'a sign baseline has no distribution to score');
  assert.ok(momentum.directionBrier !== null);

  // Chronological split, development first.
  assert.equal(
    result.split.developmentOrigins + result.split.holdoutOrigins,
    result.qrm.forecastOrigins,
  );
  assert.equal(result.split.developmentFraction, 0.7);
  assert.ok(result.split.developmentOrigins >= result.split.holdoutOrigins);

  // Scoring primitives.
  const distribution = {
    horizon: 10,
    terminalReturn: { p10: -0.05, p25: -0.02, p50: 0.01, p75: 0.04, p90: 0.07 },
    probabilityPositive: 0.6,
    mfe: { p10: 0, p25: 0.01, p50: 0.02, p75: 0.04, p90: 0.06 },
    mae: { p10: 0, p25: 0.01, p50: 0.02, p75: 0.04, p90: 0.06 },
    probabilityLoss5PercentBeforeGain5Percent: 0.3,
  };
  // A perfectly-centred observation scores better than a far one.
  const near = benchmark.quantileCrps(distribution, 0.01);
  const far = benchmark.quantileCrps(distribution, 0.5);
  assert.ok(near < far, `a closer outcome scores lower: ${near} vs ${far}`);
  assert.ok(near >= 0);
  assert.equal(benchmark.quantileCrps(distribution, Number.NaN), null);

  // Brier: a confident correct call beats a confident wrong one.
  assert.ok(benchmark.directionBrier(0.9, 0.05) < benchmark.directionBrier(0.9, -0.05));
  assert.equal(benchmark.directionBrier(0.5, 0.01), 0.25, 'a coin flip scores 0.25');
  assert.equal(benchmark.directionBrier(Number.NaN, 1), null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 8: Promotion gates keep QRM experimental until earned ---');
{
  const failing = benchmark.evaluatePromotionGates({
    holdout: {
      modelVersion: 'qrm-3.0.0',
      configHash: 'abc',
      forecastOrigins: 10,
      symbols: 1,
      crps: 0.5,
      directionBrier: 0.4,
      p10p90CoveragePercent: 40,
      medianBandWidthPercent: 5,
      decisions: 2,
      longDecisions: 2,
      shortDecisions: 0,
      medianEntryLocationLong: 0.9,
      medianEntryPenalty: 0.9,
      meanForwardReturnOfDecisions: -0.01,
      winRatePercent: 20,
      expectancyR: -0.01,
      expectancyCi95: null,
      p50RuntimeMs: 100,
      p95RuntimeMs: 200,
      warnings: [],
    },
    baselines: [{ name: 'historical-unconditional', crps: 0.2, directionBrier: 0.24 }],
    leakageTestsPassed: true,
    reproducibilityTestsPassed: true,
    regimesRepresented: 1,
    runtimeP95MsPerSymbol: 900,
  });
  assert.equal(failing.promotable, false, 'a weak result is not promotable');
  assert.ok(failing.gates.length >= 13, 'every gate is reported');
  assert.ok(failing.gates.some((gate) => !gate.passed && /origins/.test(gate.gate)));
  assert.ok(failing.gates.some((gate) => !gate.passed && /coverage/.test(gate.gate)));
  assert.ok(failing.gates.some((gate) => !gate.passed && /CRPS/.test(gate.gate)));
  for (const gate of failing.gates) {
    assert.ok(gate.detail.length > 0, `${gate.gate} has no detail`);
  }

  const strong = {
    modelVersion: 'qrm-3.0.0',
    configHash: 'abc',
    forecastOrigins: 1_500,
    symbols: 30,
    crps: 0.18,
    directionBrier: 0.22,
    p10p90CoveragePercent: 80,
    medianBandWidthPercent: 6,
    decisions: 150,
    longDecisions: 100,
    shortDecisions: 50,
    medianEntryLocationLong: 0.4,
    medianEntryPenalty: 0.45,
    meanForwardReturnOfDecisions: 0.01,
    winRatePercent: 56,
    expectancyR: 0.012,
    expectancyCi95: { lower: 0.002, upper: 0.02 },
    p50RuntimeMs: 800,
    p95RuntimeMs: 1_800,
    warnings: [],
  };
  const passing = benchmark.evaluatePromotionGates({
    holdout: strong,
    baselines: [{ name: 'historical-unconditional', crps: 0.2, directionBrier: 0.24 }],
    leakageTestsPassed: true,
    reproducibilityTestsPassed: true,
    regimesRepresented: 4,
    runtimeP95MsPerSymbol: 2_000,
  });
  assert.equal(passing.promotable, true, `expected promotable: ${JSON.stringify(passing.gates.filter((g) => !g.passed))}`);

  // A leakage failure alone blocks promotion, whatever the statistics say.
  const leaked = benchmark.evaluatePromotionGates({
    holdout: strong,
    baselines: [{ name: 'historical-unconditional', crps: 0.2, directionBrier: 0.24 }],
    leakageTestsPassed: false,
    reproducibilityTestsPassed: true,
    regimesRepresented: 4,
    runtimeP95MsPerSymbol: 2_000,
  });
  assert.equal(leaked.promotable, false, 'leakage is disqualifying on its own');

  // Runtime is a product gate: failing it blocks promotion without touching a
  // statistical threshold.
  const slow = benchmark.evaluatePromotionGates({
    holdout: strong,
    baselines: [{ name: 'historical-unconditional', crps: 0.2, directionBrier: 0.24 }],
    leakageTestsPassed: true,
    reproducibilityTestsPassed: true,
    regimesRepresented: 4,
    runtimeP95MsPerSymbol: 9_000,
  });
  assert.equal(slow.promotable, false);
  assert.ok(slow.gates.some((gate) => !gate.passed && /runtime/i.test(gate.gate)));
  assert.equal(
    slow.gates.filter((gate) => !gate.passed).length,
    1,
    'only the runtime gate fails; no statistical gate was weakened',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 9: Service persistence and inline fallback ---');
{
  service.setQrmRoot(path.join(tmp, 'qrm-store'));
  service.setQrmWorkerScript(null); // inline path, no worker bundle in tests

  const outcome = await service.runQrm(
    { symbol: 'test', mode: 'discovery', configOverride: { paths: 80, analoguePoolSize: 40, targetEss: 20, minEss: 10, seed: 99 } },
    undefined,
    {
      history: async () => ASSET,
      benchmark: async () => SPY,
    },
  );
  assert.equal(outcome.status, 'ready', outcome.reason);
  assert.ok(outcome.snapshot);
  assert.equal(outcome.snapshot.symbol, 'TEST');

  // The neutral research view says experimental in every label.
  assert.ok(outcome.view);
  assert.equal(outcome.view.modelId, 'qrm-3');
  assert.ok(/experimental/i.test(outcome.view.reliabilityLabel));
  assert.ok(/experimental/i.test(outcome.view.decisionLabel));

  // Only successful snapshots are stored, and they round trip.
  const listed = service.listQrmSnapshots('TEST');
  assert.equal(listed.length, 1);
  const reloaded = service.readQrmSnapshot('TEST', outcome.snapshot.id);
  assert.ok(reloaded);
  assert.equal(reloaded.id, outcome.snapshot.id);
  assert.deepEqual(reloaded.distributions, outcome.snapshot.distributions);
  assert.equal(service.readQrmSnapshot('TEST', 'does-not-exist'), null);
  assert.deepEqual(service.listQrmSnapshots('NOTHING'), []);

  // Insufficient history is reported, never worked around.
  const thin = await service.runQrm(
    { symbol: 'THIN', mode: 'research' },
    undefined,
    { history: async () => ASSET.slice(0, 100), benchmark: async () => SPY },
  );
  assert.equal(thin.status, 'unavailable');
  assert.ok(/756/.test(thin.reason), thin.reason);
  assert.equal(thin.snapshot, null);
  assert.equal(thin.view, null);
  assert.deepEqual(service.listQrmSnapshots('THIN'), [], 'a failed job stores nothing');

  // Progress is forwarded.
  const progress = [];
  await service.runQrm(
    { symbol: 'TEST', mode: 'discovery', configOverride: { paths: 100, analoguePoolSize: 40, targetEss: 20, minEss: 10, seed: 5 } },
    (event) => progress.push(event),
    { history: async () => ASSET, benchmark: async () => SPY },
  );
  assert.ok(progress.length > 0, 'progress events reach the caller');
  assert.equal(progress[0].symbol, 'TEST');

  // Retention prunes old forecasts.
  const stored = path.join(tmp, 'qrm-store', 'qrm-v3', 'forecasts', 'TEST');
  const files = fs.readdirSync(stored);
  assert.ok(files.length >= 1);
  for (const name of files) {
    const full = path.join(stored, name);
    fs.utimesSync(full, new Date('2020-01-01'), new Date('2020-01-01'));
  }
  assert.ok(service.pruneQrmForecasts(30) >= 1, 'stale forecasts are pruned');
  assert.deepEqual(service.listQrmSnapshots('TEST'), []);

  await service.shutdownQrmPool();
  service.setQrmRoot(null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll QRM tests passed successfully!');
