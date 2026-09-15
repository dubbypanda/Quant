// One provider-neutral boundary for macro and corporate chart events.
//
// Callers ask for a symbol and a date range and get `ChartEventRecord[]`. They
// never learn that FOMC dates come from an RSS feed, CPI from an HTML table and
// auctions from JSON — that knowledge stays in `services/events/*`, each of
// which is a pure parser with fixture tests.
//
// Every network path degrades to the bundled fallback schedule. A chart that
// cannot reach bls.gov should still be able to plot known FOMC dates, and the
// `provenance` field records which it got.

import type {
  ChartEventKind,
  ChartEventQuery,
  ChartEventRecord,
  EarningsEvent,
} from '../../shared/types';
import { fetchText } from './http';
import { readMarketCache, writeMarketCache } from './marketCache';
import {
  FOMC_CALENDAR_RSS,
  parseFederalReserveCalendar,
} from './events/federalReserve';
import {
  BLS_SCHEDULE_URL,
  parseLaborStatisticsSchedule,
} from './events/laborStatistics';
import {
  BEA_SCHEDULE_URL,
  parseEconomicAnalysisSchedule,
} from './events/economicAnalysis';
import { TREASURY_AUCTION_URL, parseTreasuryAuctions } from './events/treasury';
import { earningsToChartEvents } from './events/earningsAdapter';
import { BUNDLED_MACRO_EVENTS } from './events/bundledSchedule';

const MACRO_CACHE_KEY = 'events/macro-calendar';
const MACRO_CACHE_TTL_MS = 6 * 60 * 60_000;
const FETCH_TIMEOUT_TTL_MS = 60_000;

/** Injectable so adapter tests never touch the network. */
export type EventTextFetcher = (url: string) => Promise<string>;

const defaultTextFetcher: EventTextFetcher = (url) =>
  fetchText(url, { ttlMs: FETCH_TIMEOUT_TTL_MS });

let textFetcher: EventTextFetcher = defaultTextFetcher;

export function setEventFetcherForTests(fetcher: EventTextFetcher | null): void {
  textFetcher = fetcher ?? defaultTextFetcher;
}

/** Earnings are supplied by the caller's own service so there is one source of
 *  truth for them; tests inject a fixture list. */
export type EarningsProvider = (symbol: string) => Promise<EarningsEvent[]>;

let earningsProvider: EarningsProvider = async () => [];

export function setEarningsProvider(provider: EarningsProvider | null): void {
  earningsProvider = provider ?? (async () => []);
}

async function safeParse(
  url: string,
  parse: (text: string) => ChartEventRecord[],
): Promise<ChartEventRecord[]> {
  try {
    return parse(await textFetcher(url));
  } catch {
    // A single failing source must not empty the whole calendar.
    return [];
  }
}

async function fetchMacroEvents(): Promise<ChartEventRecord[]> {
  const [fed, bls, bea, treasury] = await Promise.all([
    safeParse(FOMC_CALENDAR_RSS, parseFederalReserveCalendar),
    safeParse(BLS_SCHEDULE_URL, parseLaborStatisticsSchedule),
    safeParse(BEA_SCHEDULE_URL, parseEconomicAnalysisSchedule),
    safeParse(TREASURY_AUCTION_URL, (text) => {
      try {
        return parseTreasuryAuctions(JSON.parse(text));
      } catch {
        return [];
      }
    }),
  ]);
  return [...fed, ...bls, ...bea, ...treasury];
}

/** Deduplicates by id, preferring a record that has actually occurred over a
 *  scheduled duplicate of the same release. */
export function mergeEventRecords(...groups: ChartEventRecord[][]): ChartEventRecord[] {
  const byId = new Map<string, ChartEventRecord>();
  for (const group of groups) {
    for (const record of group) {
      const existing = byId.get(record.id);
      if (!existing) {
        byId.set(record.id, record);
        continue;
      }
      const incomingIsRicher =
        (record.occurredAt !== null && existing.occurredAt === null) ||
        record.values.length > existing.values.length ||
        (existing.provenance === 'sample' && record.provenance === 'live');
      if (incomingIsRicher) byId.set(record.id, record);
    }
  }
  return [...byId.values()].sort(
    (a, b) => Date.parse(a.scheduledAt) - Date.parse(b.scheduledAt),
  );
}

export function filterEventRecords(
  records: ChartEventRecord[],
  from: string,
  to: string,
  kinds?: ChartEventKind[],
): ChartEventRecord[] {
  const fromStamp = Date.parse(from);
  const toStamp = Date.parse(to);
  const allowed = kinds && kinds.length ? new Set(kinds) : null;
  return records.filter((record) => {
    if (allowed && !allowed.has(record.kind)) return false;
    const stamp = Date.parse(record.occurredAt ?? record.scheduledAt);
    if (!Number.isFinite(stamp)) return false;
    if (Number.isFinite(fromStamp) && stamp < fromStamp) return false;
    // `to` is an inclusive date, so the whole day counts.
    if (Number.isFinite(toStamp) && stamp > toStamp + 24 * 60 * 60_000) return false;
    return true;
  });
}

/**
 * Macro calendar, cached persistently for six hours.
 *
 * Macro dates change rarely and the sources are slow, so this is the one place
 * a long TTL is right. The bundled schedule is merged in underneath, never over
 * the top: a live record supersedes a bundled one with the same id.
 */
export async function getMacroEvents(now = Date.now()): Promise<ChartEventRecord[]> {
  const cached = readMarketCache<ChartEventRecord[]>(MACRO_CACHE_KEY, undefined, now);
  if (cached && !cached.stale && Array.isArray(cached.value)) {
    return mergeEventRecords(BUNDLED_MACRO_EVENTS, cached.value);
  }
  const fetched = await fetchMacroEvents();
  if (fetched.length) {
    writeMarketCache(MACRO_CACHE_KEY, fetched, MACRO_CACHE_TTL_MS, 'live');
    return mergeEventRecords(BUNDLED_MACRO_EVENTS, fetched);
  }
  // Nothing fetched: a stale cache still beats the bundled set alone.
  if (cached && Array.isArray(cached.value)) {
    return mergeEventRecords(BUNDLED_MACRO_EVENTS, cached.value);
  }
  return mergeEventRecords(BUNDLED_MACRO_EVENTS);
}

export async function getChartEvents(query: ChartEventQuery): Promise<ChartEventRecord[]> {
  const symbol = query.symbol.trim().toUpperCase();
  const [macro, earnings] = await Promise.all([
    getMacroEvents().catch(() => mergeEventRecords(BUNDLED_MACRO_EVENTS)),
    symbol ? earningsProvider(symbol).catch(() => [] as EarningsEvent[]) : Promise.resolve([]),
  ]);
  const merged = mergeEventRecords(macro, earningsToChartEvents(earnings));
  return filterEventRecords(merged, query.from, query.to, query.kinds);
}
