// Authoritative Signal Desk service for Signal Engine V2.
// Composes 5-year daily history, causal price structure, deterministic signal core,
// exact-setup historical replay, in-memory caching, and forward outcome recording.

import type { Candle } from '../../shared/types';
import type {
  HistoricalValidationSummary,
  SignalCoreEvaluation,
  SignalDeskResult,
} from '../../shared/signalV2';
import { SIGNAL_ENGINE_V2 } from '../../shared/signalV2';
import { DEFAULT_RISK_SETTINGS, evaluateSignalCore } from '../../shared/quant';
import { findPivots } from '../../shared/priceStructure';
import { validateHistoricalStrategy } from '../../shared/signalValidation';
import { resolveUnifiedSignal } from '../../shared/unifiedSignalResolver';
import { UNIFIED_SIGNAL_MODEL_VERSION } from '../../shared/unifiedSignal';
import { getDailyHistory } from './dailyHistory';
import {
  evaluatePendingForwardSignals,
  getForwardSummary,
  recordCurrentSignalIfNeeded,
} from './signalOutcomeStore';
import { appendSignalSnapshot } from './signalHistoryStore';

interface CacheEntry {
  key: string;
  result: SignalDeskResult;
  cachedAt: number;
}

const CACHE_TTL_MS = 30 * 60_000;
const MAX_CACHE_ENTRIES = 50;
const signalDeskCache = new Map<string, CacheEntry>();

export function clearSignalDeskCache(): void {
  signalDeskCache.clear();
}

export function unavailableSignalDesk(
  symbol: string,
  warning = 'Signal Desk could not load.',
): SignalDeskResult {
  return {
    status: 'unavailable',
    symbol: symbol.trim().toUpperCase(),
    timeframe: '1d',
    source: 'unavailable',
    evaluation: null,
    historical: null,
    forward: getForwardSummary(symbol),
    unified: null,
    warnings: [warning],
  };
}

export function buildSignalDesk(
  symbolRaw: string,
  history: import('./dailyHistory').DailyHistoryResult,
): SignalDeskResult {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol) {
    return unavailableSignalDesk('', 'Invalid symbol.');
  }

  if (history.source !== 'live' || history.candles.length < 250) {
    return {
      status: 'unavailable',
      symbol,
      timeframe: '1d',
      source: 'unavailable',
      evaluation: null,
      historical: null,
      forward: getForwardSummary(symbol),
      unified: null,
      warnings: [history.warning ?? 'Live daily history is unavailable.'],
    };
  }

  const candles = history.candles;
  const currentCandles = candles.slice(-252);
  const lastCandle = currentCandles[currentCandles.length - 1];
  const asOf = lastCandle ? new Date(lastCandle.time * 1000).toISOString() : undefined;

  const pivots = findPivots(currentCandles);
  const evaluation: SignalCoreEvaluation = evaluateSignalCore(
    symbol,
    currentCandles,
    pivots,
    DEFAULT_RISK_SETTINGS,
    {
      timeframe: '1d',
      evaluatedAt: asOf,
    },
  );

  let historical: HistoricalValidationSummary | null = null;
  if (evaluation.direction === 'long' || evaluation.direction === 'short') {
    historical = validateHistoricalStrategy({
      symbol,
      candles,
      targetSetup: evaluation.setupType,
      targetDirection: evaluation.direction,
      currentRegime: evaluation.regime,
      riskSettings: DEFAULT_RISK_SETTINGS,
    });
  }

  // 14.3 Decision Policy: If base decision is candidate but exact historical replay has negative expectancy with >= 30 trades, downgrade actionable banner
  if (
    (evaluation.decision === 'buy-candidate' || evaluation.decision === 'short-candidate') &&
    historical &&
    historical.status === 'ready' &&
    historical.eligibleTrades >= 30 &&
    (historical.expectancyR <= 0 || historical.profitFactor < 1.0)
  ) {
    evaluation.decision = 'no-trade';
    evaluation.noTradeReasons.push('Historical replay for this exact setup has negative expectancy.');
  }

  // Record candidate and update forward evaluator
  recordCurrentSignalIfNeeded(evaluation, candles);
  evaluatePendingForwardSignals(symbol, candles);

  // Append an immutable history snapshot for the chart marker layer. This runs
  // for every decision, not only candidates, so an `All decisions` view has
  // something to show — and it is a no-op when this bar was already recorded,
  // which is what keeps an old marker showing the old model's conclusion.
  try {
    appendSignalSnapshot({
      evaluation,
      dataCutoffTime: lastCandle?.time ?? 0,
      observedAt: asOf,
    });
  } catch {
    // History is an enhancement to the chart, never a reason the desk fails.
  }
  const forward = getForwardSummary(symbol, evaluation.setupType, evaluation.direction);

  // Resolved after the expectancy downgrade above, so the conclusion the user
  // sees reflects the same blockers the raw decision does.
  const unified = resolveUnifiedSignal({
    symbol,
    candles: currentCandles,
    evaluation,
    riskSettings: DEFAULT_RISK_SETTINGS,
  });

  return {
    status: 'ready',
    symbol,
    timeframe: '1d',
    asOf,
    source: 'live',
    evaluation,
    historical,
    forward,
    unified,
    warnings: [],
  };
}

export async function getSignalDesk(symbolRaw: string): Promise<SignalDeskResult> {
  const symbol = symbolRaw.trim().toUpperCase();
  if (!symbol) {
    return unavailableSignalDesk('', 'Invalid symbol.');
  }

  const history = await getDailyHistory(symbol);
  if (history.source !== 'live' || history.candles.length < 250) {
    return {
      status: 'unavailable',
      symbol,
      timeframe: '1d',
      source: 'unavailable',
      evaluation: null,
      historical: null,
      forward: getForwardSummary(symbol),
      unified: null,
      warnings: [history.warning ?? 'Live daily history is unavailable.'],
    };
  }

  const lastBarTime = history.candles[history.candles.length - 1]?.time ?? 0;
  // The unified model version is part of the key: a cached result carries a
  // conclusion produced by a specific resolver, so bumping the resolver has to
  // invalidate it.
  const cacheKey = `${symbol}:${lastBarTime}:${SIGNAL_ENGINE_V2.strategyVersion}:${SIGNAL_ENGINE_V2.executionModelVersion}:${UNIFIED_SIGNAL_MODEL_VERSION}`;

  const cached = signalDeskCache.get(cacheKey);
  const now = Date.now();
  if (cached && now - cached.cachedAt < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = buildSignalDesk(symbol, history);

  if (signalDeskCache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = signalDeskCache.keys().next().value;
    if (oldestKey) signalDeskCache.delete(oldestKey);
  }
  signalDeskCache.set(cacheKey, { key: cacheKey, result, cachedAt: now });

  return result;
}
