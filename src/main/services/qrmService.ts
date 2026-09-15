// QRM compute service: a small worker pool plus persistence.
//
// Heavy compute runs only for an explicit research request or a small
// discovery shortlist — never as a prerequisite for opening a ticker. That is
// a hard constraint from docs/quant-v3/05, and the reason nothing in this file
// is wired into the chart's normal load path.

import { app } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import type { Candle } from '../../shared/types';
import type { QrmConfig, QrmForecastSnapshot, ResearchModelView } from '../../shared/qrm';
import {
  DEFAULT_QRM_CONFIG,
  QRM_MINIMUM_HISTORY_BARS,
  buildQrmForecast,
  type QrmForecastResult,
} from '../../shared/qrmForecast';
import { QRM_PATH_COUNTS } from '../../shared/qrmBootstrap';
import { decideQrm } from '../../shared/qrmDecision';
import { qrmResearchView } from '../../shared/kronosDistribution';
import { getDailyHistory } from './dailyHistory';
import type { QrmWorkerJob, QrmWorkerResponse } from '../workers/qrmWorker';

export const QRM_STORE_DIR = 'qrm-v3';
const FORECAST_RETENTION_DAYS = 30;
const BENCHMARK_SUMMARY_FILE = 'benchmark-summary.json';
const BENCHMARK_SUMMARY_DIR = QRM_STORE_DIR;

export type QrmMode = 'discovery' | 'research' | 'lab';

export interface QrmRunRequest {
  symbol: string;
  mode: QrmMode;
  configOverride?: Partial<QrmConfig>;
}

export interface QrmProgress {
  symbol: string;
  jobId: string;
  completed: number;
  total: number;
}

let rootOverride: string | null = null;

export function setQrmRoot(root: string | null): void {
  rootOverride = root;
}

function storeRoot(): string {
  return path.join(rootOverride ?? app.getPath('userData'), QRM_STORE_DIR);
}

function forecastPath(symbol: string, snapshotId: string): string {
  const safeSymbol = symbol.replace(/[^A-Za-z0-9._-]/g, '_');
  const safeId = snapshotId.replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(storeRoot(), 'forecasts', safeSymbol, `${safeId}.json.gz`);
}

/** Only successful snapshots are stored: a failed or incomplete job must never
 *  be readable as a forecast. */
export function saveQrmSnapshot(snapshot: QrmForecastSnapshot): void {
  try {
    const filePath = forecastPath(snapshot.symbol, snapshot.id);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const payload = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8'));
    fs.writeFileSync(`${filePath}.tmp`, payload);
    fs.renameSync(`${filePath}.tmp`, filePath);
  } catch {
    /* a research forecast that fails to persist is still usable in-session */
  }
}

export function readQrmSnapshot(symbol: string, snapshotId: string): QrmForecastSnapshot | null {
  try {
    const raw = zlib.gunzipSync(fs.readFileSync(forecastPath(symbol, snapshotId)));
    return JSON.parse(raw.toString('utf8')) as QrmForecastSnapshot;
  } catch {
    return null;
  }
}

export function listQrmSnapshots(symbol: string): string[] {
  try {
    const dir = path.dirname(forecastPath(symbol, 'x'));
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.json.gz'))
      .sort();
  } catch {
    return [];
  }
}

export function pruneQrmForecasts(retentionDays = FORECAST_RETENTION_DAYS): number {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
  let removed = 0;
  const forecastsDir = path.join(storeRoot(), 'forecasts');
  try {
    for (const symbol of fs.readdirSync(forecastsDir)) {
      const dir = path.join(forecastsDir, symbol);
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try {
          if (name.endsWith('.tmp') || fs.statSync(full).mtimeMs < cutoff) {
            fs.rmSync(full, { force: true });
            removed += 1;
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch {
    /* nothing stored yet */
  }
  return removed;
}

export function saveBenchmarkSummary(summary: unknown): void {
  try {
    const dir = path.join(rootOverride ?? app.getPath('userData'), BENCHMARK_SUMMARY_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, BENCHMARK_SUMMARY_FILE);
    fs.writeFileSync(`${filePath}.tmp`, JSON.stringify(summary, null, 2));
    fs.renameSync(`${filePath}.tmp`, filePath);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------
// Worker pool
// ---------------------------------------------------------------------------

function poolSize(): number {
  return Math.max(1, Math.min(4, os.cpus().length - 1));
}

interface PendingJob {
  job: QrmWorkerJob;
  resolve: (result: QrmForecastResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: QrmProgress) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  current: PendingJob | null;
}

let pool: PoolWorker[] = [];
const queue: PendingJob[] = [];
let workerScriptPath: string | null = null;

/** Set by main after the build output path is known. When absent, jobs run
 *  inline — which is what makes this testable without a bundled worker. */
export function setQrmWorkerScript(scriptPath: string | null): void {
  workerScriptPath = scriptPath;
}

function spawnWorker(): PoolWorker | null {
  if (!workerScriptPath) return null;
  try {
    const worker = new Worker(workerScriptPath);
    const entry: PoolWorker = { worker, busy: false, current: null };
    worker.on('message', (message: QrmWorkerResponse) => {
      const pending = entry.current;
      if (!pending || pending.job.jobId !== message.jobId) return;
      if (message.type === 'progress') {
        pending.onProgress?.({
          symbol: pending.job.symbol,
          jobId: message.jobId,
          completed: message.completed,
          total: message.total,
        });
        return;
      }
      entry.busy = false;
      entry.current = null;
      if (message.type === 'result') pending.resolve(message.result);
      else pending.reject(new Error(message.message));
      drainQueue();
    });
    worker.on('error', (error) => {
      const pending = entry.current;
      entry.current = null;
      entry.busy = false;
      // A crashed worker fails only its own job and is replaced.
      pending?.reject(error instanceof Error ? error : new Error('The QRM worker crashed.'));
      pool = pool.filter((item) => item !== entry);
      const replacement = spawnWorker();
      if (replacement) pool.push(replacement);
      drainQueue();
    });
    worker.on('exit', () => {
      pool = pool.filter((item) => item !== entry);
    });
    return entry;
  } catch {
    return null;
  }
}

function drainQueue(): void {
  while (queue.length) {
    const idle = pool.find((entry) => !entry.busy);
    if (!idle) return;
    const pending = queue.shift();
    if (!pending) return;
    idle.busy = true;
    idle.current = pending;
    idle.worker.postMessage({ type: 'job', job: pending.job });
  }
}

function pathsFor(mode: QrmMode): number {
  return mode === 'lab'
    ? QRM_PATH_COUNTS.lab
    : mode === 'research'
      ? QRM_PATH_COUNTS.research
      : QRM_PATH_COUNTS.discovery;
}

export interface QrmRunOutcome {
  status: 'ready' | 'unavailable';
  snapshot: QrmForecastSnapshot | null;
  reason?: string;
  warnings: string[];
  view: ResearchModelView | null;
}

/**
 * Runs QRM for one symbol.
 *
 * Falls back to inline computation when no worker script is configured. That is
 * a deliberate capability rather than a stub: it keeps the service usable in
 * tests and in a packaging configuration where the worker bundle is missing,
 * at the cost of blocking the main thread for that one job.
 */
export async function runQrm(
  request: QrmRunRequest,
  onProgress?: (progress: QrmProgress) => void,
  loaders?: {
    history?: (symbol: string) => Promise<Candle[]>;
    benchmark?: () => Promise<Candle[]>;
  },
): Promise<QrmRunOutcome> {
  const symbol = request.symbol.trim().toUpperCase();
  const config: Partial<QrmConfig> = {
    ...DEFAULT_QRM_CONFIG,
    paths: pathsFor(request.mode),
    ...request.configOverride,
  };

  const loadHistory =
    loaders?.history ??
    (async (target: string) => (await getDailyHistory(target)).candles);
  const loadBenchmark = loaders?.benchmark ?? (async () => (await getDailyHistory('SPY')).candles);

  const [candles, spyCandles] = await Promise.all([loadHistory(symbol), loadBenchmark()]);

  if (candles.length < QRM_MINIMUM_HISTORY_BARS) {
    return {
      status: 'unavailable',
      snapshot: null,
      reason: `QRM needs ${QRM_MINIMUM_HISTORY_BARS} completed daily bars; ${candles.length} are available.`,
      warnings: [],
      view: null,
    };
  }

  const jobId = `${symbol}:${Date.now()}`;
  const job: QrmWorkerJob = { jobId, symbol, candles, spyCandles, config };

  let result: QrmForecastResult;
  if (workerScriptPath) {
    if (!pool.length) {
      for (let i = 0; i < poolSize(); i++) {
        const worker = spawnWorker();
        if (worker) pool.push(worker);
      }
    }
    result = await new Promise<QrmForecastResult>((resolve, reject) => {
      queue.push({ job, resolve, reject, onProgress });
      drainQueue();
    });
  } else {
    result = buildQrmForecast({
      symbol,
      candles,
      spyCandles,
      config,
      onProgress: (completed, total) => onProgress?.({ symbol, jobId, completed, total }),
    });
  }

  if (result.status !== 'ready' || !result.snapshot) {
    return {
      status: 'unavailable',
      snapshot: null,
      reason: result.reason,
      warnings: result.warnings,
      view: null,
    };
  }

  saveQrmSnapshot(result.snapshot);

  // The decision layer is rendered through the neutral research view, which
  // says "experimental" in every label.
  const primary = result.snapshot.distributions[0] ?? null;
  const view = qrmResearchView(
    result.snapshot.config.modelVersion,
    decideQrm(primary),
  );

  return {
    status: 'ready',
    snapshot: result.snapshot,
    warnings: result.warnings,
    view,
  };
}

export async function shutdownQrmPool(): Promise<void> {
  const workers = [...pool];
  pool = [];
  queue.length = 0;
  await Promise.all(workers.map((entry) => entry.worker.terminate()));
}
