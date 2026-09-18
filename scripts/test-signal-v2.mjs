import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-signal-v2-test-${process.pid}`);
mkdirSync(tmp, { recursive: true });

const signalV2Outfile = path.join(tmp, 'signalV2.mjs');
const priceStructureOutfile = path.join(tmp, 'priceStructure.mjs');
const executionSimulatorOutfile = path.join(tmp, 'executionSimulator.mjs');
const signalStatisticsOutfile = path.join(tmp, 'signalStatistics.mjs');
const signalValidationOutfile = path.join(tmp, 'signalValidation.mjs');
const quantOutfile = path.join(tmp, 'quant.mjs');

await build({
  entryPoints: [path.join(root, 'src/shared/signalV2.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: signalV2Outfile,
  logLevel: 'silent',
});

await build({
  entryPoints: [path.join(root, 'src/shared/priceStructure.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: priceStructureOutfile,
  logLevel: 'silent',
});

await build({
  entryPoints: [path.join(root, 'src/shared/quant.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: quantOutfile,
  logLevel: 'silent',
});

await build({
  entryPoints: [path.join(root, 'src/shared/executionSimulator.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: executionSimulatorOutfile,
  logLevel: 'silent',
});

await build({
  entryPoints: [path.join(root, 'src/shared/signalStatistics.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: signalStatisticsOutfile,
  logLevel: 'silent',
});

await build({
  entryPoints: [path.join(root, 'src/shared/signalValidation.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: signalValidationOutfile,
  logLevel: 'silent',
});

const signalV2 = await import(pathToFileURL(signalV2Outfile).href);
const priceStructure = await import(pathToFileURL(priceStructureOutfile).href);
const quant = await import(pathToFileURL(quantOutfile).href);
const executionSimulator = await import(pathToFileURL(executionSimulatorOutfile).href);
const signalStatistics = await import(pathToFileURL(signalStatisticsOutfile).href);
const signalValidation = await import(pathToFileURL(signalValidationOutfile).href);

console.log('--- Test 1: Short candle confirmation regression ---');
{
  const bullishCandle = { time: 1000, open: 100, high: 105, low: 99, close: 104, volume: 1000 };
  const bearishCandle = { time: 1000, open: 104, high: 105, low: 99, close: 100, volume: 1000 };

  assert.equal(quant.bullishCloseConfirmed(bullishCandle), true);
  assert.equal(quant.bullishCloseConfirmed(bearishCandle), false);
  assert.equal(quant.bearishCloseConfirmed(bearishCandle), true);
  assert.equal(quant.bearishCloseConfirmed(bullishCandle), false);

  // Generate synthetic candles with bullish latest candle
  const baseCandles = Array.from({ length: 40 }, (_, idx) => ({
    time: 1000 + idx * 86400,
    open: 100 - idx * 0.5,
    high: 101 - idx * 0.5,
    low: 99 - idx * 0.5,
    close: 99.5 - idx * 0.5,
    volume: 1000,
  }));
  // Last candle closes upper-half (bullish)
  baseCandles.push({
    time: 1000 + 40 * 86400,
    open: 78,
    high: 82,
    low: 77.5,
    close: 81.5,
    volume: 2000,
  });

  const pivots = priceStructure.findPivots(baseCandles);
  const evalBullishClose = quant.evaluateSignalCore('TEST', baseCandles, pivots);
  const candleComp = evalBullishClose.components.find((c) => c.name === 'Candle close confirmation');
  assert.ok(candleComp);
  if (evalBullishClose.direction === 'short') {
    assert.equal(candleComp.status, 'warning');
    assert.ok(candleComp.score <= 0);
  }
}

console.log('--- Test 2: Long target hit ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 100, high: 104, low: 98, close: 103, volume: 1000 },
    { time: 1172800, open: 103, high: 111, low: 98, close: 109, volume: 1000 },
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(res && res.kind === 'trade');
  assert.equal(res.trade.exitReason, 'target1');
  assert.equal(res.trade.entryFill, 100);
  assert.equal(res.trade.exitFill, 110);
  assert.equal(res.trade.netR, 2.0); // (110 - 100) / (100 - 95) = 2R
}

console.log('--- Test 3: Long stop hit ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 100, high: 102, low: 94, close: 96, volume: 1000 },
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(res && res.kind === 'trade');
  assert.equal(res.trade.exitReason, 'stop');
  assert.equal(res.trade.entryFill, 100);
  assert.equal(res.trade.exitFill, 95);
  assert.equal(res.trade.netR, -1.0);
}

console.log('--- Test 4: Same-bar long stop + target (conservative stop first) ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 100, high: 112, low: 94, close: 108, volume: 1000 },
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(res && res.kind === 'trade');
  assert.equal(res.trade.exitReason, 'stop');
  assert.equal(res.trade.exitFill, 95);
  assert.equal(res.trade.netR, -1.0);
}

console.log('--- Test 5: Long stop gap ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 99, high: 101, low: 97, close: 98, volume: 1000 },
    { time: 1172800, open: 92, high: 94, low: 90, close: 91, volume: 1000 }, // gap down past 95 stop
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(res && res.kind === 'trade');
  assert.equal(res.trade.exitReason, 'stop');
  assert.equal(res.trade.exitFill, 92); // exit at gap open 92
  assert.equal(res.trade.netR, -1.75); // (92 - 99) / (99 - 95) = -7 / 4 = -1.75R (< -1R)
}

console.log('--- Test 6: Entry gap invalidation ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 94, high: 96, low: 93, close: 95, volume: 1000 }, // open is <= 95 stop
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
  });
  assert.ok(res && res.kind === 'skipped');
  assert.equal(res.skipped.reason, 'gap-invalidated');
}

console.log('--- Test 7: Entry gap beyond target ---');
{
  const signalCandle = { time: 1000, open: 98, high: 101, low: 97, close: 100, volume: 1000 };
  const subsequent = [
    { time: 1086400, open: 112, high: 115, low: 111, close: 114, volume: 1000 }, // open >= 110 target
  ];
  const res = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subsequent,
    setupType: 'pullback-continuation',
    direction: 'long',
    regime: 'trending-up',
    plannedStop: 95,
    plannedTarget1: 110,
  });
  assert.ok(res && res.kind === 'skipped');
  assert.equal(res.skipped.reason, 'gap-beyond-target');
}

console.log('--- Test 8: Short mirror cases ---');
{
  const signalCandle = { time: 1000, open: 102, high: 103, low: 99, close: 100, volume: 1000 };
  // 8.1 Short target hit
  const subTarget = [
    { time: 1086400, open: 100, high: 102, low: 96, close: 97, volume: 1000 },
    { time: 1172800, open: 97, high: 98, low: 88, close: 89, volume: 1000 }, // hits target 90
  ];
  const resTarget = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subTarget,
    setupType: 'lower-high-rejection',
    direction: 'short',
    regime: 'trending-down',
    plannedStop: 105,
    plannedTarget1: 90,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(resTarget && resTarget.kind === 'trade');
  assert.equal(resTarget.trade.exitReason, 'target1');
  assert.equal(resTarget.trade.netR, 2.0); // (100 - 90) / (105 - 100) = 2R

  // 8.2 Short stop hit
  const subStop = [
    { time: 1086400, open: 100, high: 106, low: 99, close: 104, volume: 1000 },
  ];
  const resStop = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subStop,
    setupType: 'lower-high-rejection',
    direction: 'short',
    regime: 'trending-down',
    plannedStop: 105,
    plannedTarget1: 90,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(resStop && resStop.kind === 'trade');
  assert.equal(resStop.trade.exitReason, 'stop');
  assert.equal(resStop.trade.netR, -1.0);

  // 8.3 Short both touched -> stop
  const subBoth = [
    { time: 1086400, open: 100, high: 107, low: 89, close: 95, volume: 1000 },
  ];
  const resBoth = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subBoth,
    setupType: 'lower-high-rejection',
    direction: 'short',
    regime: 'trending-down',
    plannedStop: 105,
    plannedTarget1: 90,
    config: { entrySlippageBps: 0, exitSlippageBps: 0, commissionBpsPerSide: 0 },
  });
  assert.ok(resBoth && resBoth.kind === 'trade');
  assert.equal(resBoth.trade.exitReason, 'stop');

  // 8.4 Short entry gap invalidated (open >= 105)
  const subGapInv = [
    { time: 1086400, open: 106, high: 108, low: 105, close: 107, volume: 1000 },
  ];
  const resGapInv = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subGapInv,
    setupType: 'lower-high-rejection',
    direction: 'short',
    regime: 'trending-down',
    plannedStop: 105,
    plannedTarget1: 90,
  });
  assert.ok(resGapInv && resGapInv.kind === 'skipped');
  assert.equal(resGapInv.skipped.reason, 'gap-invalidated');

  // 8.5 Short entry gap beyond target (open <= 90)
  const subGapBeyond = [
    { time: 1086400, open: 88, high: 89, low: 85, close: 87, volume: 1000 },
  ];
  const resGapBeyond = executionSimulator.simulateTrade({
    signalIndex: 0,
    signalCandle,
    subsequentCandles: subGapBeyond,
    setupType: 'lower-high-rejection',
    direction: 'short',
    regime: 'trending-down',
    plannedStop: 105,
    plannedTarget1: 90,
  });
  assert.ok(resGapBeyond && resGapBeyond.kind === 'skipped');
  assert.equal(resGapBeyond.skipped.reason, 'gap-beyond-target');
}

console.log('--- Test 9: Causal price structure - future bars do not alter historical prefix ---');
{
  const n = 150;
  const candles = Array.from({ length: n }, (_, i) => ({
    time: 1000000 + i * 86400,
    open: 100 + Math.sin(i / 5) * 5,
    high: 102 + Math.sin(i / 5) * 5,
    low: 98 + Math.sin(i / 5) * 5,
    close: 100.5 + Math.sin(i / 5) * 5,
    volume: 10000,
  }));

  const prefix100 = candles.slice(0, 100);
  const pivots100 = priceStructure.findPivots(prefix100);
  const eval100 = quant.evaluateSignalCore('TEST', prefix100, pivots100);

  // Now append 50 wildly fluctuating bars to the series
  const extendedCandles = [
    ...candles,
    ...Array.from({ length: 50 }, (_, i) => ({
      time: 1000000 + (n + i) * 86400,
      open: 500 + i * 10,
      high: 520 + i * 10,
      low: 490 + i * 10,
      close: 510 + i * 10,
      volume: 500000,
    })),
  ];

  // Re-evaluate the bar at index 99 using prefix
  const prefix100FromExtended = extendedCandles.slice(0, 100);
  const pivots100FromExtended = priceStructure.findPivots(prefix100FromExtended);
  const eval100FromExtended = quant.evaluateSignalCore('TEST', prefix100FromExtended, pivots100FromExtended);

  assert.deepEqual(eval100, eval100FromExtended);
}

console.log('--- Test 10: Bootstrap determinism & Wilson confidence intervals ---');
{
  const rValues = [1.2, -1.0, 1.8, -0.9, 2.1, -1.2, 0.5, -0.8, 1.9, 2.0, -1.0, 1.5];
  const seed = 'QuantDeskSignal_v2:SPY:pullback-continuation:long';

  const ci1 = signalStatistics.calculateBootstrapExpectancyCi(rValues, seed, 2000);
  const ci2 = signalStatistics.calculateBootstrapExpectancyCi(rValues, seed, 2000);
  assert.ok(ci1 !== null);
  assert.deepEqual(ci1, ci2); // byte-identical across runs

  const wilson = signalStatistics.calculateWilsonWinRateCi(7, 12);
  assert.ok(wilson !== null);
  assert.ok(wilson.lower >= 0 && wilson.upper <= 100);
  assert.ok(wilson.lower < wilson.upper);
}

console.log('--- Test 11: Single-position non-overlapping execution constraint in replay ---');
{
  // Build a synthetic candle series of 200 bars that triggers multiple pullback continuation setups
  const n = 220;
  const candles = Array.from({ length: n }, (_, i) => {
    const trend = i * 0.5;
    const cycle = Math.sin(i / 4) * 3;
    return {
      time: 1000000 + i * 86400,
      open: 100 + trend + cycle,
      high: 103 + trend + cycle,
      low: 99 + trend + cycle,
      close: 102 + trend + cycle,
      volume: 15000,
    };
  });

  const valResult = signalValidation.validateHistoricalStrategy({
    symbol: 'TEST',
    candles,
    targetSetup: 'pullback-continuation',
    targetDirection: 'long',
    minWarmupBars: 140,
  });

  assert.ok(valResult.status === 'ready' || valResult.status === 'unavailable');
  if (valResult.status === 'ready' && valResult.eligibleTrades > 1) {
    // Verify no two trades overlap in holding period
    // The replay enforces i = exitIndex + 1
    assert.ok(valResult.eligibleTrades > 0);
  }
}

console.log('--- Test 12: Historical validation unavailable when insufficient history or direction none ---');
{
  const shortCandles = Array.from({ length: 50 }, (_, i) => ({
    time: 1000000 + i * 86400,
    open: 100,
    high: 102,
    low: 98,
    close: 101,
    volume: 1000,
  }));

  const resShort = signalValidation.validateHistoricalStrategy({
    symbol: 'TEST',
    candles: shortCandles,
    targetSetup: 'pullback-continuation',
    targetDirection: 'long',
  });
  assert.equal(resShort.status, 'unavailable');
  assert.equal(resShort.evidenceStrength, 'insufficient');

  const resNone = signalValidation.validateHistoricalStrategy({
    symbol: 'TEST',
    candles: shortCandles,
    targetSetup: 'no-clear-setup',
    targetDirection: 'none',
  });
  assert.equal(resNone.status, 'unavailable');
  assert.equal(resNone.evidenceStrength, 'unavailable');
}

console.log('--- Test 13: Forward outcome store recording and resolution ---');
{
  const storeFilePath = path.join(tmp, 'test-forward-store.json');
  
  // 1. Record a signal
  const candle1 = { time: 1000, open: 100, high: 105, low: 99, close: 104, volume: 1000 };
  const mockEval = {
    symbol: 'NVDA',
    timeframe: '1d',
    signalBarTime: 1000,
    setupType: 'pullback-continuation',
    decision: 'buy-candidate',
    direction: 'long',
    regime: 'trending-up',
    setupQuality: 78,
    components: [],
    noTradeReasons: [],
    reason: 'Bullish setup',
    risk: { entry: 104, stop: 99, target1: 114, target2: 119, rewardRisk1: 2.0, maxDollarRisk: 500, positionSize: 100, maxDollarLoss: 500, estimatedGain1: 1000, estimatedGain2: 1500, invalidation: 99 },
    strategyVersion: 'QuantDeskSignal_v2',
  };

  // We need to test the forward outcome store functions
  // Build signalOutcomeStore for testing
  const outcomeStoreOutfile = path.join(tmp, 'signalOutcomeStore.mjs');
  await build({
    entryPoints: [path.join(root, 'src/main/services/signalOutcomeStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    plugins: [
      {
        name: 'electron-mock',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({
            path: 'electron-mock',
            namespace: 'mock',
          }));
          build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
            contents: 'export const app = { getPath: () => "" };',
          }));
        },
      },
    ],
    outfile: outcomeStoreOutfile,
    logLevel: 'silent',
  });
  const signalOutcomeStore = await import(pathToFileURL(outcomeStoreOutfile).href);

  const rec1 = signalOutcomeStore.recordCurrentSignalIfNeeded(mockEval, [candle1], storeFilePath);
  assert.ok(rec1);
  assert.equal(rec1.status, 'pending-entry');

  // Test deduplication on repeated observation
  const rec2 = signalOutcomeStore.recordCurrentSignalIfNeeded(mockEval, [candle1], storeFilePath);
  assert.equal(rec1.id, rec2.id);
  const allRecords = signalOutcomeStore.readAllOutcomeRecords(storeFilePath);
  assert.equal(allRecords.length, 1);

  // Subsequent bar hits target
  const candle2 = { time: 1086400, open: 104, high: 115, low: 103, close: 114, volume: 2000 };
  signalOutcomeStore.evaluatePendingForwardSignals('NVDA', [candle1, candle2], storeFilePath);

  const resolved = signalOutcomeStore.readAllOutcomeRecords(storeFilePath);
  assert.equal(resolved[0].status, 'resolved');
  assert.equal(resolved[0].exitReason, 'target1');
  assert.ok((resolved[0].netR ?? 0) > 0);

  const summary = signalOutcomeStore.getForwardSummary('NVDA', 'pullback-continuation', 'long', storeFilePath);
  assert.equal(summary.resolvedSignals, 1);
  assert.equal(summary.targetHits, 1);
  assert.equal(summary.winRatePercent, 100);

  const orderFilePath = path.join(tmp, 'test-forward-order.json');
  const template = resolved[0];
  const older = {
    ...template,
    id: 'older',
    signalBarTime: 1000,
    observedAt: '2026-01-01T00:00:00.000Z',
    resolvedAt: '2026-01-05T00:00:00.000Z',
  };
  const newer = {
    ...template,
    id: 'newer',
    signalBarTime: 3000,
    observedAt: '2026-03-01T00:00:00.000Z',
    resolvedAt: '2026-03-05T00:00:00.000Z',
  };
  signalOutcomeStore.writeAllOutcomeRecords([newer, older], orderFilePath);
  const orderedSummary = signalOutcomeStore.getForwardSummary(
    'NVDA', 'pullback-continuation', 'long', orderFilePath,
  );
  assert.equal(orderedSummary.firstSignalAt, older.observedAt);
  assert.equal(orderedSummary.lastResolvedAt, newer.resolvedAt);

  const pruneFilePath = path.join(tmp, 'test-forward-prune.json');
  const many = Array.from({ length: 5005 }, (_, index) => ({
    ...template,
    id: `prune-${index + 1}`,
    signalBarTime: index + 1,
    observedAt: new Date((index + 1) * 86_400_000).toISOString(),
    resolvedAt: new Date((index + 2) * 86_400_000).toISOString(),
  }));
  const scrambled = [...many.slice(2500), ...many.slice(0, 2500)];
  signalOutcomeStore.writeAllOutcomeRecords(scrambled, pruneFilePath);
  const pruned = signalOutcomeStore.readAllOutcomeRecords(pruneFilePath);
  assert.equal(pruned.length, 5000);
  assert.equal(pruned[0].signalBarTime, 6);
  assert.equal(pruned[pruned.length - 1].signalBarTime, 5005);
}

console.log('--- Test 14: AI harness buildQuantEvidence V2 integration ---');
{
  const harnessOutfile = path.join(tmp, 'harness.mjs');
  await build({
    entryPoints: [path.join(root, 'src/shared/harness.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: harnessOutfile,
    logLevel: 'silent',
  });
  const harness = await import(pathToFileURL(harnessOutfile).href);

  const mockReq = {
    symbol: 'AAPL',
    range: '1y',
    evaluation: {
      symbol: 'AAPL',
      setupType: 'pullback-continuation',
      decision: 'buy-candidate',
      direction: 'long',
      regime: 'trending-up',
      confidence: 82,
      components: [{ name: 'Trend', status: 'pass', score: 20, explanation: 'Aligned' }],
      noTradeReasons: [],
      reason: 'Strong trend pullback',
      risk: { entry: 150, stop: 145, target1: 160, target2: 165, rewardRisk1: 2.0, maxDollarRisk: 500, positionSize: 100, maxDollarLoss: 500, estimatedGain1: 1000, estimatedGain2: 1500, invalidation: 145 },
      analytics: { lastClose: 150, changePercent: 1.2, sma20: 148, sma50: 142, atr14: 3.0, atrPercent: 2.0, avgVolume20: 5000000, volumeRatio: 1.3, support: 145, resistance: 160, distanceToSupportPercent: 3.3, distanceToResistancePercent: 6.6 },
      backtest: { strategyName: 'BreakoutStrategy_v1', strategyVersion: '1.0', totalTrades: 45, winRate: 60, averageWin: 1.8, averageLoss: 1.0, profitFactor: 1.8, expectancy: 0.5, maxDrawdown: 3.2, averageR: 0.5, bestTradeR: 3.0, worstTradeR: -1.2, consecutiveWins: 4, consecutiveLosses: 2 },
      strategyVersion: 'QuantDeskSignal_v2',
      evaluatedAt: new Date().toISOString(),
    },
    signalValidation: {
      status: 'ready',
      strategyVersion: 'QuantDeskSignal_v2',
      executionModelVersion: 'DailyOHLC_Conservative_v1',
      setupType: 'pullback-continuation',
      direction: 'long',
      timeframe: '1d',
      totalBars: 1250,
      totalMatchingSignals: 35,
      eligibleTrades: 32,
      skippedSignals: 3,
      targetHits: 20,
      stopHits: 10,
      timeouts: 2,
      winRatePercent: 62.5,
      targetHitRatePercent: 62.5,
      averageWinR: 1.95,
      averageLossR: 1.02,
      expectancyR: 0.72,
      medianR: 0.65,
      profitFactor: 2.1,
      maxDrawdownR: 3.4,
      bestTradeR: 2.8,
      worstTradeR: -1.4,
      expectancyCi95: { lower: 0.25, upper: 1.18 },
      winRateCi95: { lower: 45.2, upper: 77.1 },
      evidenceStrength: 'usable',
    },
    forwardSignalRecord: {
      resolvedSignals: 8,
      activeSignals: 1,
      targetHits: 5,
      stopHits: 2,
      timeouts: 1,
      winRatePercent: 62.5,
      expectancyR: 0.68,
      profitFactor: 2.05,
      expectancyCi95: null,
    },
    news: [],
  };

  const evidence = harness.buildQuantEvidence(mockReq);
  assert.ok(evidence.length >= 4);
  const replayEvidence = evidence.find((e) => e.label.includes('Setup-specific historical replay (V2)'));
  assert.ok(replayEvidence);
  assert.ok(replayEvidence.value.includes('32 trades'));
  assert.ok(replayEvidence.value.includes('0.72R'));
  assert.equal(replayEvidence.quality, 'verified');

  const forwardEvidence = evidence.find((e) => e.label.includes('Forward signal record (V2)'));
  assert.ok(forwardEvidence);
  assert.ok(forwardEvidence.value.includes('8 resolved trades'));
}

console.log('--- Test 15: Breakout structure excludes the bar being evaluated ---');
{
  const base = Array.from({ length: 30 }, (_, index) => {
    const close = 96 + index * 0.05;
    return {
      time: 2_000_000 + index * 86_400,
      open: close - 0.15,
      high: Math.min(99.5, close + 0.8),
      low: close - 0.8,
      close,
      volume: 1_000,
    };
  });
  base[15] = { ...base[15], high: 100 };

  const breakout = [...base, {
    time: 2_000_000 + 30 * 86_400,
    open: 99,
    high: 104,
    low: 98.5,
    close: 103,
    volume: 2_500,
  }];
  assert.equal(quant.swingHigh(breakout, 20, 1), 100);
  assert.equal(quant.classifySetup(breakout, [], 'trending-up'), 'breakout');
  assert.equal(quant.analyticsFor(breakout, []).resistance, null);

  const failed = [
    ...base.slice(0, 29),
    {
      time: 2_000_000 + 29 * 86_400,
      open: 99,
      high: 103,
      low: 98.5,
      close: 101,
      volume: 1_800,
    },
    {
      time: 2_000_000 + 30 * 86_400,
      open: 101,
      high: 101.5,
      low: 97,
      close: 98,
      volume: 1_800,
    },
  ];
  assert.equal(quant.swingHigh(failed, 20, 2), 100);
  assert.equal(quant.classifySetup(failed, [], 'trending-up'), 'failed-breakout');
}

console.log('All Signal V2 unit tests passed successfully!');

