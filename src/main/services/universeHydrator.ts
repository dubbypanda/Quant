// Background universe hydration.
//
// Discovery is only cheap if daily history is already local, so this job walks
// the universe filling the Plan 01 persistent cache. It is an app-runtime
// background job — it exists only while Quant runs, and there is no cloud
// component.
//
// Ordering is deliberate: portfolio and watchlist symbols first, then symbols
// whose cache is missing or stale, then the rest. A user who opens the app and
// immediately looks at what they own should not wait behind three thousand
// alphabetically-earlier tickers.
//
// Progress persists, so a restart resumes rather than beginning at symbol zero.

import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { UniverseHydrationStatus } from '../../shared/discovery';
import { PREFERRED_HISTORY_BARS } from '../../shared/discovery';
import { getDailyHistory } from './dailyHistory';
import { getPortfolioDocument } from './portfolioStore';
import { getWatchlist } from './watchlistStore';
import { getSymbolDirectory } from './dataFiles';

export const HYDRATION_PROGRESS_FILE = 'discovery-hydration-v3.json';
const DEFAULT_CONCURRENCY = 6;
const MIN_CONCURRENCY = 2;
const MAX_CONCURRENCY = 10;
const BATCH_PAUSE_MS = 150;
/** Base for the exponential backoff on a repeatedly failing symbol. */
const FAILURE_BACKOFF_BASE_MS = 60_000;
const MAX_FAILURE_BACKOFF_MS = 6 * 60 * 60_000;

interface FailureRecord {
  attempts: number;
  lastAttemptAt: number;
}

interface HydrationProgress {
  schemaVersion: 1;
  completedSymbols: string[];
  failures: Record<string, FailureRecord>;
  updatedAt: string;
}

let rootOverride: string | null = null;

export function setHydrationRoot(root: string | null): void {
  rootOverride = root;
}

function progressPath(): string {
  return path.join(rootOverride ?? app.getPath('userData'), HYDRATION_PROGRESS_FILE);
}

function emptyProgress(): HydrationProgress {
  return {
    schemaVersion: 1,
    completedSymbols: [],
    failures: {},
    updatedAt: new Date().toISOString(),
  };
}

function readProgress(): HydrationProgress {
  try {
    const parsed = JSON.parse(fs.readFileSync(progressPath(), 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyProgress();
    const candidate = parsed as Partial<HydrationProgress>;
    if (candidate.schemaVersion !== 1) return emptyProgress();
    return {
      schemaVersion: 1,
      completedSymbols: Array.isArray(candidate.completedSymbols)
        ? candidate.completedSymbols.filter((symbol): symbol is string => typeof symbol === 'string')
        : [],
      failures:
        candidate.failures && typeof candidate.failures === 'object'
          ? (candidate.failures as Record<string, FailureRecord>)
          : {},
      updatedAt:
        typeof candidate.updatedAt === 'string' ? candidate.updatedAt : new Date().toISOString(),
    };
  } catch {
    return emptyProgress();
  }
}

function writeProgress(progress: HydrationProgress): void {
  try {
    const filePath = progressPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ ...progress, updatedAt: new Date().toISOString() }));
    fs.renameSync(temp, filePath);
  } catch {
    // Losing progress costs a re-walk, never correctness.
  }
}

let status: UniverseHydrationStatus = {
  running: false,
  total: 0,
  complete: 0,
  current: [],
  failed: 0,
  startedAt: null,
  updatedAt: new Date().toISOString(),
};

let stopRequested = false;
let activeRun: Promise<void> | null = null;
let concurrency = DEFAULT_CONCURRENCY;

export function setHydrationConcurrency(value: number): number {
  concurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, Math.round(value)));
  return concurrency;
}

export function getUniverseHydrationStatus(): UniverseHydrationStatus {
  return { ...status, current: [...status.current] };
}

function touch(patch: Partial<UniverseHydrationStatus>): void {
  status = { ...status, ...patch, updatedAt: new Date().toISOString() };
}

/** Whether a previously failing symbol has served its backoff. */
function isRetryable(failure: FailureRecord | undefined, now: number): boolean {
  if (!failure) return true;
  const delay = Math.min(
    MAX_FAILURE_BACKOFF_MS,
    FAILURE_BACKOFF_BASE_MS * 2 ** Math.max(0, failure.attempts - 1),
  );
  return now - failure.lastAttemptAt >= delay;
}

/** Priority symbols come first: what the user owns, then what they watch. */
function prioritySymbols(): string[] {
  const out: string[] = [];
  try {
    for (const lot of getPortfolioDocument().lots) out.push(lot.symbol.toUpperCase());
  } catch {
    /* an unreadable portfolio must not stop hydration */
  }
  try {
    for (const item of getWatchlist()) out.push(item.symbol.toUpperCase());
  } catch {
    /* likewise */
  }
  return [...new Set(out)];
}

export function buildHydrationQueue(): string[] {
  const directory = getSymbolDirectory();
  const universe = directory
    .filter((entry) => entry.exchange === 'NASDAQ' || entry.exchange === 'NYSE' || entry.exchange === 'NYSEArca')
    .map((entry) => entry.symbol.toUpperCase());

  const progress = readProgress();
  const completed = new Set(progress.completedSymbols);
  const now = Date.now();

  const priority = prioritySymbols().filter((symbol) => universe.includes(symbol));
  const prioritySet = new Set(priority);

  const remaining = universe.filter(
    (symbol) =>
      !prioritySet.has(symbol) &&
      !completed.has(symbol) &&
      isRetryable(progress.failures[symbol], now),
  );
  const alreadyDone = universe.filter(
    (symbol) => !prioritySet.has(symbol) && completed.has(symbol),
  );

  // Priority first, then never-hydrated, then a refresh pass over the rest.
  return [...priority, ...remaining, ...alreadyDone];
}

async function hydrateSymbol(symbol: string): Promise<boolean> {
  const history = await getDailyHistory(symbol);
  // "Hydrated" means enough bars to compute features, from live data. A sample
  // fallback is not hydration: it would let discovery rank synthetic history.
  return history.source === 'live' && history.candles.length >= PREFERRED_HISTORY_BARS - 20;
}

/**
 * Walks the queue in bounded, deterministic batches.
 *
 * A single symbol's failure is recorded and stepped over; it can never stop the
 * batch, because one delisted ticker would otherwise halt discovery for the
 * whole universe.
 */
export async function startUniverseHydration(): Promise<void> {
  if (activeRun) return activeRun;
  stopRequested = false;

  activeRun = (async () => {
    const queue = buildHydrationQueue();
    const progress = readProgress();
    const completed = new Set(progress.completedSymbols);

    touch({
      running: true,
      total: queue.length,
      complete: 0,
      failed: Object.keys(progress.failures).length,
      startedAt: new Date().toISOString(),
      current: [],
    });

    let processed = 0;
    for (let index = 0; index < queue.length && !stopRequested; index += concurrency) {
      const batch = queue.slice(index, index + concurrency);
      touch({ current: batch });

      const results = await Promise.all(
        batch.map(async (symbol) => {
          try {
            return { symbol, ok: await hydrateSymbol(symbol) };
          } catch {
            return { symbol, ok: false };
          }
        }),
      );

      for (const result of results) {
        processed += 1;
        if (result.ok) {
          completed.add(result.symbol);
          delete progress.failures[result.symbol];
        } else {
          const existing = progress.failures[result.symbol];
          progress.failures[result.symbol] = {
            attempts: (existing?.attempts ?? 0) + 1,
            lastAttemptAt: Date.now(),
          };
        }
      }

      progress.completedSymbols = [...completed];
      writeProgress(progress);
      touch({
        complete: processed,
        failed: Object.keys(progress.failures).length,
      });

      // A pause between batches keeps the main process responsive and stays
      // polite to the upstream provider.
      if (!stopRequested && index + concurrency < queue.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_PAUSE_MS));
      }
    }

    touch({ running: false, current: [] });
  })().finally(() => {
    activeRun = null;
  });

  return activeRun;
}

export function stopUniverseHydration(): void {
  stopRequested = true;
  touch({ running: false, current: [] });
}

/** Symbols with usable local history, for the discovery run to scan. */
export function hydratedSymbols(): string[] {
  return readProgress().completedSymbols;
}

export function hydrationFailureCount(): number {
  return Object.keys(readProgress().failures).length;
}

/** Test seam. */
export function resetHydrationStateForTests(): void {
  stopRequested = false;
  activeRun = null;
  concurrency = DEFAULT_CONCURRENCY;
  status = {
    running: false,
    total: 0,
    complete: 0,
    current: [],
    failed: 0,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  };
}
