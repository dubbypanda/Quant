// Portfolio risk mathematics tests (docs/quant-v3/03, Task 3).
//
// Covers every case that task enumerates: single asset, two perfectly
// correlated assets, two imperfectly correlated assets, cash-only, missing
// history, date intersection, VaR/CVaR sign conventions, and component
// contributions summing to ~100% within ±0.01pp.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-portfolio-risk-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const outfile = path.join(tmp, 'portfolioRisk.mjs');
await build({
  entryPoints: [path.join(root, 'src/shared/portfolioRisk.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
});
const risk = await import(outfile);

const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 2) / 1000;
const TRADING_DAYS = 252;

/** Deterministic pseudo-random returns; no Math.random anywhere. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Candles from a return series, starting at 100. */
function candlesFromReturns(returns, { skipDays = new Set() } = {}) {
  const candles = [];
  let price = 100;
  // Bar 0 carries no return; the first return applies to bar 1.
  candles.push({ time: T0, open: price, high: price, low: price, close: price, volume: 1000 });
  for (let i = 0; i < returns.length; i++) {
    price *= 1 + returns[i];
    const day = i + 1;
    if (skipDays.has(day)) continue;
    candles.push({
      time: T0 + day * DAY,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 1000,
    });
  }
  return candles;
}

function position(symbol, marketValue) {
  return {
    symbol,
    assetType: 'stock',
    quantity: 1,
    averageCost: marketValue,
    marketPrice: marketValue,
    marketValue,
    costBasis: marketValue,
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    dayChange: 0,
    dayChangePercent: 0,
    portfolioWeightPercent: null,
    source: 'live',
  };
}

const prng = mulberry32(99);
/** 300 days of ~1% daily noise. */
function noisyReturns(count = 300, scale = 0.01) {
  return Array.from({ length: count }, () => (prng() - 0.5) * 2 * scale);
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Single asset — portfolio volatility is its own ---');
{
  const returns = noisyReturns();
  const candles = candlesFromReturns(returns);
  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    totalCash: 0,
  });

  assert.equal(report.contributions.length, 1);
  assert.ok(report.annualizedVolatilityPercent > 0);
  // A 100%-weighted single asset must equal its own standalone volatility.
  assert.ok(
    Math.abs(report.annualizedVolatilityPercent - report.contributions[0].annualizedVolatilityPercent) < 1e-6,
    `${report.annualizedVolatilityPercent} vs ${report.contributions[0].annualizedVolatilityPercent}`,
  );
  assert.ok(Math.abs(report.contributions[0].weightPercent - 100) < 1e-9);
  assert.ok(
    Math.abs(report.contributions[0].componentRiskPercent - 100) < 0.01,
    `sole holding contributes 100% of risk, got ${report.contributions[0].componentRiskPercent}`,
  );
  // Beta against itself is 1.
  assert.ok(Math.abs(report.betaToSpy - 1) < 1e-6, `beta to itself is 1, got ${report.betaToSpy}`);
  assert.ok(Math.abs(report.diversificationRatio - 1) < 1e-6, 'one asset cannot diversify');
  assert.equal(report.lookbackTradingDays, Math.min(TRADING_DAYS, returns.length));
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Two perfectly correlated assets do not diversify ---');
{
  const returns = noisyReturns();
  const candles = candlesFromReturns(returns);
  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 5_000), position('BBB', 5_000)],
    // Identical series: correlation 1.
    historyBySymbol: { AAA: candles, BBB: candles },
    benchmark: candles,
    totalCash: 0,
  });

  const standalone = report.contributions[0].annualizedVolatilityPercent;
  assert.ok(
    Math.abs(report.annualizedVolatilityPercent - standalone) < 1e-6,
    `perfect correlation yields no reduction: ${report.annualizedVolatilityPercent} vs ${standalone}`,
  );
  assert.ok(
    Math.abs(report.diversificationRatio - 1) < 1e-6,
    `diversification ratio is 1 under perfect correlation, got ${report.diversificationRatio}`,
  );
  // Equal weights and identical risk: 50/50.
  for (const contribution of report.contributions) {
    assert.ok(
      Math.abs(contribution.componentRiskPercent - 50) < 0.01,
      `${contribution.symbol} should contribute 50%, got ${contribution.componentRiskPercent}`,
    );
  }
  const total = report.contributions.reduce((sum, item) => sum + item.componentRiskPercent, 0);
  assert.ok(Math.abs(total - 100) < 0.01, `contributions sum to 100%, got ${total}`);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Two imperfectly correlated assets diversify ---');
{
  const a = noisyReturns();
  const other = mulberry32(4242);
  const b = Array.from({ length: a.length }, () => (other() - 0.5) * 2 * 0.01);
  const candlesA = candlesFromReturns(a);
  const candlesB = candlesFromReturns(b);

  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 5_000), position('BBB', 5_000)],
    historyBySymbol: { AAA: candlesA, BBB: candlesB },
    benchmark: candlesA,
    totalCash: 0,
  });

  const weighted =
    0.5 * report.contributions[0].annualizedVolatilityPercent +
    0.5 * report.contributions[1].annualizedVolatilityPercent;
  assert.ok(
    report.annualizedVolatilityPercent < weighted,
    `imperfect correlation must reduce volatility: ${report.annualizedVolatilityPercent} vs ${weighted}`,
  );
  assert.ok(
    report.diversificationRatio > 1,
    `diversification ratio above 1, got ${report.diversificationRatio}`,
  );
  const total = report.contributions.reduce((sum, item) => sum + item.componentRiskPercent, 0);
  assert.ok(Math.abs(total - 100) < 0.01, `contributions still sum to 100%, got ${total}`);
  // A three-asset portfolio must also sum to 100%.
  const third = mulberry32(777);
  const c = Array.from({ length: a.length }, () => (third() - 0.5) * 2 * 0.02);
  const threeWay = risk.calculatePortfolioRisk({
    positions: [position('AAA', 4_000), position('BBB', 3_000), position('CCC', 3_000)],
    historyBySymbol: { AAA: candlesA, BBB: candlesB, CCC: candlesFromReturns(c) },
    benchmark: candlesA,
    totalCash: 0,
  });
  const threeTotal = threeWay.contributions.reduce((sum, item) => sum + item.componentRiskPercent, 0);
  assert.ok(Math.abs(threeTotal - 100) < 0.01, `three-asset sum, got ${threeTotal}`);
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Cash dilutes risk rather than being renormalized away ---');
{
  const returns = noisyReturns();
  const candles = candlesFromReturns(returns);
  const noCash = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    totalCash: 0,
  });
  const halfCash = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    totalCash: 10_000,
  });

  // 50% cash halves portfolio volatility and beta. Renormalising the risky
  // weight to 100% would have reported no change at all.
  assert.ok(
    Math.abs(halfCash.annualizedVolatilityPercent - noCash.annualizedVolatilityPercent / 2) < 1e-6,
    `${halfCash.annualizedVolatilityPercent} vs ${noCash.annualizedVolatilityPercent / 2}`,
  );
  assert.ok(Math.abs(halfCash.betaToSpy - 0.5) < 1e-6, `beta halves, got ${halfCash.betaToSpy}`);
  assert.ok(Math.abs(halfCash.contributions[0].weightPercent - 50) < 1e-9);
  // The sole risky asset still accounts for all measured risk.
  assert.ok(Math.abs(halfCash.contributions[0].componentRiskPercent - 100) < 0.01);

  // Cash-only is zero risk — a real answer, not missing data.
  const cashOnly = risk.calculatePortfolioRisk({
    positions: [],
    historyBySymbol: {},
    benchmark: candles,
    totalCash: 25_000,
  });
  assert.equal(cashOnly.annualizedVolatilityPercent, 0);
  assert.equal(cashOnly.betaToSpy, 0);
  assert.equal(cashOnly.oneDayVaR95Percent, 0);
  assert.equal(cashOnly.oneDayCVaR95Percent, 0);
  assert.equal(cashOnly.maxDrawdownPercent, 0);
  assert.deepEqual(cashOnly.contributions, []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Missing history is null plus a named exclusion ---');
{
  const returns = noisyReturns();
  const candles = candlesFromReturns(returns);

  // Nothing at all: null metrics, not zeros.
  const nothing = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: {},
    benchmark: candles,
    totalCash: 0,
  });
  assert.equal(nothing.annualizedVolatilityPercent, null);
  assert.equal(nothing.oneDayVaR95Percent, null);
  assert.equal(nothing.betaToSpy, null);
  assert.deepEqual(nothing.contributions, []);
  assert.ok(nothing.warnings.length > 0);

  // Too short to be usable.
  const tooShort = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candlesFromReturns(returns.slice(0, 20)) },
    benchmark: candles,
    totalCash: 0,
  });
  assert.equal(tooShort.annualizedVolatilityPercent, null);
  assert.ok(tooShort.warnings.some((warning) => /insufficient history/i.test(warning)));
  assert.ok(tooShort.warnings.some((warning) => /AAA/.test(warning)), 'the symbol is named');

  // One usable, one not: the usable one is measured and the other is named.
  const mixed = risk.calculatePortfolioRisk({
    positions: [position('AAA', 9_000), position('SHORTY', 1_000)],
    historyBySymbol: { AAA: candles, SHORTY: candlesFromReturns(returns.slice(0, 5)) },
    benchmark: candles,
    totalCash: 0,
  });
  assert.equal(mixed.contributions.length, 1);
  assert.equal(mixed.contributions[0].symbol, 'AAA');
  assert.ok(mixed.warnings.some((warning) => /SHORTY/.test(warning)));
  // 10% excluded is under the 20% ceiling, so no partial warning.
  assert.ok(!mixed.warnings.some((warning) => /this report is partial/i.test(warning)));

  // Over 20% of non-cash value excluded escalates to a partial warning.
  const partial = risk.calculatePortfolioRisk({
    positions: [position('AAA', 6_000), position('SHORTY', 4_000)],
    historyBySymbol: { AAA: candles, SHORTY: candlesFromReturns(returns.slice(0, 5)) },
    benchmark: candles,
    totalCash: 0,
  });
  assert.ok(
    partial.warnings.some((warning) => /this report is partial/i.test(warning)),
    partial.warnings.join('; '),
  );

  // A missing benchmark loses beta but keeps volatility.
  const noBenchmark = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: [],
    totalCash: 0,
  });
  assert.ok(noBenchmark.annualizedVolatilityPercent > 0);
  assert.equal(noBenchmark.betaToSpy, null);
  assert.ok(noBenchmark.warnings.some((warning) => /beta is unavailable/i.test(warning)));

  // Raw closes are disclosed as a limitation.
  const rawCloses = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    adjusted: false,
  });
  assert.ok(
    rawCloses.warnings.some((warning) => /splits and dividends/i.test(warning)),
    'the adjustment limitation is recorded',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Date intersection, never forward-fill ---');
{
  const returns = noisyReturns(300, 0.015);
  const full = candlesFromReturns(returns);
  // BBB is missing 40 scattered days. Forward-filling would inject 40 zero
  // returns, dragging its measured volatility down.
  const missing = new Set(Array.from({ length: 40 }, (_, i) => 3 + i * 7));
  const sparse = candlesFromReturns(returns, { skipDays: missing });

  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 5_000), position('BBB', 5_000)],
    historyBySymbol: { AAA: full, BBB: sparse },
    benchmark: full,
    totalCash: 0,
  });

  // The window is the intersection, so it is shorter than either series.
  assert.ok(
    report.lookbackTradingDays < returns.length,
    `intersection shortens the window, got ${report.lookbackTradingDays}`,
  );
  assert.ok(report.lookbackTradingDays >= 60, 'and still clears the minimum');

  // A bar missing from BBB means its next observed return spans two days, so
  // it is genuinely larger than AAA's single-day return — that is a real
  // measurement of what was observed, not an artefact.
  const sparseVolatility = report.contributions.find((item) => item.symbol === 'BBB')
    .annualizedVolatilityPercent;
  const denseVolatility = report.contributions.find((item) => item.symbol === 'AAA')
    .annualizedVolatilityPercent;
  assert.ok(
    sparseVolatility >= denseVolatility,
    `gap-spanning returns are not smaller: ${sparseVolatility} vs ${denseVolatility}`,
  );

  // The contrast that matters. Build the forward-filled version of BBB by
  // carrying the last price across each missing day, which is what a
  // "helpfully" padded series looks like, and measure it.
  const forwardFilled = [];
  let lastPrice = 100;
  forwardFilled.push({ time: T0, open: 100, high: 100, low: 100, close: 100, volume: 1 });
  for (let day = 1; day <= returns.length; day++) {
    if (!missing.has(day)) lastPrice *= 1 + returns[day - 1];
    forwardFilled.push({
      time: T0 + day * DAY,
      open: lastPrice,
      high: lastPrice,
      low: lastPrice,
      close: lastPrice,
      volume: 1,
    });
  }
  const paddedReport = risk.calculatePortfolioRisk({
    positions: [position('BBB', 10_000)],
    historyBySymbol: { BBB: forwardFilled },
    benchmark: full,
    totalCash: 0,
  });
  const soloSparse = risk.calculatePortfolioRisk({
    positions: [position('BBB', 10_000)],
    historyBySymbol: { BBB: sparse },
    benchmark: full,
    totalCash: 0,
  });
  assert.ok(
    paddedReport.annualizedVolatilityPercent < soloSparse.annualizedVolatilityPercent,
    `forward-filling injects zero returns and understates volatility: padded ${paddedReport.annualizedVolatilityPercent} vs observed ${soloSparse.annualizedVolatilityPercent}`,
  );

  // A pair with too little overlap is refused rather than padded.
  const disjoint = [
    { time: T0, open: 100, high: 100, low: 100, close: 100, volume: 1 },
    ...Array.from({ length: 300 }, (_, i) => ({
      time: T0 + (500 + i) * DAY,
      open: 100 + i,
      high: 100 + i,
      low: 100 + i,
      close: 100 + i,
      volume: 1,
    })),
  ];
  const noOverlap = risk.calculatePortfolioRisk({
    positions: [position('AAA', 5_000), position('BBB', 5_000)],
    historyBySymbol: { AAA: full, BBB: disjoint },
    benchmark: full,
    totalCash: 0,
  });
  assert.equal(noOverlap.annualizedVolatilityPercent, null);
  assert.ok(noOverlap.warnings.some((warning) => /overlapping trading days/i.test(warning)));
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: VaR/CVaR sign conventions and empirical tails ---');
{
  // A deliberately fat left tail: mostly small gains, with 10% of days losing
  // and those losses split between -5% and -12%. Loss frequency is set well
  // above 5% on purpose — at exactly 5% the empirical 5th percentile lands on
  // the boundary between the loss cluster and the gains, and the interpolated
  // quantile is then legitimately near zero.
  const returns = [];
  for (let i = 0; i < 200; i++) {
    if (i % 10 !== 0) returns.push(0.004);
    else returns.push(i % 20 === 0 ? -0.12 : -0.05);
  }
  const candles = candlesFromReturns(returns);

  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    totalCash: 0,
  });

  // Both are reported as POSITIVE loss magnitudes.
  assert.ok(report.oneDayVaR95Percent > 0, `VaR is a positive loss, got ${report.oneDayVaR95Percent}`);
  assert.ok(report.oneDayCVaR95Percent > 0);
  // CVaR is the mean of the tail at or below VaR, so it is never smaller.
  assert.ok(
    report.oneDayCVaR95Percent >= report.oneDayVaR95Percent - 1e-9,
    `CVaR ${report.oneDayCVaR95Percent} must be >= VaR ${report.oneDayVaR95Percent}`,
  );
  // The 5th percentile sits inside the loss cluster, so the empirical tail is
  // captured rather than smoothed away by a normality assumption.
  assert.ok(
    report.oneDayVaR95Percent > 3,
    `the empirical tail is captured, got ${report.oneDayVaR95Percent}`,
  );
  // CVaR averages only the worst losses, so with a split tail it is strictly
  // deeper than VaR — the property a single percentile cannot express.
  assert.ok(
    report.oneDayCVaR95Percent > report.oneDayVaR95Percent,
    `CVaR ${report.oneDayCVaR95Percent} should exceed VaR ${report.oneDayVaR95Percent} on a split tail`,
  );
  assert.ok(report.maxDrawdownPercent > 0);

  // An all-gains series has no loss tail, so both clamp to zero rather than
  // reporting a negative "loss".
  const allGains = candlesFromReturns(Array.from({ length: 200 }, () => 0.003));
  const noLoss = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: allGains },
    benchmark: allGains,
    totalCash: 0,
  });
  assert.equal(noLoss.oneDayVaR95Percent, 0, 'no loss tail means zero, never negative');
  assert.equal(noLoss.oneDayCVaR95Percent, 0);
  assert.ok(noLoss.maxDrawdownPercent < 1e-9, 'a monotonic riser has no drawdown');

  // A flat series has zero volatility and zero risk.
  const flat = candlesFromReturns(Array.from({ length: 200 }, () => 0));
  const flatReport = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: flat },
    benchmark: flat,
    totalCash: 0,
  });
  assert.equal(flatReport.annualizedVolatilityPercent, 0);
  assert.equal(flatReport.oneDayVaR95Percent, 0);
  // A zero-variance benchmark cannot produce a beta.
  assert.equal(flatReport.betaToSpy, null);
  assert.ok(flatReport.warnings.some((warning) => /no variance/i.test(warning)));

  // Max drawdown helper directly.
  assert.equal(risk.maxDrawdownPercent([]), null);
  assert.equal(risk.maxDrawdownPercent([0.1]), null, 'one return is not a path');
  const drawdown = risk.maxDrawdownPercent([0.5, -0.5]);
  // 1 -> 1.5 -> 0.75, so the peak-to-trough decline is 50%.
  assert.ok(Math.abs(drawdown - 50) < 1e-9, `expected 50%, got ${drawdown}`);
  assert.ok(Math.abs(risk.maxDrawdownPercent([0.1, 0.1, 0.1])) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log('--- Test 8: Unpriced positions never enter the risk calculation ---');
{
  const candles = candlesFromReturns(noisyReturns());
  const unpriced = {
    ...position('GHOST', 0),
    marketValue: null,
    marketPrice: null,
  };
  const report = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000), unpriced],
    historyBySymbol: { AAA: candles, GHOST: candles },
    benchmark: candles,
    totalCash: 0,
  });
  assert.equal(report.contributions.length, 1, 'an unpriced position has no weight to contribute');
  assert.equal(report.contributions[0].symbol, 'AAA');
  assert.ok(Math.abs(report.contributions[0].weightPercent - 100) < 1e-9);

  assert.equal(risk.DEFAULT_RISK_LOOKBACK_DAYS, 252);
  assert.equal(risk.MINIMUM_RISK_OVERLAP_DAYS, 60);

  // A shorter explicit lookback is honoured.
  const shortWindow = risk.calculatePortfolioRisk({
    positions: [position('AAA', 10_000)],
    historyBySymbol: { AAA: candles },
    benchmark: candles,
    lookbackTradingDays: 90,
  });
  assert.equal(shortWindow.lookbackTradingDays, 90);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll portfolio risk tests passed successfully!');
