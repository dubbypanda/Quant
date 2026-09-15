// Persistent forward outcome store for Signal Engine V2.
// Persists emitted candidate snapshots atomically and resolves outcomes
// strictly against subsequent trading bars using the shared ExecutionSimulator.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Candle } from '../../shared/types';
import type {
  MarketRegime,
  SetupType,
  TradeDirection,
} from '../../shared/quant';
import type {
  ForwardRecordSummary,
} from '../../shared/signalV2';
import { SIGNAL_ENGINE_V2 } from '../../shared/signalV2';
import { simulateTrade } from '../../shared/executionSimulator';
import {
  calculateBootstrapExpectancyCi,
  mean,
  round,
} from '../../shared/signalStatistics';

export type ForwardSignalStatus =
  | 'pending-entry'
  | 'active'
  | 'resolved'
  | 'skipped';

export interface ForwardSignalRecord {
  id: string;
  schemaVersion: 1;
  symbol: string;
  strategyVersion: string;
  executionModelVersion: string;
  timeframe: '1d';
  setupType: SetupType;
  direction: Exclude<TradeDirection, 'none'>;
  regime: MarketRegime;
  signalBarTime: number;
  observedAt: string;
  setupQuality: number;
  plannedStop: number;
  plannedTarget1: number;
  status: ForwardSignalStatus;
  entryTime?: number;
  entryFill?: number;
  exitTime?: number;
  exitFill?: number;
  exitReason?: 'target1' | 'stop' | 'timeout';
  netR?: number;
  resolvedAt?: string;
  skippedReason?: string;
}

const MAX_STORED_RECORDS = 5000;

function storePath(): string {
  return path.join(app.getPath('userData'), 'quant-signal-outcomes-v1.json');
}

function isRecord(value: unknown): value is ForwardSignalRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<ForwardSignalRecord>;
  return (
    typeof r.id === 'string' &&
    r.schemaVersion === 1 &&
    typeof r.symbol === 'string' &&
    typeof r.strategyVersion === 'string' &&
    typeof r.executionModelVersion === 'string' &&
    r.timeframe === '1d' &&
    typeof r.setupType === 'string' &&
    (r.direction === 'long' || r.direction === 'short') &&
    typeof r.regime === 'string' &&
    typeof r.signalBarTime === 'number' &&
    typeof r.observedAt === 'string' &&
    typeof r.setupQuality === 'number' &&
    typeof r.plannedStop === 'number' &&
    typeof r.plannedTarget1 === 'number' &&
    typeof r.status === 'string'
  );
}

export function readAllOutcomeRecords(filePath = storePath()): ForwardSignalRecord[] {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

export function writeAllOutcomeRecords(
  records: ForwardSignalRecord[],
  filePath = storePath(),
): void {
  // Prune: keep all unresolved records, prune oldest resolved records if over limit
  let pruned = records;
  if (records.length > MAX_STORED_RECORDS) {
    const unresolved = records.filter((r) => r.status !== 'resolved' && r.status !== 'skipped');
    const resolved = records.filter((r) => r.status === 'resolved' || r.status === 'skipped');
    const keepCount = Math.max(0, MAX_STORED_RECORDS - unresolved.length);
    // Sort explicitly: a previous prune already rewrote the file as
    // [unresolved..., resolved...], so array position no longer tracks age and
    // slicing the tail would have discarded the newest records.
    const keptResolved = [...resolved]
      .sort((a, b) => a.signalBarTime - b.signalBarTime)
      .slice(-keepCount);
    pruned = [...unresolved, ...keptResolved].sort((a, b) => a.signalBarTime - b.signalBarTime);
  }

  const temp = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temp, JSON.stringify(pruned, null, 2));
  fs.renameSync(temp, filePath);
}

export function recordCurrentSignalIfNeeded(
  evaluation: import('../../shared/signalV2').SignalCoreEvaluation,
  candles: Candle[],
  filePath = storePath(),
): ForwardSignalRecord | null {
  if (
    evaluation.decision !== 'buy-candidate' &&
    evaluation.decision !== 'short-candidate'
  ) {
    return null;
  }
  if (evaluation.direction !== 'long' && evaluation.direction !== 'short') {
    return null;
  }

  const lastCandle = candles[candles.length - 1];
  if (!lastCandle) return null;

  const symbol = evaluation.symbol.trim().toUpperCase();
  const id = `${symbol}:${evaluation.strategyVersion}:${lastCandle.time}`;

  const all = readAllOutcomeRecords(filePath);
  const existing = all.find((r) => r.id === id);
  if (existing) {
    return existing;
  }

  const newRecord: ForwardSignalRecord = {
    id,
    schemaVersion: 1,
    symbol,
    strategyVersion: evaluation.strategyVersion,
    executionModelVersion: SIGNAL_ENGINE_V2.executionModelVersion,
    timeframe: '1d',
    setupType: evaluation.setupType,
    direction: evaluation.direction,
    regime: evaluation.regime,
    signalBarTime: lastCandle.time,
    observedAt: new Date().toISOString(),
    setupQuality: evaluation.setupQuality,
    plannedStop: evaluation.risk.stop,
    plannedTarget1: evaluation.risk.target1,
    status: 'pending-entry',
  };

  writeAllOutcomeRecords([...all, newRecord], filePath);
  return newRecord;
}

export function evaluatePendingForwardSignals(
  symbolRaw: string,
  candles: Candle[],
  filePath = storePath(),
): void {
  const symbol = symbolRaw.trim().toUpperCase();
  const all = readAllOutcomeRecords(filePath);
  let modified = false;

  for (const record of all) {
    if (record.symbol !== symbol) continue;
    if (record.status !== 'pending-entry' && record.status !== 'active') continue;

    const signalIdx = candles.findIndex((c) => c.time === record.signalBarTime);
    if (signalIdx < 0 || signalIdx >= candles.length - 1) {
      continue; // No subsequent bars available yet
    }

    const signalCandle = candles[signalIdx];
    const subsequentCandles = candles.slice(signalIdx + 1);

    const result = simulateTrade({
      signalIndex: signalIdx,
      signalCandle,
      subsequentCandles,
      setupType: record.setupType,
      direction: record.direction,
      regime: record.regime,
      plannedStop: record.plannedStop,
      plannedTarget1: record.plannedTarget1,
    });

    if (!result) {
      // Trade is active (entered but not yet stopped, targeted, or timed out)
      if (record.status !== 'active') {
        record.status = 'active';
        record.entryTime = subsequentCandles[0].time;
        modified = true;
      }
      continue;
    }

    if (result.kind === 'skipped') {
      record.status = 'skipped';
      record.skippedReason = result.skipped.reason;
      record.resolvedAt = new Date().toISOString();
      modified = true;
    } else if (result.kind === 'trade') {
      record.status = 'resolved';
      record.entryTime = result.trade.entryTime;
      record.entryFill = result.trade.entryFill;
      record.exitTime = result.trade.exitTime;
      record.exitFill = result.trade.exitFill;
      record.exitReason = result.trade.exitReason;
      record.netR = round(result.trade.netR, 2);
      record.resolvedAt = new Date(result.trade.exitTime * 1000).toISOString();
      modified = true;
    }
  }

  if (modified) {
    writeAllOutcomeRecords(all, filePath);
  }
}

export function getForwardSummary(
  symbolRaw?: string,
  setupType?: SetupType,
  direction?: TradeDirection,
  filePath = storePath(),
): ForwardRecordSummary {
  const all = readAllOutcomeRecords(filePath);
  const symbol = symbolRaw?.trim().toUpperCase();

  const matching = all.filter((r) => {
    if (symbol && r.symbol !== symbol) return false;
    if (setupType && r.setupType !== setupType) return false;
    if (direction && direction !== 'none' && r.direction !== direction) return false;
    return true;
  });

  const resolved = matching.filter((r) => r.status === 'resolved');
  const active = matching.filter((r) => r.status === 'active' || r.status === 'pending-entry');

  const targetHits = resolved.filter((r) => r.exitReason === 'target1').length;
  const stopHits = resolved.filter((r) => r.exitReason === 'stop').length;
  const timeouts = resolved.filter((r) => r.exitReason === 'timeout').length;

  const wins = resolved.filter((r) => (r.netR ?? 0) > 0);
  const losses = resolved.filter((r) => (r.netR ?? 0) < 0);

  const winRatePercent =
    resolved.length > 0 ? round((wins.length / resolved.length) * 100, 1) : null;
  const expectancyR =
    resolved.length > 0 ? round(mean(resolved.map((r) => r.netR ?? 0)), 2) : null;

  const grossProfitR = wins.reduce((sum, r) => sum + (r.netR ?? 0), 0);
  const grossLossR = Math.abs(losses.reduce((sum, r) => sum + (r.netR ?? 0), 0));
  const profitFactor =
    resolved.length > 0
      ? grossLossR > 0
        ? round(Math.min(99, grossProfitR / grossLossR), 2)
        : grossProfitR > 0
          ? 99
          : 0
      : null;

  const seedKey = `forward:${symbol ?? 'all'}:${setupType ?? 'all'}:${direction ?? 'all'}`;
  const expectancyCi95 =
    resolved.length >= 10
      ? calculateBootstrapExpectancyCi(
          resolved.map((r) => r.netR ?? 0),
          seedKey,
        )
      : null;

  // Reduced over the values rather than read off the ends of the array: record
  // order is not chronological once the store has been pruned or reloaded.
  const observedTimes = matching
    .map((r) => r.observedAt)
    .filter((value): value is string => Boolean(value));
  const resolvedTimes = resolved
    .map((r) => r.resolvedAt)
    .filter((value): value is string => Boolean(value));
  const firstSignalAt = observedTimes.length
    ? observedTimes.reduce((min, value) => (value < min ? value : min))
    : undefined;
  const lastResolvedAt = resolvedTimes.length
    ? resolvedTimes.reduce((max, value) => (value > max ? value : max))
    : undefined;

  return {
    resolvedSignals: resolved.length,
    activeSignals: active.length,
    targetHits,
    stopHits,
    timeouts,
    winRatePercent,
    expectancyR,
    profitFactor,
    expectancyCi95,
    firstSignalAt,
    lastResolvedAt,
  };
}
