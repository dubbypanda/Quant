// Authoritative chart retrieval for Quant 3.0.
//
// Precedence, and the reason for each step:
//   fresh persistent cache            → return immediately, no network
//   stale cache + network success      → fresh network payload
//   stale cache + network failure      → the stale LIVE payload, marked stale
//   no cache + network failure         → sample, visibly labelled 'sample'
//
// A stale live payload beats a synthetic one: it is real data that is merely
// old, and the `cache.stale` flag lets the UI say so. Sample data may never be
// written to the persistent cache, or a later read would hand it back wearing
// live provenance.
//
// No UI timing or React concerns belong in this file.

import type {
  Candle,
  ChartData,
  ChartRange,
  ChartRequest,
  DataSource,
  ExtendedHoursQuote,
} from '../../shared/types';
import {
  classifyUsEquitySession,
  isActiveMarketState,
  US_EQUITY_TIMEZONE,
} from '../../shared/marketSession';
import { yahooResultToCandles } from './chart';
import { readMarketCache, writeMarketCache } from './marketCache';
import { sampleChart } from './sample';
import { extendedHoursQuoteFrom, fetchYahooChart, type YahooChartResult } from './yahoo';

interface RangeSpecV3 {
  yahooRange: string;
  interval: string;
  /** TTL while the tape is live. */
  activeTtlMs: number;
  /** TTL once the tape is closed. */
  closedTtlMs: number;
  /** Whether extended-hours bars are meaningful at this interval. */
  intraday: boolean;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** TTLs from docs/quant-v3/01 section 3. Weekend TTLs are handled by
 *  `closedTtlMs` plus the 12-hour weekend override below. */
export const RANGE_SPEC_V3: Record<ChartRange, RangeSpecV3> = {
  '1d': { yahooRange: '1d', interval: '5m', activeTtlMs: 20 * SECOND, closedTtlMs: 10 * MINUTE, intraday: true },
  '1w': { yahooRange: '5d', interval: '15m', activeTtlMs: 60 * SECOND, closedTtlMs: 15 * MINUTE, intraday: true },
  '1m': { yahooRange: '1mo', interval: '60m', activeTtlMs: 5 * MINUTE, closedTtlMs: 30 * MINUTE, intraday: true },
  '3m': { yahooRange: '3mo', interval: '1d', activeTtlMs: 4 * HOUR, closedTtlMs: 4 * HOUR, intraday: false },
  '6m': { yahooRange: '6mo', interval: '1d', activeTtlMs: 4 * HOUR, closedTtlMs: 4 * HOUR, intraday: false },
  '1y': { yahooRange: '1y', interval: '1d', activeTtlMs: 4 * HOUR, closedTtlMs: 4 * HOUR, intraday: false },
  '5y': { yahooRange: '5y', interval: '1wk', activeTtlMs: 4 * HOUR, closedTtlMs: 4 * HOUR, intraday: false },
  max: { yahooRange: 'max', interval: '1mo', activeTtlMs: 4 * HOUR, closedTtlMs: 4 * HOUR, intraday: false },
};

const WEEKEND_DAILY_TTL_MS = 12 * HOUR;

export function normalizeChartRequest(request: ChartRequest): Required<ChartRequest> {
  return {
    symbol: request.symbol.trim().toUpperCase(),
    range: request.range,
    includeExtendedHours: request.includeExtendedHours ?? true,
    refresh: request.refresh ?? 'cache-first',
  };
}

/** `charts/NVDA/1d-5m-ext` — the suffix is part of the key because an
 *  extended-hours series is a different payload, not a variant of the same one. */
export function chartCacheKey(
  symbol: string,
  range: ChartRange,
  includeExtendedHours: boolean,
): string {
  const spec = RANGE_SPEC_V3[range];
  const extended = includeExtendedHours && spec.intraday;
  return `charts/${symbol.toUpperCase()}/${range}-${spec.interval}${extended ? '-ext' : ''}`;
}

function isWeekend(now: number): boolean {
  const day = new Date(now).getUTCDay();
  // Saturday, or Sunday before the Asian open — close enough for a cache TTL,
  // and deliberately not an exchange-calendar claim.
  return day === 6 || day === 0;
}

export function ttlForRange(range: ChartRange, marketState: string | null | undefined, now = Date.now()): number {
  const spec = RANGE_SPEC_V3[range];
  if (isActiveMarketState(marketState)) return spec.activeTtlMs;
  if (!spec.intraday && isWeekend(now)) return WEEKEND_DAILY_TTL_MS;
  return spec.closedTtlMs;
}

/** Injectable so tests never depend on live Yahoo. */
export type ChartFetcher = (args: {
  symbol: string;
  yahooRange: string;
  interval: string;
  ttlMs: number;
  includeExtendedHours: boolean;
}) => Promise<YahooChartResult>;

const defaultFetcher: ChartFetcher = ({ symbol, yahooRange, interval, ttlMs, includeExtendedHours }) =>
  fetchYahooChart(symbol, yahooRange, interval, ttlMs, includeExtendedHours);

let chartFetcher: ChartFetcher = defaultFetcher;

export function setChartFetcherForTests(fetcher: ChartFetcher | null): void {
  chartFetcher = fetcher ?? defaultFetcher;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Tags each bar with its session.
 *
 * Only intraday series get real classification: a daily or weekly bar spans
 * whole sessions, so calling it `regular` would be a claim the data does not
 * support. Those are left `unknown`.
 */
export function classifyCandleSessions(
  candles: Candle[],
  interval: string,
  exchangeTimezone: string,
): Candle[] {
  const intraday = /m$|h$/.test(interval) && interval !== '1mo';
  if (!intraday) return candles.map((candle) => ({ ...candle, session: 'unknown' as const }));
  return candles.map((candle) => ({
    ...candle,
    session: classifyUsEquitySession({
      unixSeconds: candle.time,
      exchangeTimezone,
    }),
  }));
}

function chartFromYahoo(
  symbol: string,
  range: ChartRange,
  includeExtendedHours: boolean,
  result: YahooChartResult,
): ChartData {
  const spec = RANGE_SPEC_V3[range];
  const meta = result.meta ?? {};
  const rawCandles = yahooResultToCandles(result);
  if (rawCandles.length === 0) throw new Error(`no usable candles for ${symbol} ${range}`);

  const exchangeTimezone =
    typeof meta.exchangeTimezoneName === 'string' && meta.exchangeTimezoneName
      ? meta.exchangeTimezoneName
      : US_EQUITY_TIMEZONE;

  const preMarket: ExtendedHoursQuote | null = extendedHoursQuoteFrom(meta, 'pre');
  const postMarket: ExtendedHoursQuote | null = extendedHoursQuoteFrom(meta, 'post');

  return {
    symbol,
    range,
    interval: spec.interval,
    candles: classifyCandleSessions(rawCandles, spec.interval, exchangeTimezone),
    currency: typeof meta.currency === 'string' && meta.currency ? meta.currency : 'USD',
    exchangeName:
      typeof meta.exchangeName === 'string' && meta.exchangeName ? meta.exchangeName : undefined,
    exchangeTimezone,
    // Quote metadata and the last candle are both preserved when they
    // disagree: the candle series is the record of what traded, and the quote
    // is the provider's latest mark. Overwriting one with the other loses
    // information the UI needs to show an honest header.
    regularMarketPrice: finite(meta.regularMarketPrice),
    previousClose: finite(meta.chartPreviousClose) ?? finite(meta.previousClose),
    preMarket: includeExtendedHours ? preMarket : null,
    postMarket: includeExtendedHours ? postMarket : null,
    marketState: typeof meta.marketState === 'string' ? meta.marketState : undefined,
    source: 'live',
  };
}

function withCacheMeta(
  chart: ChartData,
  cacheKey: string,
  fetchedAt: string,
  expiresAt: string,
  stale: boolean,
  persistent: boolean,
): ChartData {
  return { ...chart, cache: { cacheKey, fetchedAt, expiresAt, stale, persistent } };
}

function sampleFallback(symbol: string, range: ChartRange, cacheKey: string): ChartData {
  const chart = sampleChart(symbol, range);
  const now = new Date().toISOString();
  return {
    ...chart,
    candles: chart.candles.map((candle) => ({ ...candle, session: 'unknown' as const })),
    preMarket: null,
    postMarket: null,
    // Sample payloads are never persisted, so `persistent: false` is the truth
    // here and the UI cannot mistake this for a cached live series.
    cache: { cacheKey, fetchedAt: now, expiresAt: now, stale: true, persistent: false },
  };
}

export async function getChartV3(request: ChartRequest): Promise<ChartData> {
  const { symbol, range, includeExtendedHours, refresh } = normalizeChartRequest(request);
  if (!symbol) return sampleFallback('', range, chartCacheKey('', range, includeExtendedHours));

  const spec = RANGE_SPEC_V3[range];
  const wantsExtended = includeExtendedHours && spec.intraday;
  const cacheKey = chartCacheKey(symbol, range, includeExtendedHours);

  const cached =
    refresh === 'force-network' ? null : readMarketCache<ChartData>(cacheKey);

  // A fresh persistent hit short-circuits: no network, no provider rate limit,
  // and a reopened ticker paints before any request completes.
  if (cached && !cached.stale && cached.source === 'live' && refresh === 'cache-first') {
    return withCacheMeta(cached.value, cacheKey, cached.fetchedAt, cached.expiresAt, false, true);
  }

  try {
    const result = await chartFetcher({
      symbol,
      yahooRange: spec.yahooRange,
      interval: spec.interval,
      // The HTTP layer's own short-lived memo; the persistent TTL is applied
      // below and is the one that matters across restarts.
      ttlMs: Math.min(spec.activeTtlMs, 60 * SECOND),
      includeExtendedHours: wantsExtended,
    });
    const chart = chartFromYahoo(symbol, range, wantsExtended, result);
    const ttlMs = ttlForRange(range, chart.marketState);
    const entry = writeMarketCache<ChartData>(cacheKey, chart, ttlMs, 'live');
    const fetchedAt = entry?.fetchedAt ?? new Date().toISOString();
    const expiresAt = entry?.expiresAt ?? new Date(Date.now() + ttlMs).toISOString();
    return withCacheMeta(chart, cacheKey, fetchedAt, expiresAt, false, entry !== null);
  } catch {
    if (cached && cached.source === 'live') {
      return withCacheMeta(cached.value, cacheKey, cached.fetchedAt, cached.expiresAt, true, true);
    }
    return sampleFallback(symbol, range, cacheKey);
  }
}

/** Warms the persistent cache without returning a payload. Never throws: a
 *  failed prefetch is a missed optimisation, not an error the caller handles. */
export async function prefetchChartV3(symbol: string, range: ChartRange): Promise<void> {
  try {
    await getChartV3({ symbol, range, includeExtendedHours: true, refresh: 'cache-first' });
  } catch {
    /* intentionally silent */
  }
}

/** Compatibility delegate for the 2.x `chart:get` channel. Extended hours are
 *  off so existing callers see exactly the series they saw before. */
export async function getChartCompat(symbol: string, range: ChartRange): Promise<ChartData> {
  return getChartV3({ symbol, range, includeExtendedHours: false, refresh: 'cache-first' });
}

/** Exposed for the source-precedence tests. */
export function describeChartSource(chart: ChartData): { source: DataSource; stale: boolean } {
  return { source: chart.source, stale: chart.cache?.stale ?? false };
}
