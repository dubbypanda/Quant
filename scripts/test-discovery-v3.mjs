// Discovery engine tests (docs/quant-v3/04, Tasks 1, 3, 4, 5, 6, 7).
//
// Entirely offline: history, universe and snapshots are all injected.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-discovery-test-${process.pid}`);
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

const bundle = path.join(tmp, 'discovery-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as contracts from './src/shared/discovery';",
      "export * as features from './src/shared/discoveryFeatures';",
      "export * as ranking from './src/shared/discoveryRanking';",
      "export * as novelty from './src/shared/discoveryNovelty';",
      "export * as relevance from './src/shared/personalRelevance';",
      "export * as scan from './src/main/services/discoveryDeepScan';",
      "export * as historyStore from './src/main/services/discoveryHistoryStore';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'discovery-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { contracts, features, ranking, novelty, relevance, scan, historyStore } =
  await import(bundle);

const DAY = 86_400;
const NOW = Date.UTC(2026, 8, 15, 20, 0, 0);
const T0 = Math.floor(NOW / 1000) - 400 * DAY;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic daily candles ending at "today". */
function series({ count = 300, start = 100, drift = 0, noise = 0.008, volume = 2_000_000, seed = 7 } = {}) {
  const prng = mulberry32(seed);
  const candles = [];
  let price = start;
  const firstTime = Math.floor(NOW / 1000) - (count - 1) * DAY;
  for (let i = 0; i < count; i++) {
    price *= 1 + drift + (prng() - 0.5) * 2 * noise;
    const open = price * (1 - 0.001);
    candles.push({
      time: firstTime + i * DAY,
      open,
      high: Math.max(open, price) * 1.004,
      low: Math.min(open, price) * 0.996,
      close: price,
      volume,
    });
  }
  return candles;
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Eligibility explains every rejection ---');
{
  const member = {
    symbol: 'NVDA',
    name: 'NVIDIA',
    assetType: 'stock',
    exchange: 'NASDAQ',
    active: true,
  };
  const base = {
    member,
    lastClose: 150,
    medianDollarVolume20: 50_000_000,
    historyBars: 300,
  };

  const ok = contracts.evaluateDiscoveryEligibility(base);
  assert.equal(ok.eligible, true);
  assert.deepEqual(ok.reasons, []);
  assert.equal(ok.lowLiquidity, false);

  const cheap = contracts.evaluateDiscoveryEligibility({ ...base, lastClose: 1 });
  assert.equal(cheap.eligible, false);
  assert.ok(cheap.reasons.some((reason) => /Price below/.test(reason)));

  const short = contracts.evaluateDiscoveryEligibility({ ...base, historyBars: 50 });
  assert.equal(short.eligible, false);
  assert.ok(short.reasons.some((reason) => /50 daily bars/.test(reason)));

  const thin = contracts.evaluateDiscoveryEligibility({ ...base, medianDollarVolume20: 100_000 });
  assert.equal(thin.eligible, false);
  assert.ok(thin.reasons.some((reason) => /dollar volume/.test(reason)));

  // Relaxing the floor admits the thin name but still flags it: relaxing a
  // threshold reveals thin names, it does not make them liquid.
  const relaxed = contracts.evaluateDiscoveryEligibility({
    ...base,
    medianDollarVolume20: 100_000,
    settings: { ...contracts.DEFAULT_ELIGIBILITY_SETTINGS, minimumMedianDollarVolume20: 50_000 },
  });
  assert.equal(relaxed.eligible, true);
  assert.equal(relaxed.lowLiquidity, true, 'still flagged as thin');

  const inactive = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, active: false },
  });
  assert.equal(inactive.eligible, false);

  // Leveraged/inverse/single-stock exclusion is metadata, never a name guess.
  // A ticker that looks leveraged but carries no metadata passes.
  const looksLeveraged = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, symbol: 'TQQQ', assetType: 'etf' },
  });
  assert.equal(
    looksLeveraged.eligible,
    true,
    'a leveraged-looking ticker without metadata is not excluded by name',
  );
  const flaggedLeveraged = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, assetType: 'etf', leveraged: true },
  });
  assert.equal(flaggedLeveraged.eligible, false);
  assert.ok(flaggedLeveraged.reasons.some((reason) => /Leveraged/.test(reason)));
  const flaggedInverse = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, assetType: 'etf', inverse: true },
  });
  assert.equal(flaggedInverse.eligible, false);
  const flaggedSingle = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, assetType: 'etf', singleStockEtf: true },
  });
  assert.equal(flaggedSingle.eligible, false);

  const etfsOff = contracts.evaluateDiscoveryEligibility({
    ...base,
    member: { ...member, assetType: 'etf' },
    settings: { ...contracts.DEFAULT_ELIGIBILITY_SETTINGS, includeEtfs: false },
  });
  assert.equal(etfsOff.eligible, false);
  assert.equal(
    contracts.evaluateDiscoveryEligibility({ ...base, lastClose: null }).eligible,
    false,
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Robust z-scores and beta-adjusted residuals ---');
{
  // Median/MAD standardisation, not mean/stdev: the outlier we are detecting
  // must not inflate its own denominator.
  const baseline = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  assert.equal(features.robustZScore(1, baseline), 0, 'at the median, z is 0');
  const spikedBaseline = [...baseline, 50];
  const z = features.robustZScore(50, spikedBaseline);
  assert.ok(z > 10, `a lone spike stays a large z-score, got ${z}`);

  assert.equal(features.robustZScore(5, [1, 2]), null, 'too few observations');
  assert.equal(features.robustZScore(null, baseline), null);
  assert.equal(features.robustZScore(Number.NaN, baseline), null);

  // Beta: a series that is exactly 2x the benchmark has beta 2.
  const benchmark = series({ count: 200, seed: 11, noise: 0.01 });
  const doubled = benchmark.map((candle, index) => {
    if (index === 0) return { ...candle };
    const benchReturn = benchmark[index].close / benchmark[index - 1].close - 1;
    return { ...candle, close: 0, high: 0, low: 0, open: 0, volumePlaceholder: benchReturn };
  });
  // Rebuild a true 2x-beta series by compounding twice the benchmark return.
  const levered = [];
  let price = 100;
  for (let i = 0; i < benchmark.length; i++) {
    if (i > 0) {
      const benchReturn = benchmark[i].close / benchmark[i - 1].close - 1;
      price *= 1 + 2 * benchReturn;
    }
    levered.push({
      time: benchmark[i].time,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1_000_000,
    });
  }
  assert.equal(doubled.length, benchmark.length);

  const beta = features.estimateBeta(levered, benchmark);
  assert.ok(beta, 'beta is estimable from 200 overlapping days');
  assert.ok(Math.abs(beta.beta - 2) < 0.05, `expected beta near 2, got ${beta.beta}`);
  assert.ok(beta.observations >= 40);

  // A 2x-beta series moving exactly 2x the market has ~no residual: subtracting
  // the raw benchmark return instead of beta*return would report a large one.
  const residual = features.residualReturn(levered, benchmark, 20);
  assert.ok(residual !== null);
  assert.ok(
    Math.abs(residual) < 3,
    `a pure beta move should leave little residual, got ${residual}`,
  );

  // Inadequate overlap produces no regression result at all.
  assert.equal(features.estimateBeta(levered.slice(-10), benchmark), null);
  assert.equal(features.residualReturn(levered.slice(-10), benchmark, 20), null);
  assert.equal(features.residualReturn(levered, [], 20), null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Feature vector shape and fields ---');
{
  const benchmark = series({ count: 300, seed: 3 });
  const computed = features.computeDiscoveryFeatures({
    symbol: 'aaa',
    candles: series({ count: 300, drift: 0.0015, seed: 5 }),
    benchmark,
    priorRegime: 'range-bound',
  });
  assert.ok(computed);
  assert.equal(computed.symbol, 'AAA', 'symbols are normalized');
  assert.equal(computed.priorRegime, 'range-bound');
  for (const field of [
    'return1',
    'return5',
    'return20',
    'return63',
    'return126',
    'realizedVol20',
    'atrPercent14',
    'volumeRatio20',
    'dollarVolumeMedian20',
    'distanceMa20Atr',
    'distanceMa50Atr',
    'distanceMa200Percent',
    'distance52wHighPercent',
    'returnZ20',
    'volumeZ60',
    'volatilityRatio20To60',
  ]) {
    assert.ok(field in computed, `missing ${field}`);
  }
  assert.ok(computed.realizedVol20 > 0);
  assert.ok(computed.dollarVolumeMedian20 > 0);
  assert.equal(
    computed.relativeStrengthPercentile126,
    null,
    'relative strength is cross-sectional and filled in by the ranking pass',
  );
  assert.ok(typeof computed.regime === 'string');

  // Too little history yields null rather than a partially-filled vector.
  assert.equal(
    features.computeDiscoveryFeatures({ symbol: 'AAA', candles: series({ count: 10 }) }),
    null,
  );
  // No benchmark: residuals are null, everything else still computes.
  const noBench = features.computeDiscoveryFeatures({
    symbol: 'AAA',
    candles: series({ count: 300 }),
  });
  assert.equal(noBench.spyResidual20, null);
  assert.equal(noBench.sectorResidual20, null);
  assert.ok(noBench.return20 !== null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Percentile ranking, ties, and stale exclusion ---');
{
  const ranks = ranking.percentileRank([
    { symbol: 'A', value: 1 },
    { symbol: 'B', value: 2 },
    { symbol: 'C', value: 3 },
  ]);
  assert.equal(ranks.get('A'), 0);
  assert.equal(ranks.get('C'), 100);
  assert.equal(ranks.get('B'), 50);

  // Ties share an average rank, deterministically.
  const tied = ranking.percentileRank([
    { symbol: 'A', value: 5 },
    { symbol: 'B', value: 5 },
    { symbol: 'C', value: 9 },
  ]);
  assert.equal(tied.get('A'), tied.get('B'), 'tied values share a percentile');
  assert.equal(tied.get('C'), 100);
  // Reversing the input order must not change any score.
  const reversed = ranking.percentileRank([
    { symbol: 'C', value: 9 },
    { symbol: 'B', value: 5 },
    { symbol: 'A', value: 5 },
  ]);
  assert.equal(reversed.get('A'), tied.get('A'));
  assert.equal(reversed.get('C'), tied.get('C'));

  // Nulls stay null and do not occupy a rank.
  const withNulls = ranking.percentileRank([
    { symbol: 'A', value: 1 },
    { symbol: 'B', value: null },
    { symbol: 'C', value: 3 },
  ]);
  assert.equal(withNulls.get('B'), null);
  assert.equal(withNulls.get('A'), 0);
  assert.equal(withNulls.get('C'), 100);
  assert.deepEqual([...ranking.percentileRank([]).keys()], []);
  assert.equal(ranking.percentileRank([{ symbol: 'A', value: 4 }]).get('A'), 50);

  // A stale row is not ranked against current rows: it would win or lose on
  // the calendar rather than on the data.
  const makeRow = (symbol, return126, dataAgeSeconds) => ({
    symbol,
    dataAgeSeconds,
    features: { symbol, return126, asOf: 0, regime: 'range-bound', priorRegime: null },
  });
  const assigned = ranking.assignRelativeStrengthPercentiles([
    makeRow('FRESH1', 10, 3600),
    makeRow('FRESH2', 40, 3600),
    makeRow('STALE', 999, 10 * DAY),
  ]);
  const bySymbol = Object.fromEntries(
    assigned.map((row) => [row.symbol, row.features.relativeStrengthPercentile126]),
  );
  assert.equal(bySymbol.STALE, null, 'a stale row gets no current-session percentile');
  assert.equal(bySymbol.FRESH1, 0);
  assert.equal(bySymbol.FRESH2, 100, 'the stale leader does not displace current rows');
  assert.equal(ranking.isCurrentSession(makeRow('X', 1, 3600)), true);
  assert.equal(ranking.isCurrentSession(makeRow('X', 1, 10 * DAY)), false);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Attention groups are capped, not additive ---');
{
  const feature = (overrides = {}) => ({
    symbol: 'AAA',
    asOf: Math.floor(NOW / 1000),
    return1: 1,
    return5: 3,
    return20: 12,
    return63: 20,
    return126: 30,
    realizedVol20: 25,
    atrPercent14: 2,
    volumeRatio20: 1.2,
    dollarVolumeMedian20: 40_000_000,
    distanceMa20Atr: 1,
    distanceMa50Atr: 2,
    distanceMa200Percent: 15,
    distance52wHighPercent: 5,
    returnZ20: 1,
    volumeZ60: 0.5,
    volatilityRatio20To60: 1,
    spyResidual5: 1,
    spyResidual20: 2,
    sectorResidual5: 1,
    sectorResidual20: 2,
    relativeStrengthPercentile126: 50,
    regime: 'trending-up',
    priorRegime: 'trending-up',
    ...overrides,
  });

  // The same move expressed three ways must not pay three times: abnormalMove
  // takes the maximum of its measures and is capped at 20.
  const oneMeasure = ranking.abnormalMoveScore(feature({ returnZ20: 9, spyResidual20: null, sectorResidual20: null, spyResidual5: null }));
  const threeMeasures = ranking.abnormalMoveScore(
    feature({ returnZ20: 9, spyResidual20: 60, sectorResidual20: 60, spyResidual5: 40 }),
  );
  assert.equal(oneMeasure, 20, 'a single saturating measure reaches the cap');
  assert.equal(
    threeMeasures,
    20,
    'three correlated views of one move still cap at 20, not 60',
  );
  assert.equal(ranking.abnormalMoveScore(feature({ returnZ20: null, spyResidual20: null, sectorResidual20: null, spyResidual5: null })), 0);

  // Both tails are interesting for abnormality.
  assert.ok(ranking.abnormalMoveScore(feature({ returnZ20: -4 })) > 10, 'a large fall is abnormal too');

  // Participation is weighted by liquidity: a thin name doubling tiny volume
  // is not news.
  const liquid = ranking.participationScore(feature({ volumeZ60: 4, dollarVolumeMedian20: 500_000_000 }));
  const thin = ranking.participationScore(feature({ volumeZ60: 4, dollarVolumeMedian20: 200_000 }));
  assert.ok(liquid > thin, `liquidity should weight participation: ${liquid} vs ${thin}`);
  assert.ok(liquid <= 15 && thin >= 0);

  // Structural change rewards a regime transition.
  const changed = ranking.structuralChangeScore(feature({ priorRegime: 'range-bound', regime: 'trending-up' }));
  const unchanged = ranking.structuralChangeScore(feature({ priorRegime: 'trending-up', regime: 'trending-up' }));
  assert.ok(changed > unchanged, 'a regime change is structural news');
  assert.ok(changed <= 15);

  // Model evidence is zero without a candidate, capped at 15, and never infers
  // the sign of a null CI.
  assert.equal(ranking.modelEvidenceScore({ decision: null }), 0);
  assert.equal(ranking.modelEvidenceScore({ decision: 'wait' }), 0);
  assert.equal(ranking.modelEvidenceScore({ decision: 'buy-candidate' }), 2, 'candidate, no evidence');
  assert.equal(
    ranking.modelEvidenceScore({
      decision: 'buy-candidate',
      historical: { status: 'ready', evidenceStrength: 'thin', expectancyR: 0.4, expectancyCi95: null },
    }),
    5,
  );
  assert.equal(
    ranking.modelEvidenceScore({
      decision: 'buy-candidate',
      historical: { status: 'ready', evidenceStrength: 'large-sample', expectancyR: 0.4, expectancyCi95: null },
    }),
    12,
    'a null CI is not read as positive',
  );
  assert.equal(
    ranking.modelEvidenceScore({
      decision: 'buy-candidate',
      historical: {
        status: 'ready',
        evidenceStrength: 'large-sample',
        expectancyR: 0.4,
        expectancyCi95: { lower: 0.1, upper: 0.7 },
      },
    }),
    15,
  );
  assert.ok(
    ranking.modelEvidenceScore({
      decision: 'buy-candidate',
      historical: {
        status: 'ready',
        evidenceStrength: 'large-sample',
        expectancyR: 5,
        expectancyCi95: { lower: 4, upper: 6 },
      },
    }) <= 15,
    'a backtest cannot dominate market evidence',
  );

  // Stale data is the heaviest penalty.
  const fresh = ranking.qualityPenalty({ dataAgeSeconds: 3600, lowLiquidity: false, historyBars: 300, minimumHistoryBars: 140 });
  const stale = ranking.qualityPenalty({ dataAgeSeconds: 10 * DAY, lowLiquidity: false, historyBars: 300, minimumHistoryBars: 140 });
  assert.equal(fresh, 0);
  assert.ok(stale > 10, `stale data is heavily penalised, got ${stale}`);
  assert.ok(stale <= 30);

  // The score is bounded and the penalty really subtracts.
  const maxed = contracts.attentionScore({
    abnormalMove: 20,
    participation: 15,
    relativeStrength: 15,
    structuralChange: 15,
    modelEvidence: 15,
    novelty: 10,
    personalRelevance: 10,
    qualityPenalty: 0,
  });
  assert.equal(maxed, 100);
  assert.equal(
    contracts.attentionScore({
      abnormalMove: 999,
      participation: 999,
      relativeStrength: 999,
      structuralChange: 999,
      modelEvidence: 999,
      novelty: 999,
      personalRelevance: 999,
      qualityPenalty: 0,
    }),
    100,
    'no component can exceed its cap',
  );
  const penalised = contracts.attentionScore({
    ...contracts.emptyAttentionComponents(),
    abnormalMove: 20,
    qualityPenalty: 30,
  });
  assert.equal(penalised, 0, 'the penalty subtracts and the floor is 0');

  // The label is Attention, never Confidence.
  assert.equal(contracts.ATTENTION_LABEL, 'Attention');
  assert.ok(!/confidence/i.test(contracts.ATTENTION_CAPTION));
  assert.ok(/not a probability/i.test(contracts.ATTENTION_CAPTION));
  assert.equal(contracts.DISCOVERY_OUTPUT_LABEL, 'Research Candidate');
  assert.ok(!/all u\.s\./i.test(contracts.UNIVERSE_LABEL));

  // Why-now reasons are observations, not advice.
  const reasons = ranking.whyNowReasons(
    feature({ returnZ20: 3.2, volumeZ60: 2.5, priorRegime: 'range-bound' }),
    ranking.buildAttentionComponents({
      features: feature({ returnZ20: 3.2, volumeZ60: 2.5, priorRegime: 'range-bound' }),
      dataAgeSeconds: 3600,
      lowLiquidity: false,
      historyBars: 300,
      minimumHistoryBars: 140,
    }),
  );
  assert.ok(reasons.length <= 2, 'at most two reasons');
  assert.ok(reasons.length > 0);
  for (const reason of reasons) {
    assert.ok(!/\b(buy|sell|recommend)\b/i.test(reason), `"${reason}" reads as advice`);
  }
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Novelty measures change, not strength ---');
{
  const feature = (overrides = {}) => ({
    symbol: 'AAA',
    asOf: Math.floor(NOW / 1000),
    return20: 20,
    returnZ20: 3,
    volumeZ60: 3,
    relativeStrengthPercentile126: 90,
    regime: 'trending-up',
    priorRegime: null,
    ...overrides,
  });

  // No prior scan: 0 with an explanation, not a maximum. A first run must not
  // mark the whole universe as novel.
  const first = novelty.calculateNovelty({
    features: feature(),
    decision: 'buy-candidate',
    attentionRank: 1,
    prior: null,
    firstScan: true,
  });
  assert.equal(first.score, 0);
  assert.ok(/First scan/i.test(first.changes[0]));

  const priorEntry = {
    symbol: 'AAA',
    regime: 'trending-up',
    returnZ20: 3,
    volumeZ60: 3,
    relativeStrengthPercentile126: 90,
    decision: 'buy-candidate',
    attentionRank: 5,
  };

  // Strong but unchanged: zero novelty. This is the key property — a
  // persistently strong symbol loses novelty naturally.
  const unchanged = novelty.calculateNovelty({
    features: feature(),
    decision: 'buy-candidate',
    attentionRank: 5,
    prior: priorEntry,
  });
  assert.equal(unchanged.score, 0, 'unchanged strength is not novel');
  assert.deepEqual(unchanged.changes, []);

  // A regime change is novel even with identical readings.
  const regimeChanged = novelty.calculateNovelty({
    features: feature({ regime: 'high-volatility' }),
    decision: 'buy-candidate',
    attentionRank: 5,
    prior: priorEntry,
  });
  assert.ok(regimeChanged.score > 0);
  assert.ok(regimeChanged.changes.some((change) => /Regime changed/.test(change)));

  // A crossing scores; staying above the line does not.
  const crossed = novelty.calculateNovelty({
    features: feature({ returnZ20: 2.5 }),
    decision: 'buy-candidate',
    attentionRank: 5,
    prior: { ...priorEntry, returnZ20: 0.4 },
  });
  assert.ok(crossed.changes.some((change) => /z-score crossed/.test(change)));

  const volumeCrossed = novelty.calculateNovelty({
    features: feature({ volumeZ60: 2.6 }),
    decision: 'buy-candidate',
    attentionRank: 5,
    prior: { ...priorEntry, volumeZ60: 0.2 },
  });
  assert.ok(volumeCrossed.changes.some((change) => /unusually high/.test(change)));

  const rsJumped = novelty.calculateNovelty({
    features: feature({ relativeStrengthPercentile126: 88 }),
    decision: 'buy-candidate',
    attentionRank: 5,
    prior: { ...priorEntry, relativeStrengthPercentile126: 55 },
  });
  assert.ok(rsJumped.changes.some((change) => /Relative strength rose/.test(change)));

  // Entering the top 25 from outside the top 100 counts; 30th to 24th does not.
  const entered = novelty.calculateNovelty({
    features: feature(),
    decision: 'buy-candidate',
    attentionRank: 12,
    prior: { ...priorEntry, attentionRank: 400 },
  });
  assert.ok(entered.changes.some((change) => /top 25/.test(change)));
  const nudged = novelty.calculateNovelty({
    features: feature(),
    decision: 'buy-candidate',
    attentionRank: 24,
    prior: { ...priorEntry, attentionRank: 30 },
  });
  assert.ok(!nudged.changes.some((change) => /top 25/.test(change)));

  const decisionChanged = novelty.calculateNovelty({
    features: feature(),
    decision: 'short-candidate',
    attentionRank: 5,
    prior: priorEntry,
  });
  assert.ok(decisionChanged.changes.some((change) => /decision changed/.test(change)));

  // Bounded at 10 even when everything changes at once.
  const everything = novelty.calculateNovelty({
    features: feature({ regime: 'high-volatility', returnZ20: 3, volumeZ60: 3, relativeStrengthPercentile126: 95 }),
    decision: 'short-candidate',
    attentionRank: 1,
    prior: {
      ...priorEntry,
      regime: 'range-bound',
      returnZ20: 0,
      volumeZ60: 0,
      relativeStrengthPercentile126: 30,
      decision: 'buy-candidate',
      attentionRank: 500,
    },
  });
  assert.equal(everything.score, novelty.NOVELTY_MAX);

  const entry = novelty.toSnapshotEntry({
    features: feature(),
    decision: 'buy-candidate',
    attentionRank: 3,
  });
  assert.equal(entry.symbol, 'AAA');
  assert.equal(entry.attentionRank, 3);
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: Personal relevance answers "why me", not "should I buy" ---');
{
  const owned = relevance.calculatePersonalRelevance({
    symbol: 'NVDA',
    ownedWeightPercent: 12,
    indirectWeightPercent: 3,
    correlationToPortfolio: 0.8,
    sector: 'Technology',
    concentratedSectors: ['Technology'],
    upcomingEventTitle: 'Earnings in 2 days',
  });
  assert.equal(owned.score, relevance.PERSONAL_RELEVANCE_MAX, 'bounded at 10');
  assert.ok(owned.reasons.some((reason) => reason.kind === 'owned'));
  assert.ok(owned.reasons.some((reason) => reason.kind === 'correlated'));
  assert.ok(owned.reasons.some((reason) => reason.kind === 'sector'));
  assert.ok(owned.reasons.some((reason) => reason.kind === 'event'));

  const none = relevance.calculatePersonalRelevance({
    symbol: 'AAA',
    ownedWeightPercent: null,
    indirectWeightPercent: null,
    correlationToPortfolio: null,
    sector: null,
  });
  assert.equal(none.score, 0);
  assert.deepEqual(none.reasons, []);

  // Low correlation is described, never praised as "good diversification".
  const diversifier = relevance.calculatePersonalRelevance({
    symbol: 'GLD',
    ownedWeightPercent: null,
    indirectWeightPercent: null,
    correlationToPortfolio: 0.05,
    sector: null,
  });
  const text = diversifier.reasons.map((reason) => reason.text).join(' ');
  assert.ok(/low observed correlation/i.test(text), text);
  assert.ok(!/good diversification/i.test(text), 'must not editorialise');
  assert.ok(!/should/i.test(text));
}

// ---------------------------------------------------------------------------
console.log('--- Test 8: A full run reports honest coverage and dedupes work ---');
{
  scan.resetDiscoveryStateForTests();

  const universe = [
    { symbol: 'AAA', name: 'Alpha', assetType: 'stock', exchange: 'NASDAQ', active: true, sector: 'Technology' },
    { symbol: 'BBB', name: 'Beta', assetType: 'stock', exchange: 'NYSE', active: true },
    { symbol: 'CCC', name: 'Gamma', assetType: 'stock', exchange: 'NYSE', active: true },
    { symbol: 'THIN', name: 'Thin', assetType: 'stock', exchange: 'NYSE', active: true },
    { symbol: 'LEV', name: 'Levered', assetType: 'etf', exchange: 'NYSEArca', active: true, leveraged: true },
    { symbol: 'NOHYD', name: 'Unhydrated', assetType: 'stock', exchange: 'NYSE', active: true },
  ];
  const histories = {
    SPY: series({ count: 300, seed: 1 }),
    XLK: series({ count: 300, seed: 2 }),
    AAA: series({ count: 300, drift: 0.002, seed: 21 }),
    BBB: series({ count: 300, drift: -0.001, seed: 22 }),
    CCC: series({ count: 300, seed: 23 }),
    // Thin: real bars, tiny dollar volume, so it fails the liquidity floor.
    THIN: series({ count: 300, seed: 24, volume: 500, start: 4 }),
    LEV: series({ count: 300, seed: 25 }),
    NOHYD: series({ count: 300, seed: 26 }),
  };

  let loads = 0;
  const historyLoader = async (symbol) => {
    loads += 1;
    const candles = histories[symbol];
    if (!candles) return { candles: [], source: 'sample' };
    return { candles, source: 'live' };
  };

  const snapshots = [];
  const result = await scan.runDiscovery({
    universeLoader: () => universe,
    // NOHYD is in the universe but never hydrated, so it is not scanned.
    hydratedLoader: () => ['AAA', 'BBB', 'CCC', 'THIN', 'LEV'],
    historyLoader,
    snapshotLoader: () => null,
    snapshotWriter: (snapshot) => snapshots.push(snapshot),
    now: NOW,
  });

  assert.equal(result.coverage.universeCount, 6);
  assert.equal(result.coverage.hydratedCount, 5);
  assert.equal(result.coverage.scannedCount, 5, 'only hydrated symbols are scanned');
  // THIN fails liquidity and LEV is excluded by metadata, so three remain.
  assert.equal(result.coverage.eligibleCount, 3, 'the funnel is reported honestly');
  assert.equal(result.coverage.currentSessionCount, 3);
  assert.equal(result.coverage.staleCount, 0);
  assert.ok(result.coverage.asOf);

  const symbols = result.candidates.map((candidate) => candidate.symbol).sort();
  assert.deepEqual(symbols, ['AAA', 'BBB', 'CCC']);
  assert.ok(!symbols.includes('NOHYD'), 'an unhydrated symbol cannot appear');
  assert.ok(!symbols.includes('LEV'), 'a leveraged fund is excluded by metadata');
  assert.ok(!symbols.includes('THIN'), 'an illiquid symbol is excluded by default');

  for (const candidate of result.candidates) {
    assert.ok(candidate.attentionScore >= 0 && candidate.attentionScore <= 100);
    assert.ok(candidate.features.relativeStrengthPercentile126 !== undefined);
    assert.ok(candidate.novelty, 'every candidate has a novelty result');
    assert.ok(candidate.asOf);
    assert.ok(candidate.dataAgeSeconds >= 0);
    // Signal fields come from the deterministic core in Stage B.
    assert.ok(candidate.decision !== undefined);
  }

  // Sorted by attention, descending.
  const scores = result.candidates.map((candidate) => candidate.attentionScore);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));

  // A snapshot was persisted for the next run's novelty comparison.
  assert.equal(snapshots.length, 1);
  assert.equal(Object.keys(snapshots[0].entries).length, 3);
  assert.ok(snapshots[0].entries.AAA.attentionRank >= 1);

  // A second run while one is active returns the SAME promise rather than
  // launching duplicate full-universe computation.
  scan.resetDiscoveryStateForTests();
  const loadsBefore = loads;
  const first = scan.runDiscovery({
    universeLoader: () => universe,
    hydratedLoader: () => ['AAA', 'BBB', 'CCC'],
    historyLoader,
    snapshotLoader: () => null,
    snapshotWriter: () => {},
    now: NOW,
  });
  const second = scan.runDiscovery({
    universeLoader: () => universe,
    hydratedLoader: () => ['AAA', 'BBB', 'CCC'],
    historyLoader,
    snapshotLoader: () => null,
    snapshotWriter: () => {},
    now: NOW,
  });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.id, b.id, 'a concurrent request joins the active run');
  const loadsAfter = loads;
  assert.ok(
    loadsAfter - loadsBefore <= 6,
    `history was loaded once, not twice: ${loadsAfter - loadsBefore} loads`,
  );

  // Novelty against a prior snapshot: a regime change is detected.
  scan.resetDiscoveryStateForTests();
  const withPrior = await scan.runDiscovery({
    universeLoader: () => universe,
    hydratedLoader: () => ['AAA'],
    historyLoader,
    snapshotLoader: () => ({
      id: 'prior',
      completedAt: new Date(NOW - DAY * 1000).toISOString(),
      entries: {
        AAA: {
          symbol: 'AAA',
          regime: 'high-volatility',
          returnZ20: 0,
          volumeZ60: 0,
          relativeStrengthPercentile126: 10,
          decision: 'wait',
          attentionRank: 900,
        },
      },
    }),
    snapshotWriter: () => {},
    now: NOW,
  });
  const aaa = withPrior.candidates.find((candidate) => candidate.symbol === 'AAA');
  assert.ok(aaa.novelty.score > 0, 'a changed prior state produces novelty');
  assert.ok(aaa.features.priorRegime === 'high-volatility');

  // Sample-sourced history is never ranked as if it were the market.
  scan.resetDiscoveryStateForTests();
  const sampleOnly = await scan.runDiscovery({
    universeLoader: () => universe,
    hydratedLoader: () => ['AAA'],
    historyLoader: async () => ({ candles: histories.AAA, source: 'sample' }),
    snapshotLoader: () => null,
    snapshotWriter: () => {},
    now: NOW,
  });
  assert.deepEqual(sampleOnly.candidates, [], 'sample data cannot become a candidate');
  assert.equal(sampleOnly.coverage.eligibleCount, 0);

  scan.resetDiscoveryStateForTests();
}

// ---------------------------------------------------------------------------
console.log('--- Test 9: Snapshot persistence and retention ---');
{
  historyStore.setDiscoveryHistoryRoot(path.join(tmp, 'discovery-root'));
  // The store appends its own directory name to the root, so the resolved path
  // is asked for rather than assumed.
  const dir = historyStore.discoveryHistoryDir();

  assert.equal(historyStore.getLatestDiscoverySnapshot(), null, 'no snapshot yet');

  const snapshot = {
    id: 'run-1',
    completedAt: '2026-09-15T19:00:00.000Z',
    entries: {
      AAA: {
        symbol: 'AAA',
        regime: 'trending-up',
        returnZ20: 2,
        volumeZ60: 1,
        relativeStrengthPercentile126: 80,
        decision: 'buy-candidate',
        attentionRank: 1,
      },
    },
  };
  historyStore.saveDiscoverySnapshot(snapshot);

  const latest = historyStore.getLatestDiscoverySnapshot();
  assert.equal(latest.id, 'run-1');
  assert.deepEqual(latest.entries.AAA, snapshot.entries.AAA);

  const listed = historyStore.listDiscoverySnapshots();
  assert.equal(listed.length, 1, 'a dated copy is kept alongside latest');
  assert.match(listed[0], /^2026-09-15T190000Z\.json\.gz$/);
  assert.equal(historyStore.snapshotFileName('2026-09-15T19:00:00.000Z'), '2026-09-15T190000Z.json.gz');

  // A corrupt snapshot is a missing baseline, not a crash.
  fs.writeFileSync(path.join(dir, 'latest.json.gz'), Buffer.from('not gzip'));
  assert.equal(historyStore.getLatestDiscoverySnapshot(), null);

  // Retention removes old files but never `latest`.
  historyStore.saveDiscoverySnapshot(snapshot);
  const oldFile = path.join(dir, '2020-01-01T120000Z.json.gz');
  fs.writeFileSync(oldFile, fs.readFileSync(path.join(dir, 'latest.json.gz')));
  fs.utimesSync(oldFile, new Date('2020-01-01'), new Date('2020-01-01'));
  const removed = historyStore.pruneDiscoveryHistory(30);
  assert.ok(removed >= 1, 'the old snapshot was pruned');
  assert.ok(!fs.existsSync(oldFile));
  assert.ok(historyStore.getLatestDiscoverySnapshot(), 'latest survives pruning');

  historyStore.setDiscoveryHistoryRoot(null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll discovery tests passed successfully!');
