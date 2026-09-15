// Unit tests for the unified signal model ported from the Quantactic iOS engine,
// plus regressions for the price-structure bugs the port exposed.
//
// Run: npm run test:unified

import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-unified-signal-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });

async function load(relativePath) {
  const name = path.basename(relativePath, '.ts');
  const outfile = path.join(tmp, `${name}.mjs`);
  await build({
    entryPoints: [path.join(root, relativePath)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile,
    logLevel: 'silent',
  });
  return import(outfile);
}

const [
  indicators,
  volumeProfile,
  signalFactors,
  unified,
  aggregator,
  prioritizer,
  resolver,
  qrm,
  qrmDecision,
  kronosDistribution,
  quant,
  priceStructure,
] = await Promise.all([
  load('src/shared/indicators.ts'),
  load('src/shared/volumeProfile.ts'),
  load('src/shared/signalFactors.ts'),
  load('src/shared/unifiedSignal.ts'),
  load('src/shared/signalEvidenceAggregator.ts'),
  load('src/shared/signalReasonPrioritizer.ts'),
  load('src/shared/unifiedSignalResolver.ts'),
  load('src/shared/qrm.ts'),
  load('src/shared/qrmDecision.ts'),
  load('src/shared/kronosDistribution.ts'),
  load('src/shared/quant.ts'),
  load('src/shared/priceStructure.ts'),
]);

const DAY = 86_400;
const T0 = 1_600_000_000;

function candle(index, { open, high, low, close, volume = 1_000_000 }) {
  return { time: T0 + index * DAY, open, high, low, close, volume };
}

/** A bar built around a close, with a small symmetric range. */
function bar(index, close, { volume = 1_000_000, spread = 0.4, open = null } = {}) {
  const o = open ?? close - 0.05;
  return candle(index, {
    open: o,
    high: Math.max(o, close) + spread / 2,
    low: Math.min(o, close) - spread / 2,
    close,
    volume,
  });
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Wilder ATR and RSI alignment and smoothing ---');
{
  // A flat series with a constant 1-wide range: every true range is exactly 1
  // (there is no gap to the prior close), so ATR must smooth to 1.
  const flatBars = [];
  for (let i = 0; i < 40; i++) {
    flatBars.push(candle(i, { open: 100, high: 100.5, low: 99.5, close: 100 }));
  }
  const flatAtr = indicators.wilderAtr(flatBars, 14);
  assert.equal(flatAtr.length, flatBars.length, 'ATR series must align to the candle series');
  for (let i = 0; i < 14; i++) {
    assert.equal(flatAtr[i], null, `ATR must be null during warmup at ${i}`);
  }
  assert.ok(flatAtr[14] !== null, 'first ATR lands at index = period');
  assert.ok(Math.abs(flatAtr[39] - 1) < 1e-9, `constant true range of 1 smooths to 1, got ${flatAtr[39]}`);

  // True range is measured against the prior close, not just the bar's own
  // span: a series stepping up by 1 per bar has TR 1.5, not 1.
  const rising = [];
  for (let i = 0; i < 40; i++) {
    rising.push(candle(i, { open: 100 + i, high: 100.5 + i, low: 99.5 + i, close: 100 + i }));
  }
  assert.ok(
    Math.abs(indicators.wilderAtr(rising, 14)[39] - 1.5) < 1e-9,
    'true range includes the gap to the previous close',
  );
  assert.equal(
    indicators.trueRange(rising[10], rising[9].close),
    1.5,
    'trueRange is exposed and agrees with the series',
  );

  // Wilder RSI on a strictly rising series has no losses at all.
  const closes = rising.map((c) => c.close);
  const rsi = indicators.wilderRsi(closes, 14);
  assert.equal(rsi[13], null, 'RSI warmup is period bars');
  assert.equal(rsi[14], 100, 'a series with no losses reads 100');

  // A flat series carries no information; 50 says so, 100 would not.
  assert.equal(
    indicators.wilderRsi(new Array(30).fill(50), 14)[20],
    50,
    'a flat series reads 50, not 100',
  );

  // Wilder smoothing must NOT equal a simple mean of the same window after a
  // spike — this is the whole reason ATR thresholds are not interchangeable.
  const spiky = [];
  for (let i = 0; i < 40; i++) {
    const width = i === 30 ? 10 : 1;
    spiky.push(candle(i, { open: 100, high: 100 + width, low: 100, close: 100 }));
  }
  const wilder = indicators.wilderAtr(spiky, 14)[35];
  const simpleMean = spiky.slice(22, 36).reduce((sum, c) => sum + (c.high - c.low), 0) / 14;
  assert.ok(
    Math.abs(wilder - simpleMean) > 0.05,
    `Wilder ATR (${wilder}) must decay a spike differently from a simple mean (${simpleMean})`,
  );

  // MACD histogram is macd − signal, and the series align.
  const macdResult = indicators.macd(closes);
  assert.equal(macdResult.histogram.length, closes.length);
  assert.ok(
    Math.abs(
      macdResult.histogram[39] - (macdResult.macd[39] - macdResult.signal[39]),
    ) < 1e-12,
    'histogram is macd minus signal',
  );

  // Short series return all-null rather than throwing.
  assert.deepEqual(indicators.wilderAtr(rising.slice(0, 5), 14), new Array(5).fill(null));
  assert.deepEqual(indicators.wilderRsi([1, 2, 3], 14), [null, null, null]);
  assert.deepEqual(indicators.wilderAtr([], 14), []);
  assert.equal(indicators.sma([1, 2, 3], 5), null, 'sma declines a window it cannot fill');
  assert.equal(indicators.sma([1, 2, 3, 4], 2), 3.5, 'sma defaults to the end of the series');
  assert.equal(indicators.percentChange(0, 5), null, 'a zero base has no percent change');
  assert.equal(indicators.latest([null, 3, null]), 3, 'latest skips trailing nulls');
  assert.equal(indicators.latest([null, null]), null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Volume profile spreads volume across range, not onto the close ---');
{
  // Two clusters of bars. The heavier cluster must own the point of control even
  // though both clusters close at the same distance from the midpoint.
  const bars = [];
  for (let i = 0; i < 30; i++) {
    bars.push(candle(i, { open: 100, high: 101, low: 99, close: 100, volume: 5_000_000 }));
  }
  for (let i = 30; i < 60; i++) {
    bars.push(candle(i, { open: 110, high: 111, low: 109, close: 110, volume: 500_000 }));
  }
  const profile = volumeProfile.buildVolumeProfile(bars);
  assert.ok(profile, 'profile must build from 60 usable bars');
  assert.ok(
    profile.pointOfControl > 99 && profile.pointOfControl < 101,
    `POC must sit in the heavy cluster, got ${profile.pointOfControl}`,
  );
  assert.ok(profile.valueAreaLow <= profile.pointOfControl, 'VAL is at or below POC');
  assert.ok(profile.valueAreaHigh >= profile.pointOfControl, 'VAH is at or above POC');
  assert.ok(
    profile.valueAreaVolumeShare >= 0.7,
    `value area must enclose at least the configured share, got ${profile.valueAreaVolumeShare}`,
  );
  assert.equal(profile.isApproximation, true, 'bar-derived profiles are always approximations');

  // A wide bar must deposit volume in bins it never closed in.
  const wide = [];
  for (let i = 0; i < 25; i++) {
    wide.push(candle(i, { open: 100, high: 120, low: 100, close: 100, volume: 1_000_000 }));
  }
  const wideProfile = volumeProfile.buildVolumeProfile(wide);
  const binsAboveClose = wideProfile.bins.filter((b) => b.low > 105 && b.volume > 0);
  assert.ok(
    binsAboveClose.length > 0,
    'volume must be spread across the traded range, not dumped on the close',
  );

  // Too few bars, and zero-volume bars, must yield null rather than a fabricated profile.
  assert.equal(volumeProfile.buildVolumeProfile(bars.slice(0, 10)), null);
  assert.equal(
    volumeProfile.buildVolumeProfile(bars.map((c) => ({ ...c, volume: 0 }))),
    null,
    'a series with no volume cannot describe participation',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Acceptance requires holding a level, not printing through it ---');
{
  // A heavy, tight base cluster so the value area is pinned there and the few
  // bars appended below do not move it.
  const base = [];
  for (let i = 0; i < 58; i++) {
    base.push(candle(i, { open: 100, high: 101, low: 99, close: 100, volume: 5_000_000 }));
  }
  const atr = 1;
  const nowSeconds = T0 + 200 * DAY; // every bar is closed

  const measure = (candles, currentPrice, relativeVolume) =>
    volumeProfile.measurePriceAcceptance({ candles, currentPrice, atr, relativeVolume, nowSeconds });

  // One bar pokes above the value area and is the only close beyond it.
  const poke = measure([...base, bar(58, 103.5, { volume: 1_000_000 })], 103.5, 3);
  assert.ok(poke.valueAreaHigh < 103, `the value area stays in the base cluster, got ${poke.valueAreaHigh}`);
  assert.equal(
    poke.state,
    'rejected-above-value',
    `a single close beyond the boundary is not acceptance, got ${poke.state}`,
  );
  assert.equal(volumeProfile.confirmsUpsideBreakout(poke), false);
  assert.equal(poke.closesBeyondBoundary, 1, 'and the close count says why');

  // Two closes beyond, with distance and participation, is acceptance.
  const held = [
    ...base,
    bar(58, 103.5, { volume: 1_000_000 }),
    bar(59, 103.7, { volume: 1_000_000 }),
  ];
  const accepted = measure(held, 103.7, 3);
  assert.equal(accepted.state, 'accepted-above-value', `held above value, got ${accepted.state}`);
  assert.equal(volumeProfile.confirmsUpsideBreakout(accepted), true);
  assert.equal(accepted.closesBeyondBoundary, 2);
  assert.equal(accepted.isApproximation, true, 'never described as true volume-at-price');

  // Same geometry, no participation: acceptance needs all three conditions.
  assert.equal(
    measure(held, 103.7, 0.8).state,
    'rejected-above-value',
    'a move nobody traded is not acceptance',
  );

  // Same geometry, price resting on the boundary rather than clear of it.
  const resting = [
    ...base,
    bar(58, 101.02, { volume: 1_000_000, spread: 0.04 }),
    bar(59, 101.03, { volume: 1_000_000, spread: 0.04 }),
  ];
  const restingState = measure(resting, 101.03, 3).state;
  assert.notEqual(
    restingState,
    'accepted-above-value',
    `a level price is merely resting on is not accepted, got ${restingState}`,
  );

  // The mirror case below value.
  const brokeDown = [
    ...base,
    bar(58, 96.5, { volume: 1_000_000 }),
    bar(59, 96.3, { volume: 1_000_000 }),
  ];
  const destructive = measure(brokeDown, 96.3, 3);
  assert.equal(destructive.state, 'accepted-below-value', `held below value, got ${destructive.state}`);
  assert.equal(volumeProfile.isDestructiveAcceptance(destructive.state), true);
  assert.equal(volumeProfile.confirmsDownsideBreakdown(destructive), true);

  // Inside the value area is a magnet, not a direction.
  const inside = measure([...base, bar(58, 100.1, { volume: 1_000_000 })], 100.1, 1);
  assert.equal(volumeProfile.isTwoSidedAcceptance(inside.state), true, `got ${inside.state}`);

  // An unclosed final bar must not be counted toward acceptance.
  assert.equal(
    volumeProfile.completedCandles(held, held[held.length - 1].time - 10).length,
    held.length - 1,
    'an unclosed bar is dropped',
  );
  assert.equal(
    volumeProfile.completedCandles(held, held[held.length - 1].time + 2 * DAY).length,
    held.length,
    'a closed bar is kept',
  );
  assert.deepEqual(volumeProfile.completedCandles([], nowSeconds), []);

  // No profile at all is unavailable, never a directional reading.
  const thin = measure(base.slice(0, 5), 100, 1);
  assert.equal(thin.state, 'unavailable');
  assert.equal(volumeProfile.isMeasuredAcceptance(thin), false);
  assert.equal(thin.valueAreaHigh, null, 'no level is invented when none was measured');

  // A non-positive price cannot be positioned against anything.
  assert.equal(measure(base, 0, 1).state, 'unavailable');

  // Session grouping for intraday callers.
  const intraday = [];
  for (let day = 0; day < 4; day++) {
    for (let hour = 0; hour < 7; hour++) {
      intraday.push({
        time: T0 + day * DAY + hour * 3600,
        open: 100, high: 100.5, low: 99.5, close: 100, volume: 100_000,
      });
    }
  }
  assert.equal(volumeProfile.recentSessionBars(intraday, 2).length, 14, 'two sessions of hourly bars');
  assert.deepEqual(volumeProfile.recentSessionBars(intraday, 0), []);
  assert.deepEqual(volumeProfile.recentSessionBars([], 5), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Evidence states are relative to the setup, leans are not ---');
{
  const bearishFactors = [
    { kind: 'average-loss', text: '', weight: 0.12, positive: true },
    { kind: 'below-average', text: '', weight: 0.08, positive: true },
  ];
  const readings = { ...signalFactors.EMPTY_READINGS, rsi14: 30, movingAverage20: 100 };

  const underShort = aggregator.aggregateSignalEvidence('negative', {
    factors: bearishFactors,
    readings,
    acceptance: null,
    relative: null,
    marketPulseScore: null,
  });
  const trendShort = underShort.find((e) => e.category === 'trend');
  assert.equal(trendShort.lean, 'bearish', 'a lost average leans bearish for price');
  assert.equal(trendShort.state, 'supports', 'and that bearish lean SUPPORTS a short setup');
  assert.equal(
    trendShort.detail,
    'Trend has weakened',
    'the sentence describes price, so it reads correctly under a SELL',
  );

  const underLong = aggregator.aggregateSignalEvidence('positive', {
    factors: bearishFactors,
    readings,
    acceptance: null,
    relative: null,
    marketPulseScore: null,
  });
  const trendLong = underLong.find((e) => e.category === 'trend');
  assert.equal(trendLong.lean, 'bearish', 'the lean does not change with the conclusion');
  assert.equal(trendLong.state, 'weakens', 'but the state does');

  // Shape invariants: every directional category, exactly once, in canonical order.
  assert.deepEqual(
    underLong.map((e) => e.category),
    unified.DIRECTIONAL_EVIDENCE_CATEGORIES,
    'evidence list is the canonical directional categories in order',
  );
  assert.ok(
    !underLong.some((e) => e.category === 'risk-plan'),
    'the risk-plan gate is not a directional row',
  );

  // Absent inputs are unavailable, never a directional reading.
  for (const category of ['price-acceptance', 'relative-strength', 'market-context']) {
    const row = underLong.find((e) => e.category === category);
    assert.equal(row.availability, 'unavailable', `${category} without input is unavailable`);
    assert.equal(row.state, 'mixed', `${category} must not claim a direction it cannot measure`);
    assert.equal(row.detail, unified.EVIDENCE_UNAVAILABLE_DETAIL);
  }

  // A tight range has zero polarity, so it lands on "trend is unclear".
  const ranged = aggregator.aggregateSignalEvidence('neutral', {
    factors: [{ kind: 'range', text: '', weight: 0.14, positive: true }],
    readings,
    acceptance: null,
    relative: null,
    marketPulseScore: null,
  });
  const trendRange = ranged.find((e) => e.category === 'trend');
  assert.equal(trendRange.lean, 'mixed', 'a tight band is a setup condition, not a direction');
  assert.equal(trendRange.detail, 'Trend is unclear');

  // Relative strength inside a point of the benchmark is the same move.
  const sameMove = aggregator.aggregateSignalEvidence('positive', {
    factors: bearishFactors,
    readings,
    acceptance: null,
    relative: { symbol: 'AAA', symbolReturn: 10.4, benchmarkSymbol: 'SPY', benchmarkReturn: 10.0 },
    marketPulseScore: null,
  });
  assert.equal(
    sameMove.find((e) => e.category === 'relative-strength').lean,
    'mixed',
    'a 0.4% excess is not leadership',
  );

  // Market pulse bands.
  const bands = [
    [75, 'bullish'],
    [50, 'mixed'],
    [20, 'bearish'],
  ];
  for (const [score, expected] of bands) {
    const rows = aggregator.aggregateSignalEvidence('positive', {
      factors: bearishFactors,
      readings,
      acceptance: null,
      relative: null,
      marketPulseScore: score,
    });
    assert.equal(
      rows.find((e) => e.category === 'market-context').lean,
      expected,
      `pulse ${score} leans ${expected}`,
    );
  }

  // Every factor kind must reach a category — an invisible scored factor could
  // drive the conclusion while being absent from the list the user is told is
  // complete.
  const kinds = [
    'trend-alignment', 'yearly-high', 'average-reclaim', 'average-loss', 'above-average',
    'below-average', 'range', 'macd', 'rsi', 'momentum', 'price-move', 'volume',
  ];
  for (const kind of kinds) {
    const category = aggregator.evidenceCategoryFor(kind);
    assert.ok(
      unified.DIRECTIONAL_EVIDENCE_CATEGORIES.includes(category),
      `factor ${kind} must consolidate into a visible category, got ${category}`,
    );
  }
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: At most two reasons, chosen by what the conclusion needs ---');
{
  const row = (category, state, lean) => ({
    category,
    state,
    lean,
    availability: 'measured',
    detail: unified.CATEGORY_LEAN_SENTENCES[category][lean],
    advanced: [],
  });

  const mixedBag = [
    row('trend', 'supports', 'bullish'),
    row('momentum', 'supports', 'bullish'),
    row('volume', 'weakens', 'bearish'),
    row('price-acceptance', 'supports', 'bullish'),
    row('relative-strength', 'supports', 'bullish'),
    row('market-context', 'supports', 'bullish'),
  ];

  const buyReasons = prioritizer.prioritizeSignalReasons('buy', mixedBag);
  assert.equal(buyReasons.length, 2, 'never more than two reasons');
  assert.equal(
    buyReasons[0].category,
    'price-acceptance',
    'a decided conclusion leads with the highest-priority support',
  );
  assert.notEqual(
    buyReasons[0].category,
    'market-context',
    'market context is a contributor, never the headline',
  );

  const waitReasons = prioritizer.prioritizeSignalReasons('wait', mixedBag);
  assert.equal(
    waitReasons[0].category,
    'volume',
    'a wait must lead with what is missing, i.e. the conflict',
  );

  // A changed category outranks a statically stronger one.
  const changed = prioritizer.prioritizeSignalReasons(
    'buy',
    mixedBag,
    new Set(['relative-strength']),
  );
  assert.equal(changed[0].category, 'relative-strength', 'a change is the most useful thing to say');

  // The arrow follows price, not the conclusion.
  const sellReasons = prioritizer.prioritizeSignalReasons('sell', [
    row('trend', 'supports', 'bearish'),
    row('momentum', 'supports', 'bearish'),
  ]);
  assert.equal(
    sellReasons[0].direction,
    'negative',
    'a bearish lean points down even when it supports the SELL',
  );

  // Unavailable rows never become reasons.
  const noneMeasured = prioritizer.prioritizeSignalReasons('wait', [
    { category: 'trend', state: 'mixed', lean: 'mixed', availability: 'unavailable', detail: '', advanced: [] },
  ]);
  assert.deepEqual(noneMeasured, [], 'an unmeasured category cannot be a reason');

  // Only one line per category, and no duplicate phrasing.
  const duplicated = prioritizer.prioritizeSignalReasons('buy', [
    row('trend', 'supports', 'bullish'),
    row('trend', 'supports', 'bullish'),
  ]);
  assert.equal(duplicated.length, 1, 'a category earns at most one line');
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Resolver gates — a score can never promote a WAIT ---');
{
  // A confirmed breakout to new highs on expanding volume, held for two closes.
  function breakoutSeries() {
    const bars = [];
    let price = 60;
    for (let i = 0; i < 220; i++) {
      price += 0.28;
      bars.push(bar(i, price, { volume: 1_000_000 }));
    }
    const priorHigh = Math.max(...bars.slice(-21, -1).map((c) => c.high));
    bars.push(bar(220, priorHigh + 2.0, { volume: 3_000_000 }));
    bars.push(bar(221, priorHigh + 2.4, { volume: 3_000_000 }));
    return bars;
  }

  const candles = breakoutSeries();
  const pivots = priceStructure.findPivots(candles);
  const evaluation = quant.evaluateSignalCore('BRK', candles, pivots);
  const nowSeconds = candles[candles.length - 1].time + 2 * DAY;

  const summary = resolver.resolveUnifiedSignal({
    symbol: 'brk',
    candles,
    evaluation,
    marketPulseScore: 70,
    nowSeconds,
  });

  assert.equal(summary.symbol, 'BRK', 'the symbol is normalised once, in the resolver');
  assert.ok(['buy', 'wait', 'sell'].includes(summary.signal), 'exactly one of three words');
  assert.equal(summary.modelVersion, unified.UNIFIED_SIGNAL_MODEL_VERSION);
  assert.deepEqual(
    summary.evidence.map((e) => e.category),
    unified.DIRECTIONAL_EVIDENCE_CATEGORIES,
  );
  assert.ok(summary.keyReasons.length <= 2, 'at most two reasons reach a card');
  assert.ok(summary.whatCouldChange.length <= 2, 'at most two watch lines');
  assert.equal(typeof summary.summary, 'string');
  assert.ok(summary.summary.length > 0, 'the conclusion always has a sentence');
  assert.ok(
    Object.values(unified.SIGNAL_SUMMARY_SENTENCES).includes(summary.summary),
    'the sentence comes from the central copy table',
  );

  // Strength caps: the number can rank clarity inside a conclusion, never
  // contradict the word beside it.
  if (summary.signal === 'wait') {
    assert.ok(summary.strength <= 74, `a WAIT may not read above 74, got ${summary.strength}`);
  } else {
    assert.ok(summary.strength >= 55, `a decided conclusion floors at 55, got ${summary.strength}`);
    assert.ok(summary.strength <= 96);
  }

  // A directionally strong long with unusable geometry is a WAIT, whatever the
  // setup quality says.
  const noGeometry = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation: {
      ...evaluation,
      direction: 'long',
      setupType: 'breakout',
      setupQuality: 97,
      risk: { ...evaluation.risk, positionSize: 0 },
    },
    nowSeconds,
  });
  assert.equal(noGeometry.signal, 'wait', 'no usable size means WAIT at quality 97');
  assert.equal(noGeometry.summary, unified.SIGNAL_SUMMARY_SENTENCES['wait-risk']);
  assert.equal(noGeometry.riskPlan.readiness, 'needs-work');
  assert.equal(noGeometry.riskPlan.blocker, 'position-size-zero');
  assert.ok(noGeometry.strength <= 74, 'and its strength cannot climb past the WAIT ceiling');

  // Reward/risk below the minimum is its own blocker.
  const thinRr = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation: {
      ...evaluation,
      direction: 'long',
      risk: { ...evaluation.risk, rewardRisk1: 0.4, positionSize: 100 },
    },
    nowSeconds,
  });
  assert.equal(thinRr.riskPlan.blocker, 'reward-risk-below-minimum');
  assert.equal(thinRr.signal, 'wait');

  // Event risk is a hard gate ahead of everything else.
  const blocked = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation,
    eventRisk: { title: 'Earnings', detail: 'Tomorrow', eventId: 'e1', blocksEntry: true },
    nowSeconds,
  });
  assert.equal(blocked.signal, 'wait');
  assert.equal(blocked.summary, unified.SIGNAL_SUMMARY_SENTENCES['wait-event-risk']);
  assert.equal(blocked.riskPlan?.blocker ?? 'event-risk', 'event-risk');

  // A distant event is context, not a gate.
  const notBlocked = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation,
    eventRisk: { title: 'Earnings', detail: 'In 3 weeks', eventId: 'e2', blocksEntry: false },
    nowSeconds,
  });
  assert.notEqual(
    notBlocked.summary,
    unified.SIGNAL_SUMMARY_SENTENCES['wait-event-risk'],
    'a non-blocking event must not gate the conclusion',
  );

  // Insufficient history is stated, not guessed around.
  const shortSeries = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles: candles.slice(-20),
    evaluation,
    nowSeconds,
  });
  assert.equal(shortSeries.signal, 'wait');
  assert.equal(shortSeries.dataQuality, 'insufficient-history');
  assert.equal(shortSeries.summary, unified.SIGNAL_SUMMARY_SENTENCES['wait-data']);
  assert.equal(shortSeries.acceptance, null, 'no acceptance is claimed without history');

  // A short conclusion may never be shown against long-side geometry.
  const longGeometryShort = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation: { ...evaluation, direction: 'short', setupType: 'failed-breakout' },
    nowSeconds,
  });
  if (longGeometryShort.signal === 'sell') {
    assert.equal(
      longGeometryShort.riskPlan?.direction,
      'short',
      'a SELL must carry short geometry or none',
    );
  }

  // A neutral setup resolves to WAIT rather than inventing a side.
  const neutral = resolver.resolveUnifiedSignal({
    symbol: 'BRK',
    candles,
    evaluation: { ...evaluation, direction: 'none', setupType: 'no-clear-setup' },
    nowSeconds,
  });
  assert.equal(neutral.signal, 'wait');
  assert.equal(neutral.riskPlan, null, 'no direction means no plan');
}

// ---------------------------------------------------------------------------
console.log('--- Test 6b: A confirmed BUY is reachable and states its own risk ---');
{
  // An uptrend into a heavy flat base, then a breakout that holds above the
  // value area on expanding volume. Guarded explicitly: a conclusion branch
  // that can never be reached is the same class of bug as the unreachable
  // `breakout` setup in Test 9.
  const bars = [];
  let price = 60;
  for (let i = 0; i < 142; i++) {
    price += 0.3;
    bars.push(bar(i, price, { volume: 1_000_000 }));
  }
  for (let i = 142; i < 200; i++) {
    bars.push(bar(i, 102 + (i % 2) * 0.2, { volume: 5_000_000, spread: 0.5 }));
  }
  bars.push(bar(200, 106.5, { volume: 12_000_000 }));
  bars.push(bar(201, 106.9, { volume: 12_000_000 }));
  const nowSeconds = bars[bars.length - 1].time + 2 * DAY;

  const pivots = priceStructure.findPivots(bars);
  const core = quant.evaluateSignalCore('UP', bars, pivots);
  assert.equal(core.setupType, 'breakout', 'the fixture is a breakout by the core engine too');

  const longEval = {
    ...core,
    direction: 'long',
    setupType: 'breakout',
    risk: {
      ...core.risk,
      direction: 'long',
      rewardRisk1: 2.2,
      riskPerUnit: 2,
      positionSize: 100,
      target1: core.risk.entry + 5,
    },
    noTradeReasons: [],
  };

  const summary = resolver.resolveUnifiedSignal({
    symbol: 'UP',
    candles: bars,
    evaluation: longEval,
    marketPulseScore: 70,
    nowSeconds,
  });

  assert.equal(summary.signal, 'buy', `a held breakout should read BUY, got ${summary.signal}`);
  assert.equal(summary.summary, unified.SIGNAL_SUMMARY_SENTENCES.buy);
  assert.equal(summary.dataQuality, 'sufficient');
  assert.equal(summary.acceptance.state, 'accepted-above-value', 'confirmed by acceptance, not by a print');
  assert.ok(summary.strength >= 55 && summary.strength <= 96);
  assert.equal(summary.riskPlan.readiness, 'ready');
  assert.equal(summary.riskPlan.blocker, null);
  assert.equal(summary.riskPlan.direction, 'long');

  // A decided conclusion watches the support that could be withdrawn.
  assert.ok(summary.whatCouldChange.length > 0, 'a BUY still says what would undo it');
  assert.ok(
    summary.whatCouldChange.includes('Price falls back into the prior trading area'),
    `expected the acceptance watch line, got ${JSON.stringify(summary.whatCouldChange)}`,
  );
  assert.equal(summary.keyReasons.length, 2);
  assert.equal(summary.keyReasons[0].direction, 'positive');

  // An overbought RSI against a constructive MACD is genuinely two-sided, and
  // the row says so rather than rounding up to "momentum is building".
  const momentum = summary.evidence.find((e) => e.category === 'momentum');
  assert.equal(momentum.availability, 'measured');
  assert.equal(momentum.lean, 'mixed', 'an overbought breakout has two-sided momentum');

  // The same fixture with acceptance removed must not reach BUY: a breakout
  // resting on new highs needs accepted price behaviour.
  const noAcceptance = resolver.resolveUnifiedSignal({
    symbol: 'UP',
    candles: bars,
    evaluation: longEval,
    acceptanceCandles: bars.map((c) => ({ ...c, volume: 0 })),
    marketPulseScore: 70,
    nowSeconds,
  });
  assert.equal(
    noAcceptance.signal,
    'wait',
    'a breakout that rests on new highs may not be confirmed without acceptance',
  );
  assert.equal(noAcceptance.summary, unified.SIGNAL_SUMMARY_SENTENCES['wait-unconfirmed']);
  assert.ok(
    noAcceptance.whatCouldChange.length > 0,
    'and a wait says what still has to happen',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: A confirmed SELL needs measured acceptance below value ---');
{
  // A long decline into a heavy flat base, then a decisive breakdown on
  // expanding volume. The base is heavy so the value area stays pinned to it:
  // in a continuously trending series the profile travels with price and
  // nothing is ever "below value".
  const bars = [];
  let price = 160;
  for (let i = 0; i < 142; i++) {
    price -= 0.42;
    bars.push(bar(i, price, { volume: 1_000_000 }));
  }
  for (let i = 142; i < 200; i++) {
    bars.push(bar(i, 100 + (i % 2) * 0.2, { volume: 5_000_000, spread: 0.5 }));
  }
  bars.push(bar(200, 96.5, { volume: 12_000_000 }));
  bars.push(bar(201, 96.2, { volume: 12_000_000 }));
  const nowSeconds = bars[bars.length - 1].time + 2 * DAY;

  const pivots = priceStructure.findPivots(bars);
  const base = quant.evaluateSignalCore('DWN', bars, pivots);
  const shortEval = {
    ...base,
    direction: 'short',
    setupType: 'lower-high-rejection',
    risk: {
      ...base.risk,
      direction: 'short',
      rewardRisk1: 2.5,
      riskPerUnit: 2,
      positionSize: 100,
      target1: base.risk.entry - 5,
    },
    noTradeReasons: [],
  };

  const summary = resolver.resolveUnifiedSignal({
    symbol: 'DWN',
    candles: bars,
    evaluation: shortEval,
    nowSeconds,
  });
  assert.equal(summary.riskPlan.direction, 'short');
  assert.equal(summary.riskPlan.readiness, 'ready');
  assert.ok(
    summary.acceptance && summary.acceptance.state === 'accepted-below-value',
    `the fixture must hold below value, got ${summary.acceptance && summary.acceptance.state}`,
  );
  assert.equal(summary.signal, 'sell', `confirmed breakdown should read SELL, got ${summary.signal}`);
  assert.equal(summary.summary, unified.SIGNAL_SUMMARY_SENTENCES.sell);
  assert.ok(summary.strength >= 55, 'a decided conclusion floors at 55');

  const trend = summary.evidence.find((e) => e.category === 'trend');
  assert.equal(trend.state, 'supports', 'a downtrend supports a SELL');
  assert.equal(trend.lean, 'bearish', 'while still leaning bearish for price');
  assert.equal(
    trend.detail,
    'Trend has weakened',
    'and the sentence still describes price, not the conclusion',
  );

  // Same geometry, but acceptance cannot be measured: WAIT rather than a guess.
  // This is why a discovery scan with no usable volume never reaches SELL.
  const unmeasurable = resolver.resolveUnifiedSignal({
    symbol: 'DWN',
    candles: bars,
    evaluation: shortEval,
    acceptanceCandles: bars.map((c) => ({ ...c, volume: 0 })),
    nowSeconds,
  });
  assert.equal(
    unmeasurable.signal,
    'wait',
    'without measured acceptance the downside gate does not open',
  );
  assert.equal(unmeasurable.dataQuality, 'price-acceptance-unavailable');
  assert.ok(unmeasurable.strength <= 74);

  // A breakdown that only printed through the level, without holding it.
  const pokedOnly = [...bars.slice(0, 200), bar(200, 96.5, { volume: 12_000_000 })];
  const poked = resolver.resolveUnifiedSignal({
    symbol: 'DWN',
    candles: pokedOnly,
    evaluation: shortEval,
    nowSeconds,
  });
  assert.equal(
    poked.signal,
    'wait',
    'one close through the level is not a confirmed breakdown',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 8: QRM decision functional refuses a peak entry on asymmetry ---');
{
  function record(paths, overrides = {}) {
    return {
      schemaVersion: 1,
      id: 'f1',
      symbol: 'TST',
      assetType: 'stock',
      generatedAt: '2026-01-02T15:00:00.000Z',
      expiresAt: '2026-01-09T15:00:00.000Z',
      forecastStartAt: '2026-01-02T16:00:00.000Z',
      forecastEndAt: '2026-01-06T16:00:00.000Z',
      lastHistoricalClose: 100,
      horizonLabel: '24-trading-hours',
      metrics: {},
      aggregate: [],
      closePaths: paths,
      provenance: { mode: 'production', modelId: 'NeoQuasar/Kronos-mini' },
      evaluation: { status: 'not-started', actualPointsAvailable: 0, expectedPoints: 24 },
      warnings: [],
      ...overrides,
    };
  }
  const decide = (paths, overrides) => {
    const built = kronosDistribution.buildKronosDistribution(record(paths, overrides));
    return { built, result: qrmDecision.decideQrm(built && built.distribution) };
  };

  // Quantile helpers behave as the contract describes.
  const q = qrm.quantilesOf([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(q.p50, 5, 'median of 0..10');
  assert.equal(q.p10, 1);
  assert.equal(q.p90, 9);
  assert.equal(qrm.quantileOf([], 0.5), 0, 'an empty sample yields 0 rather than NaN');

  // A peak entry: every path runs up a little, then gives back much more than
  // it made before recovering. The terminal median is still positive, which is
  // exactly the case a trailing score gets wrong.
  const peakPaths = [];
  for (let p = 0; p < 30; p++) {
    const jitter = (p % 5) * 0.05;
    peakPaths.push([100.4 + jitter, 100.8 + jitter, 94 + jitter, 96 + jitter, 100.6 + jitter]);
  }
  const peak = decide(peakPaths);
  assert.ok(peak.result.edge > 0, `the median terminal return is positive, got ${peak.result.edge}`);
  const peakCodes = qrmDecision.qrmDecisionReasonCodes(peak.result);
  assert.ok(
    peakCodes.includes('reward-to-risk-too-low'),
    `a peak entry must be refused on asymmetry, got ${JSON.stringify(peakCodes)}`,
  );
  assert.equal(peak.result.decision, 'wait', 'and a refusal is a WAIT, not a candidate');
  assert.ok(peak.result.rewardToRisk < 1.3, 'the gated ratio is reported, not hidden');
  // The terminal tail is clean here — every path ends up. The adversity lives
  // entirely in the excursion, which is precisely why the reward/risk term and
  // not the terminal distribution is what catches a peak entry.
  assert.equal(peak.result.tailLoss, 0, 'no path ends below the base');
  assert.ok(
    peak.built.distribution.mae.p50 > peak.built.distribution.mfe.p50,
    'while the median adverse excursion exceeds the median favourable one',
  );

  // A well-located entry: the paths drift up with a shallow adverse excursion.
  const cleanPaths = [];
  for (let p = 0; p < 30; p++) {
    const jitter = (p % 5) * 0.1;
    cleanPaths.push([100.2 + jitter, 101 + jitter, 102 + jitter, 103 + jitter, 104 + jitter]);
  }
  const clean = decide(cleanPaths);
  assert.deepEqual(
    clean.result.reasons,
    [],
    `a clean drift should not be refused: ${JSON.stringify(clean.result.reasons)}`,
  );
  assert.equal(clean.result.decision, 'long-candidate');
  assert.ok(clean.result.signalToNoise >= 0.25, 'the signal-to-noise floor is cleared');
  assert.ok(clean.result.rewardToRisk > 1.3);
  assert.equal(clean.built.usablePaths, 30);
  assert.equal(clean.built.rejectedPaths, 0);
  assert.equal(clean.built.distribution.horizon, 1, 'a 5-bar intraday path files under 1 day');

  // A downward drift produces a short candidate, with the ratio reported for the
  // direction actually gated on.
  const downPaths = [];
  for (let p = 0; p < 30; p++) {
    const jitter = (p % 5) * 0.1;
    downPaths.push([99.8 - jitter, 99 - jitter, 98 - jitter, 97 - jitter, 96 - jitter]);
  }
  const down = decide(downPaths);
  assert.equal(
    down.result.decision,
    'short-candidate',
    `a downward ensemble should read short: ${JSON.stringify(down.result.reasons)}`,
  );
  assert.ok(down.result.edge < 0);
  assert.ok(
    down.result.rewardToRisk > 1,
    'a short reports adverse-over-favourable, so its own ratio reads above 1',
  );
  assert.ok(
    !qrmDecision.qrmDecisionReasonCodes(down.result).includes('adverse-tail-too-deep'),
    'a short is not harmed by the move it is positioned for',
  );

  // A flat ensemble is refused on signal-to-noise, not called neutral-positive.
  const flatPaths = [];
  for (let p = 0; p < 30; p++) {
    const jitter = (p % 7) * 0.4 - 1.2;
    flatPaths.push([100 + jitter, 100.1 + jitter, 99.9 + jitter, 100 + jitter, 100.02 + jitter]);
  }
  const flat = decide(flatPaths);
  assert.ok(
    qrmDecision.qrmDecisionReasonCodes(flat.result).includes('signal-to-noise-too-low'),
    `a flat ensemble is noise: ${JSON.stringify(flat.result.reasons)}`,
  );
  assert.equal(flat.result.decision, 'wait');

  // Deep adverse tails disqualify a long.
  const drawdownPaths = [];
  for (let p = 0; p < 30; p++) {
    drawdownPaths.push([100.5, 101, 85, 103, p < 12 ? 88 : 106]);
  }
  const drawdown = decide(drawdownPaths);
  assert.ok(
    qrmDecision.qrmDecisionReasonCodes(drawdown.result).includes('adverse-tail-too-deep'),
    `a deep adverse tail must refuse a long: ${JSON.stringify(drawdown.result.reasons)}`,
  );

  // `unavailable` and `wait` are different answers: could not speak vs declined.
  assert.equal(kronosDistribution.buildKronosDistribution(record([])), null);
  assert.equal(kronosDistribution.buildKronosDistribution(record([[NaN, 1]])), null);
  assert.equal(
    kronosDistribution.buildKronosDistribution(record(cleanPaths, { lastHistoricalClose: 0 })),
    null,
    'a zero base cannot be normalised against',
  );
  assert.equal(qrmDecision.decideQrm(null).decision, 'unavailable');
  assert.equal(qrmDecision.decideQrm(undefined).edge, null, 'unavailable reports no numbers');
  const malformed = qrmDecision.decideQrm({
    horizon: 5,
    terminalReturn: { p10: NaN, p25: 0, p50: 0, p75: 0, p90: 0 },
    probabilityPositive: 0.5,
    mfe: { p10: 0, p25: 0, p50: 0.01, p75: 0, p90: 0 },
    mae: { p10: 0, p25: 0, p50: 0.01, p75: 0, p90: 0 },
    probabilityLoss5PercentBeforeGain5Percent: null,
  });
  assert.equal(malformed.decision, 'unavailable', 'a non-finite quantile is unavailable');
  assert.equal(malformed.horizon, 5, 'and the horizon it failed on is still reported');

  // A mixed set of half-and-half paths must be refused on directional agreement.
  const splitPaths = [];
  for (let p = 0; p < 30; p++) {
    splitPaths.push(p % 2 === 0 ? [100.2, 101, 102, 103.4] : [99.8, 99, 98.4, 97.6]);
  }
  const split = decide(splitPaths);
  assert.ok(
    qrmDecision.qrmDecisionReasonCodes(split.result).includes('directional-probability-too-low'),
    `an evenly split ensemble has no directional agreement: ${JSON.stringify(split.result.reasons)}`,
  );

  // Thresholds are versioned research values, not production constants.
  assert.equal(qrmDecision.QRM_DECISION_RESEARCH_V1.minimumSignalToNoise, 0.25);
  assert.equal(qrmDecision.QRM_DECISION_RESEARCH_V1.minimumDirectionalProbability, 0.6);
  assert.equal(qrmDecision.QRM_DECISION_RESEARCH_V1.minimumRewardToRisk, 1.3);
  assert.ok(qrmDecision.QRM_DECISION_RESEARCH_V1.configVersion.length > 0);
  // A looser configuration changes the verdict, proving the gate is the config.
  const loose = qrmDecision.decideQrm(peak.built.distribution, {
    ...qrmDecision.QRM_DECISION_RESEARCH_V1,
    configVersion: 'loose-test',
    minimumRewardToRisk: 0.1,
    minimumSignalToNoise: 0,
    minimumDirectionalProbability: 0,
    maximumTailLossByHorizon: { 1: 1, 5: 1, 10: 1 },
  });
  assert.equal(loose.decision, 'long-candidate', 'the thresholds, not the code, decide');

  // Every reason code has a sentence.
  for (const code of Object.keys(qrmDecision.QRM_DECISION_REASONS)) {
    assert.ok(qrmDecision.QRM_DECISION_REASONS[code].length > 0, `${code} needs a sentence`);
  }

  // "-5% before +5%" is answered in path order, not from the extremes.
  const orderedPaths = [[94, 106, 100], [94, 106, 100]];
  const ordered = kronosDistribution.buildKronosDistribution(record(orderedPaths));
  assert.equal(
    ordered.distribution.probabilityLoss5PercentBeforeGain5Percent,
    1,
    'a path that fell 6% before rising 6% triggered the loss first',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 8b: Models keep their own semantics and disagreement is surfaced ---');
{
  const baseRecord = {
    schemaVersion: 1,
    id: 'f2',
    symbol: 'TST',
    assetType: 'stock',
    generatedAt: '2026-01-02T15:00:00.000Z',
    expiresAt: '2026-01-09T15:00:00.000Z',
    forecastStartAt: '2026-01-02T16:00:00.000Z',
    forecastEndAt: '2026-01-06T16:00:00.000Z',
    lastHistoricalClose: 100,
    horizonLabel: '24-trading-hours',
    metrics: {},
    aggregate: [],
    closePaths: Array.from({ length: 30 }, (_, p) => [100.2, 101, 102, 103 + (p % 3) * 0.1]),
    provenance: { mode: 'production', modelId: 'NeoQuasar/Kronos-mini' },
    evaluation: { status: 'not-started', actualPointsAvailable: 0, expectedPoints: 24 },
    warnings: [],
  };

  const built = kronosDistribution.buildKronosDistribution(baseRecord);
  const kronosView = kronosDistribution.kronosResearchView(baseRecord, built);
  assert.equal(kronosView.modelId, 'kronos');
  assert.equal(kronosView.status, 'ready');
  assert.equal(kronosView.directionalView, 'bullish');
  assert.equal(
    kronosView.decisionLabel,
    'Sampled median positive',
    'Kronos speaks in sampled medians, not in BUY/WAIT/SELL',
  );
  assert.ok(
    kronosView.reliabilityLabel.includes('sampled range'),
    'a P10-P90 band is never labelled a confidence interval without measured coverage',
  );
  assert.ok(
    !kronosView.reliabilityLabel.includes('confidence'),
    `got: ${kronosView.reliabilityLabel}`,
  );

  // With measured holdout coverage, the label may report it.
  const withCoverage = kronosDistribution.kronosResearchView(
    { ...baseRecord, evaluation: { ...baseRecord.evaluation, status: 'matured', p10P90Coverage: 0.77 } },
  );
  assert.ok(withCoverage.reliabilityLabel.includes('77%'));

  // An unusable record is 'unavailable', never a neutral-looking ready view.
  const empty = kronosDistribution.kronosResearchView({ ...baseRecord, closePaths: [] });
  assert.equal(empty.status, 'unavailable');
  assert.equal(empty.directionalView, 'none');

  // The experimental QRM view must say it is experimental.
  const qrmView = kronosDistribution.qrmResearchView(
    'qrm-3-research',
    qrmDecision.decideQrm(built.distribution),
  );
  assert.equal(qrmView.modelId, 'qrm-3');
  assert.ok(
    qrmView.reliabilityLabel.toLowerCase().includes('experimental'),
    'the experimental layer must never read as authoritative',
  );
  assert.ok(qrmView.decisionLabel.toLowerCase().includes('experimental'));
  assert.ok(
    !Object.prototype.hasOwnProperty.call(qrmView, 'confidence'),
    'models are not flattened onto a shared confidence score',
  );

  // Disagreement is surfaced as research context, not averaged away.
  const bearishView = { ...kronosView, directionalView: 'bearish' };
  assert.equal(
    kronosDistribution.describeModelDisagreement([kronosView, bearishView]),
    'Models disagree — investigate assumptions',
  );
  assert.equal(
    kronosDistribution.describeModelDisagreement([kronosView, kronosView]),
    null,
    'agreement produces no banner',
  );
  assert.equal(
    kronosDistribution.describeModelDisagreement([kronosView]),
    null,
    'one model cannot disagree with itself',
  );
  assert.equal(kronosDistribution.describeModelDisagreement([kronosView, empty]), null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 9: Regression — a forming bar is not its own resistance ---');
{
  // Before the fix, nearestResistance fell back to the highest high of the
  // trailing window *including* the bar under evaluation. On any push to a new
  // high that returned the bar's own high, a level the close is under by
  // construction — so `classifySetup` could never return 'breakout', and the
  // reported distance-to-resistance was a fraction of a percent, which vetoed
  // real breakouts as "too close to resistance for a long trade".
  const bars = [];
  let price = 100;
  for (let i = 0; i < 200; i++) {
    price += i < 160 ? 0.25 + Math.sin(i / 7) * 0.15 : Math.sin(i / 3) * 0.12;
    bars.push(bar(i, price, { spread: 0.24 }));
  }
  const rangeHigh = Math.max(...bars.slice(-30).map((c) => c.high));
  bars.push(
    candle(200, {
      open: rangeHigh + 0.2,
      high: rangeHigh + 1.55,
      low: rangeHigh + 0.1,
      close: rangeHigh + 1.5,
      volume: 2_500_000,
    }),
  );

  const pivots = priceStructure.findPivots(bars);
  const analytics = quant.analyticsFor(bars, pivots);
  const lastBar = bars[bars.length - 1];

  assert.equal(
    analytics.resistance,
    null,
    'with every trailing level cleared, there is no overhead resistance to report',
  );
  assert.equal(analytics.distanceToResistancePercent, null);

  const regime = quant.classifyRegime(bars);
  assert.equal(
    quant.classifySetup(bars, pivots, regime),
    'breakout',
    'a close above the prior 20-bar high on 2.5x volume is a breakout',
  );

  const evaluation = quant.evaluateSignalCore('BO', bars, pivots);
  assert.equal(evaluation.direction, 'long');
  assert.ok(
    !evaluation.noTradeReasons.some((reason) => reason.includes('too close to resistance')),
    `a breakout must not be vetoed for proximity to its own high: ${JSON.stringify(evaluation.noTradeReasons)}`,
  );

  // The helpers themselves: the window must exclude the bar being evaluated.
  assert.ok(
    quant.swingHigh(bars, 20, 1) < lastBar.high,
    'swingHigh(offset 1) excludes the final bar',
  );
  assert.ok(
    quant.swingLow(bars, 20, 1) > 0,
    'swingLow returns a usable level',
  );
  assert.equal(quant.swingHigh([], 20, 1), null, 'an empty series has no level');
  assert.equal(quant.swingHigh(bars, 20, bars.length + 5), null, 'an offset past the start is null');

  // Resistance is still reported when a level genuinely sits overhead.
  const pulledBack = [...bars, bar(201, rangeHigh - 3, { spread: 0.24 })];
  const pulledAnalytics = quant.analyticsFor(pulledBack, priceStructure.findPivots(pulledBack));
  assert.ok(
    pulledAnalytics.resistance !== null && pulledAnalytics.resistance > pulledAnalytics.lastClose,
    'a real overhead level is still found, and is above the close',
  );
  assert.ok(
    pulledAnalytics.distanceToResistancePercent > 0,
    'a reported distance to resistance is always positive',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 10: Factor detection polarity and readings ---');
{
  const bars = [];
  let price = 50;
  for (let i = 0; i < 210; i++) {
    price += 0.3;
    bars.push(bar(i, price, { volume: 1_000_000 }));
  }
  const set = signalFactors.detectSignalFactors(bars);
  assert.ok(set, '210 bars is enough to detect factors');
  assert.ok(set.factors.length > 0, 'a symbol with usable history always has factors');
  assert.ok(set.factors.length <= 6, 'the factor list is bounded');
  assert.ok(set.hasYearOfHistory, '210 bars clears the 200-session floor for a 52-week claim');
  assert.ok(set.readings.rsi14 > 50, 'a rising series reads a high RSI');
  assert.ok(set.readings.atr14 > 0);
  assert.ok(set.readings.movingAverage20 > set.readings.movingAverage50, 'stacked averages');

  // Below the 200-session floor, no 52-week claim is made.
  const shortHistory = signalFactors.detectSignalFactors(bars.slice(-120));
  assert.equal(
    shortHistory.hasYearOfHistory,
    false,
    'a four-month series may not describe a 52-week high',
  );
  assert.equal(shortHistory.readings.distanceToYearHighPercent, null);
  assert.equal(shortHistory.atOrNearYearHigh, false);
  assert.ok(
    !shortHistory.factors.some((f) => f.kind === 'yearly-high'),
    'and the yearly-high factor is not raised',
  );

  // Under 50 bars the engine declines rather than guessing.
  assert.equal(signalFactors.detectSignalFactors(bars.slice(-30)), null);

  // Polarity comes from the kind, not from the `positive` flag — a lost average
  // is recorded as detected (`positive: true`) but leans bearish.
  assert.equal(signalFactors.factorPriceLean('average-loss', true), -1);
  assert.equal(signalFactors.factorPriceLean('below-average', true), -1);
  assert.equal(signalFactors.factorPriceLean('trend-alignment', false), 1);
  assert.equal(signalFactors.factorPriceLean('range', true), 0, 'a range has no direction');
  assert.equal(signalFactors.factorPriceLean('rsi', false), -1, 'rsi is one of the two that use the flag');
  assert.equal(signalFactors.factorPriceLean('price-move', true), 1);

  // A live quote is visible before the bar closes, without rewriting volume.
  const withLive = signalFactors.detectSignalFactors(bars, price + 5);
  assert.equal(withLive.mark, price + 5, 'the live mark drives the readings');
  assert.equal(
    withLive.readings.relativeVolume,
    set.readings.relativeVolume,
    'a live price must not alter volume',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 11: Entry-quality metric measures location, not outcome ---');
{
  const m = (entry, direction) =>
    qrmDecision.measureEntryQuality({ entry, forwardMin: 90, forwardMax: 110, direction });

  // 0 is the best possible long location, 1 the worst.
  assert.equal(m(90, 'long').entryLocation, 0, 'entering at the forward low is location 0');
  assert.equal(m(110, 'long').entryLocation, 1, 'entering at the forward high is location 1');
  assert.equal(m(100, 'long').entryLocation, 0.5);

  // For both directions a lower penalty is a better entry.
  assert.equal(m(110, 'long').entryPenalty, 1, 'buying the peak is the worst long entry');
  assert.equal(m(110, 'short').entryPenalty, 0, 'and the best short entry');
  assert.equal(m(90, 'short').entryPenalty, 1, 'shorting the low is the worst short entry');

  // Entries outside the realised window clamp rather than running past the scale.
  assert.equal(m(120, 'long').entryLocation, 1);
  assert.equal(m(80, 'long').entryLocation, 0);

  // A degenerate window is excluded and counted, not scored as a perfect entry.
  const degenerate = qrmDecision.measureEntryQuality({
    entry: 100,
    forwardMin: 100,
    forwardMax: 100,
    direction: 'long',
  });
  assert.equal(degenerate.degenerate, true, 'max == min has no location');
  const nonFinite = qrmDecision.measureEntryQuality({
    entry: NaN,
    forwardMin: 90,
    forwardMax: 110,
    direction: 'long',
  });
  assert.equal(nonFinite.degenerate, true);

  const summary = qrmDecision.summarizeEntryQuality([
    m(90, 'long'),
    m(110, 'long'),
    degenerate,
  ]);
  assert.equal(summary.scored, 2, 'only non-degenerate samples are scored');
  assert.equal(summary.degenerate, 1, 'and the excluded one is reported separately');
  assert.equal(summary.meanEntryPenalty, 0.5, 'the mean excludes the degenerate sample');
  assert.equal(
    qrmDecision.summarizeEntryQuality([degenerate]).meanEntryPenalty,
    null,
    'with nothing scorable the mean is null, not 0',
  );
  assert.deepEqual(qrmDecision.summarizeEntryQuality([]), {
    meanEntryPenalty: null,
    meanEntryLocation: null,
    scored: 0,
    degenerate: 0,
  });
}

console.log('\nAll unified signal model tests passed successfully!');
