// Causal historical strategy validator for Signal Engine V2.
// Replays daily historical prefixes without lookahead bias, filters for exact setup/direction,
// enforces single-position non-overlapping execution, and computes robust statistical summaries.

import type { Candle } from './types';
import type {
  MarketRegime,
  RiskSettings,
  SetupType,
  TradeDirection,
} from './quant';
import { DEFAULT_RISK_SETTINGS, evaluateSignalCore } from './quant';
import { findPivots } from './priceStructure';
import type { ExecutionSimulatorConfig } from './executionSimulator';
import { simulateTrade } from './executionSimulator';
import type {
  HistoricalValidationSummary,
  SimulatedTrade,
  SkippedSignal,
} from './signalV2';
import { SIGNAL_ENGINE_V2 } from './signalV2';
import {
  calculateTradeMetrics,
  mean,
  round,
} from './signalStatistics';

export interface ValidateHistoricalStrategyArgs {
  symbol: string;
  candles: Candle[];
  targetSetup: SetupType;
  targetDirection: TradeDirection;
  currentRegime?: MarketRegime;
  riskSettings?: RiskSettings;
  config?: Partial<ExecutionSimulatorConfig>;
  minWarmupBars?: number;
}

export function validateHistoricalStrategy(
  args: ValidateHistoricalStrategyArgs,
): HistoricalValidationSummary {
  const {
    symbol,
    candles,
    targetSetup,
    targetDirection,
    currentRegime,
    riskSettings = DEFAULT_RISK_SETTINGS,
    config,
  } = args;

  const strategyVersion = config?.strategyVersion ?? SIGNAL_ENGINE_V2.strategyVersion;
  const executionModelVersion =
    config?.executionModelVersion ?? SIGNAL_ENGINE_V2.executionModelVersion;

  if (targetDirection !== 'long' && targetDirection !== 'short') {
    return {
      status: 'unavailable',
      unavailableReason: 'No directional setup for historical validation.',
      strategyVersion,
      executionModelVersion,
      setupType: targetSetup,
      direction: targetDirection,
      timeframe: '1d',
      totalBars: candles.length,
      totalMatchingSignals: 0,
      eligibleTrades: 0,
      skippedSignals: 0,
      targetHits: 0,
      stopHits: 0,
      timeouts: 0,
      winRatePercent: 0,
      targetHitRatePercent: 0,
      averageWinR: 0,
      averageLossR: 0,
      expectancyR: 0,
      medianR: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      bestTradeR: 0,
      worstTradeR: 0,
      expectancyCi95: null,
      winRateCi95: null,
      evidenceStrength: 'unavailable',
    };
  }

  const warmup = Math.max(
    140,
    args.minWarmupBars ?? SIGNAL_ENGINE_V2.minWarmupBars,
  );

  if (candles.length < warmup + 10) {
    return {
      status: 'unavailable',
      unavailableReason: `Insufficient daily history for validation (${candles.length} bars available, minimum ${warmup + 10} required).`,
      strategyVersion,
      executionModelVersion,
      setupType: targetSetup,
      direction: targetDirection,
      timeframe: '1d',
      totalBars: candles.length,
      totalMatchingSignals: 0,
      eligibleTrades: 0,
      skippedSignals: 0,
      targetHits: 0,
      stopHits: 0,
      timeouts: 0,
      winRatePercent: 0,
      targetHitRatePercent: 0,
      averageWinR: 0,
      averageLossR: 0,
      expectancyR: 0,
      medianR: 0,
      profitFactor: 0,
      maxDrawdownR: 0,
      bestTradeR: 0,
      worstTradeR: 0,
      expectancyCi95: null,
      winRateCi95: null,
      evidenceStrength: 'insufficient',
    };
  }

  const trades: SimulatedTrade[] = [];
  const skipped: SkippedSignal[] = [];

  let i = warmup;
  while (i < candles.length - 1) {
    const prefix = candles.slice(0, i + 1);
    const pivots = findPivots(prefix);
    const evaluation = evaluateSignalCore(symbol, prefix, pivots, riskSettings, {
      timeframe: '1d',
      evaluatedAt: new Date(candles[i].time * 1000).toISOString(),
    });

    const isExactCandidate =
      evaluation.setupType === targetSetup &&
      evaluation.direction === targetDirection &&
      (evaluation.decision === 'buy-candidate' ||
        evaluation.decision === 'short-candidate');

    if (!isExactCandidate) {
      i += 1;
      continue;
    }

    const result = simulateTrade({
      signalIndex: i,
      signalCandle: candles[i],
      subsequentCandles: candles.slice(i + 1),
      setupType: evaluation.setupType,
      direction: evaluation.direction,
      regime: evaluation.regime,
      plannedStop: evaluation.risk.stop,
      plannedTarget1: evaluation.risk.target1,
      config,
      riskSettings,
    });

    if (!result) {
      i += 1;
      continue;
    }

    if (result.kind === 'skipped') {
      skipped.push(result.skipped);
      i += 1;
      continue;
    }

    trades.push(result.trade);
    // Prevent overlapping duplicate positions in the same symbol
    i = result.trade.exitIndex + 1;
  }

  const seedKey = `${strategyVersion}:${symbol}:${targetSetup}:${targetDirection}`;
  const metrics = calculateTradeMetrics(trades, skipped.length, seedKey);

  let regimeMatched: HistoricalValidationSummary['regimeMatched'] | undefined;
  if (currentRegime) {
    const sameRegimeTrades = trades.filter((t) => t.regime === currentRegime);
    if (sameRegimeTrades.length >= 15) {
      const wins = sameRegimeTrades.filter((t) => t.netR > 0).length;
      regimeMatched = {
        regime: currentRegime,
        trades: sameRegimeTrades.length,
        expectancyR: round(mean(sameRegimeTrades.map((t) => t.netR)), 2),
        winRatePercent: round((wins / sameRegimeTrades.length) * 100, 1),
      };
    }
  }

  const historyStart = candles[0] ? new Date(candles[0].time * 1000).toISOString() : undefined;
  const historyEnd = candles[candles.length - 1]
    ? new Date(candles[candles.length - 1].time * 1000).toISOString()
    : undefined;

  return {
    status: 'ready',
    strategyVersion,
    executionModelVersion,
    setupType: targetSetup,
    direction: targetDirection,
    timeframe: '1d',
    historyStart,
    historyEnd,
    totalBars: candles.length,
    ...metrics,
    regimeMatched,
  };
}
