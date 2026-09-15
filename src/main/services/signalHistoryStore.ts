// Immutable signal history for chart markers.
//
// The contract this store exists to keep: a marker drawn on a 2024 bar shows
// what the model said in 2024. So records are append-only and never rewritten
// from today's engine — `appendSignalSnapshot` refuses to modify an existing
// id, and only the forward `outcome` block may be filled in later, because an
// outcome is a fact learned after the fact rather than a revision of the
// original claim.
//
// Renderer code can read but never write: history writes stay main-process
// internal so a renderer cannot forge a historical signal.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { HistoricalSignalSnapshot } from '../../shared/types';
import type { SignalCoreEvaluation } from '../../shared/signalV2';
import { readAllOutcomeRecords, type ForwardSignalRecord } from './signalOutcomeStore';

export const SIGNAL_HISTORY_SCHEMA_VERSION = 3;
export const SIGNAL_HISTORY_FILE = 'quant-signal-history-v3.json';
const MAX_RECORDS = 20_000;

export interface SignalHistoryFileV3 {
  schemaVersion: typeof SIGNAL_HISTORY_SCHEMA_VERSION;
  updatedAt: string;
  /** Set once the v2 import has run, so it cannot run twice and duplicate ids. */
  migratedFrom?: { source: 'quant-signal-outcomes-v1'; migratedAt: string; imported: number };
  records: HistoricalSignalSnapshot[];
}

function defaultPath(): string {
  return path.join(app.getPath('userData'), SIGNAL_HISTORY_FILE);
}

function emptyFile(): SignalHistoryFileV3 {
  return {
    schemaVersion: SIGNAL_HISTORY_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    records: [],
  };
}

function isSnapshot(value: unknown): value is HistoricalSignalSnapshot {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<HistoricalSignalSnapshot>;
  return (
    typeof r.id === 'string' &&
    typeof r.symbol === 'string' &&
    typeof r.signalBarTime === 'number' &&
    typeof r.observedAt === 'string' &&
    typeof r.modelName === 'string' &&
    typeof r.strategyVersion === 'string' &&
    typeof r.decision === 'string' &&
    typeof r.setupType === 'string' &&
    typeof r.direction === 'string' &&
    typeof r.setupQuality === 'number' &&
    typeof r.dataCutoffTime === 'number' &&
    (r.source === 'forward-observed' || r.source === 'imported-v2') &&
    Array.isArray(r.noTradeReasons)
  );
}

export function readSignalHistoryFile(filePath = defaultPath()): SignalHistoryFileV3 {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyFile();
    const file = parsed as Partial<SignalHistoryFileV3>;
    if (file.schemaVersion !== SIGNAL_HISTORY_SCHEMA_VERSION) return emptyFile();
    return {
      schemaVersion: SIGNAL_HISTORY_SCHEMA_VERSION,
      updatedAt: typeof file.updatedAt === 'string' ? file.updatedAt : new Date().toISOString(),
      migratedFrom: file.migratedFrom,
      records: Array.isArray(file.records) ? file.records.filter(isSnapshot) : [],
    };
  } catch {
    return emptyFile();
  }
}

function writeSignalHistoryFile(file: SignalHistoryFileV3, filePath = defaultPath()): void {
  const records = [...file.records].sort((a, b) => a.signalBarTime - b.signalBarTime);
  const next: SignalHistoryFileV3 = {
    ...file,
    updatedAt: new Date().toISOString(),
    // Oldest-first pruning: the visible chart range is usually recent, and a
    // marker that falls off the far left is the least costly to lose.
    records: records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, filePath);
}

/** Deterministic id: one snapshot per symbol, model and signal bar. */
export function snapshotId(
  symbol: string,
  strategyVersion: string,
  signalBarTime: number,
): string {
  return `${symbol.trim().toUpperCase()}:${strategyVersion}:${signalBarTime}`;
}

export interface AppendSignalSnapshotArgs {
  evaluation: SignalCoreEvaluation;
  /** Latest bar the evaluation could see. */
  dataCutoffTime: number;
  modelName?: string;
  observedAt?: string;
}

/**
 * Records a snapshot if one does not already exist for this bar.
 *
 * Returns the existing record unchanged when it does. This is the immutability
 * guarantee: a later run of a newer model cannot overwrite what an older model
 * said about the same bar.
 */
export function appendSignalSnapshot(
  args: AppendSignalSnapshotArgs,
  filePath = defaultPath(),
): HistoricalSignalSnapshot {
  const { evaluation } = args;
  const symbol = evaluation.symbol.trim().toUpperCase();
  const id = snapshotId(symbol, evaluation.strategyVersion, evaluation.signalBarTime);
  const file = readSignalHistoryFile(filePath);
  const existing = file.records.find((record) => record.id === id);
  if (existing) return existing;

  const snapshot: HistoricalSignalSnapshot = {
    id,
    symbol,
    signalBarTime: evaluation.signalBarTime,
    observedAt: args.observedAt ?? new Date().toISOString(),
    modelName: args.modelName ?? 'Signal Engine V2',
    strategyVersion: evaluation.strategyVersion,
    decision: evaluation.decision,
    setupType: evaluation.setupType,
    direction: evaluation.direction,
    setupQuality: evaluation.setupQuality,
    entry: Number.isFinite(evaluation.risk.entry) ? evaluation.risk.entry : null,
    stop: Number.isFinite(evaluation.risk.stop) ? evaluation.risk.stop : null,
    target1: Number.isFinite(evaluation.risk.target1) ? evaluation.risk.target1 : null,
    target2: Number.isFinite(evaluation.risk.target2) ? evaluation.risk.target2 : null,
    noTradeReasons: [...evaluation.noTradeReasons],
    dataCutoffTime: args.dataCutoffTime,
    source: 'forward-observed',
  };
  writeSignalHistoryFile({ ...file, records: [...file.records, snapshot] }, filePath);
  return snapshot;
}

/**
 * Attaches a resolved forward outcome.
 *
 * Only the `outcome` block is writable after the fact, and only for a record
 * that exists. Every field describing what the model claimed stays frozen.
 */
export function attachSignalOutcome(
  id: string,
  outcome: NonNullable<HistoricalSignalSnapshot['outcome']>,
  filePath = defaultPath(),
): HistoricalSignalSnapshot | null {
  const file = readSignalHistoryFile(filePath);
  const index = file.records.findIndex((record) => record.id === id);
  if (index < 0) return null;
  const updated: HistoricalSignalSnapshot = { ...file.records[index], outcome };
  const records = [...file.records];
  records[index] = updated;
  writeSignalHistoryFile({ ...file, records }, filePath);
  return updated;
}

export function getSignalHistory(
  symbolRaw: string,
  from?: number,
  to?: number,
  filePath = defaultPath(),
): HistoricalSignalSnapshot[] {
  const symbol = symbolRaw.trim().toUpperCase();
  return readSignalHistoryFile(filePath)
    .records.filter((record) => {
      if (symbol && record.symbol !== symbol) return false;
      if (typeof from === 'number' && record.signalBarTime < from) return false;
      if (typeof to === 'number' && record.signalBarTime > to) return false;
      return true;
    })
    .sort((a, b) => a.signalBarTime - b.signalBarTime);
}

/** Maps a v2 forward record's status onto the v3 outcome vocabulary. */
function outcomeFromV2(
  record: ForwardSignalRecord,
): HistoricalSignalSnapshot['outcome'] | undefined {
  if (record.status === 'resolved') {
    const status =
      record.exitReason === 'target1'
        ? 'target'
        : record.exitReason === 'stop'
          ? 'stop'
          : 'timeout';
    return {
      status,
      netR: typeof record.netR === 'number' ? record.netR : null,
      resolvedAt: record.resolvedAt ?? null,
    };
  }
  if (record.status === 'skipped') {
    return { status: 'invalidated', netR: null, resolvedAt: record.resolvedAt ?? null };
  }
  return { status: 'open', netR: null, resolvedAt: null };
}

export interface SignalHistoryMigrationResult {
  ran: boolean;
  imported: number;
  skipped: number;
  reason?: string;
}

/**
 * One-time import of v2 forward outcome records.
 *
 * Guarded by the `migratedFrom` marker: running it twice imports nothing the
 * second time. Ids are derived the same way as native records, so even without
 * the marker a re-run would collide rather than duplicate — belt and braces,
 * because a duplicated marker is visible to the user and hard to explain.
 *
 * Imported records are marked `source: 'imported-v2'` and invent no fields the
 * v2 record did not have: `target2` is null because v2 never stored it, and
 * `dataCutoffTime` falls back to the signal bar because v2 did not record a
 * cutoff.
 */
export function migrateV2SignalOutcomes(
  historyPath = defaultPath(),
  v2Path?: string,
): SignalHistoryMigrationResult {
  const file = readSignalHistoryFile(historyPath);
  if (file.migratedFrom) {
    return { ran: false, imported: 0, skipped: 0, reason: 'Migration has already run.' };
  }

  let v2Records: ForwardSignalRecord[];
  try {
    v2Records = v2Path ? readAllOutcomeRecords(v2Path) : readAllOutcomeRecords();
  } catch {
    v2Records = [];
  }

  const existingIds = new Set(file.records.map((record) => record.id));
  const imported: HistoricalSignalSnapshot[] = [];
  let skipped = 0;

  for (const record of v2Records) {
    const id = snapshotId(record.symbol, record.strategyVersion, record.signalBarTime);
    if (existingIds.has(id)) {
      skipped += 1;
      continue;
    }
    existingIds.add(id);
    imported.push({
      id,
      symbol: record.symbol.trim().toUpperCase(),
      signalBarTime: record.signalBarTime,
      observedAt: record.observedAt,
      modelName: 'Signal Engine V2',
      strategyVersion: record.strategyVersion,
      decision: record.direction === 'long' ? 'buy-candidate' : 'short-candidate',
      setupType: record.setupType,
      direction: record.direction,
      setupQuality: record.setupQuality,
      entry: null,
      stop: Number.isFinite(record.plannedStop) ? record.plannedStop : null,
      target1: Number.isFinite(record.plannedTarget1) ? record.plannedTarget1 : null,
      target2: null,
      noTradeReasons: [],
      dataCutoffTime: record.signalBarTime,
      source: 'imported-v2',
      outcome: outcomeFromV2(record),
    });
  }

  writeSignalHistoryFile(
    {
      ...file,
      records: [...file.records, ...imported],
      migratedFrom: {
        source: 'quant-signal-outcomes-v1',
        migratedAt: new Date().toISOString(),
        imported: imported.length,
      },
    },
    historyPath,
  );

  return { ran: true, imported: imported.length, skipped };
}
