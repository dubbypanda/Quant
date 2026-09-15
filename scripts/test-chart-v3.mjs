// Chart normalization, session classification, and retrieval-precedence tests
// for Quant 3.0 (docs/quant-v3/01, Tasks 1, 2 and 4).
//
// Task 1's purpose is to lock the 2.x normalization behaviour before the
// migration touches it, so the tests below assert the old guarantees first and
// the new precedence rules second. No test depends on live Yahoo.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-chart-v3-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

// Everything is bundled through ONE entry point on purpose. `chartRepository`
// imports `marketCache`, so building them as separate bundles would give each
// its own copy of the module — the repository would then read from a different
// cache root than the one this test configures, and the precedence assertions
// below would silently test nothing.
const fallbackUserData = path.join(tmp, 'userData');
fs.mkdirSync(fallbackUserData, { recursive: true });

const electronMock = {
  name: 'electron-mock',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      // A real temp path, so any code path that skips the explicit root
      // override writes into the sandbox rather than the repo working tree.
      contents: `export const app = { getPath: () => ${JSON.stringify(fallbackUserData)} };`,
    }));
  },
};

const bundle = path.join(tmp, 'chart-v3-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as chart from './src/main/services/chart';",
      "export * as marketSession from './src/shared/marketSession';",
      "export * as repository from './src/main/services/chartRepository';",
      "export * as cache from './src/main/services/marketCache';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'chart-v3-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { chart, marketSession, repository, cache } = await import(bundle);

/** Minutes from midnight New York, as a UTC unix timestamp. */
function nyTimestamp(year, month, day, hour, minute, utcOffsetHours) {
  return Math.floor(Date.UTC(year, month - 1, day, hour - utcOffsetHours, minute) / 1000);
}
// EST = UTC-5 (January), EDT = UTC-4 (July).
const est = (y, m, d, h, min) => nyTimestamp(y, m, d, h, min, -5);
const edt = (y, m, d, h, min) => nyTimestamp(y, m, d, h, min, -4);

// ---------------------------------------------------------------------------
console.log('--- Test 1: 2.x candle normalization is preserved ---');
{
  // Null closes are dropped; a null open/high/low is filled from the close;
  // OHLC is sanity-clamped; duplicate timestamps are last-write-wins.
  const result = {
    meta: { currency: 'USD' },
    timestamp: [100, 200, 300, 300, 400, null],
    indicators: {
      quote: [
        {
          open: [10, null, 30, 31, 40, 50],
          // bar 3 has a high BELOW its close and a low ABOVE it — must clamp
          high: [11, 21, 29, 32, null, 51],
          low: [9, 19, 31, 30, 39, 49],
          close: [10.5, null, 30.5, 31.5, 40.5, 50.5],
          volume: [1000, 2000, 3000, 3300, null, 5000],
        },
      ],
    },
  };
  const candles = chart.yahooResultToCandles(result);

  assert.deepEqual(
    candles.map((c) => c.time),
    [100, 300, 400],
    'null-close rows and null timestamps are removed',
  );

  const dup = candles.find((c) => c.time === 300);
  assert.equal(dup.close, 31.5, 'duplicate timestamps are last-write-wins');
  assert.equal(dup.volume, 3300);

  for (const candle of candles) {
    assert.ok(
      candle.high >= Math.max(candle.open, candle.close),
      `high must clamp above open/close, got ${JSON.stringify(candle)}`,
    );
    assert.ok(
      candle.low <= Math.min(candle.open, candle.close),
      `low must clamp below open/close, got ${JSON.stringify(candle)}`,
    );
  }

  const filled = candles.find((c) => c.time === 400);
  assert.equal(filled.volume, 0, 'a null volume becomes 0, not NaN');
  assert.ok(Number.isFinite(filled.high), 'a null high is derived, not left null');

  assert.deepEqual(
    candles.map((c) => c.time),
    [...candles.map((c) => c.time)].sort((a, b) => a - b),
    'output is ascending by time',
  );
  assert.deepEqual(chart.yahooResultToCandles({}), [], 'an empty result yields no candles');
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Session classification, including both DST halves ---');
{
  const cases = [
    // January — EST
    [est(2026, 1, 15, 3, 59), 'closed', 'before the pre-market window'],
    [est(2026, 1, 15, 4, 0), 'pre', '04:00 ET opens pre-market'],
    [est(2026, 1, 15, 8, 0), 'pre', '08:00 ET'],
    [est(2026, 1, 15, 9, 29), 'pre', 'one minute before the bell'],
    [est(2026, 1, 15, 9, 30), 'regular', 'the bell'],
    [est(2026, 1, 15, 10, 0), 'regular', '10:00 ET'],
    [est(2026, 1, 15, 15, 59), 'regular', 'one minute before the close'],
    [est(2026, 1, 15, 16, 0), 'post', 'the close opens after-hours'],
    [est(2026, 1, 15, 17, 15), 'post', '17:15 ET'],
    [est(2026, 1, 15, 19, 59), 'post', 'one minute before after-hours ends'],
    [est(2026, 1, 15, 20, 0), 'closed', '20:00 ET closes the tape'],
    [est(2026, 1, 15, 21, 0), 'closed', '21:00 ET'],
    // July — EDT. Identical wall-clock rules, one hour different in UTC.
    [edt(2026, 7, 15, 8, 0), 'pre', '08:00 ET in summer'],
    [edt(2026, 7, 15, 10, 0), 'regular', '10:00 ET in summer'],
    [edt(2026, 7, 15, 17, 15), 'post', '17:15 ET in summer'],
    [edt(2026, 7, 15, 21, 0), 'closed', '21:00 ET in summer'],
  ];
  for (const [unixSeconds, expected, label] of cases) {
    assert.equal(
      marketSession.classifyUsEquitySession({ unixSeconds }),
      expected,
      `${label}: expected ${expected}`,
    );
  }

  // The same wall-clock hour in both halves of the year must agree, which is
  // the property a fixed UTC offset would break.
  assert.equal(
    marketSession.classifyUsEquitySession({ unixSeconds: est(2026, 1, 15, 10, 0) }),
    marketSession.classifyUsEquitySession({ unixSeconds: edt(2026, 7, 15, 10, 0) }),
  );

  // Weekends are closed regardless of the clock. 2026-01-17 is a Saturday.
  assert.equal(marketSession.classifyUsEquitySession({ unixSeconds: est(2026, 1, 17, 11, 0) }), 'closed');
  assert.equal(marketSession.classifyUsEquitySession({ unixSeconds: est(2026, 1, 18, 11, 0) }), 'closed');

  // Midnight must not read as hour 24.
  const midnight = marketSession.exchangeLocalTime(est(2026, 1, 15, 0, 0));
  assert.equal(midnight.hour, 0, 'midnight is hour 0');
  assert.equal(midnight.minuteOfDay, 0);
  assert.equal(midnight.date, '2026-01-15');

  // A calendar authority can veto a trading day, and can shorten the session.
  assert.equal(
    marketSession.classifyUsEquitySession({
      unixSeconds: est(2026, 1, 15, 11, 0),
      calendarOverride: () => ({ isTradingDay: false }),
    }),
    'closed',
    'a holiday is closed even at 11:00',
  );
  assert.equal(
    marketSession.classifyUsEquitySession({
      unixSeconds: est(2026, 1, 15, 14, 0),
      calendarOverride: () => ({ isTradingDay: true, earlyCloseMinute: 13 * 60 }),
    }),
    'post',
    'an early close moves the regular/post boundary',
  );

  // Unusable input is `unknown`, never a guess against the host timezone.
  assert.equal(marketSession.classifyUsEquitySession({ unixSeconds: Number.NaN }), 'unknown');
  assert.equal(
    marketSession.classifyUsEquitySession({ unixSeconds: est(2026, 1, 15, 10, 0), exchangeTimezone: 'Not/AZone' }),
    'unknown',
  );

  // Active-state helpers: the dead zones are not active.
  assert.equal(marketSession.isActiveMarketState('REGULAR'), true);
  assert.equal(marketSession.isActiveMarketState('PRE'), true);
  assert.equal(marketSession.isActiveMarketState('POST'), true);
  assert.equal(marketSession.isActiveMarketState('POSTPOST'), false, 'POSTPOST is a dead zone');
  assert.equal(marketSession.isActiveMarketState('PREPRE'), false, 'PREPRE is a dead zone');
  assert.equal(marketSession.isActiveMarketState('CLOSED'), false);
  assert.equal(marketSession.isActiveMarketState(undefined), false);
  assert.equal(marketSession.sessionFromMarketState('POSTPOST'), 'closed');
  assert.equal(marketSession.sessionFromMarketState('nonsense'), 'unknown');
  assert.equal(marketSession.isActiveSession('post'), true);
  assert.equal(marketSession.isActiveSession('closed'), false);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Cache keys, TTL policy, and candle session tagging ---');
{
  assert.equal(
    repository.chartCacheKey('nvda', '1d', true),
    'charts/NVDA/1d-5m-ext',
    'an extended-hours intraday series is a distinct key',
  );
  assert.equal(repository.chartCacheKey('NVDA', '1d', false), 'charts/NVDA/1d-5m');
  assert.equal(
    repository.chartCacheKey('NVDA', '1y', true),
    'charts/NVDA/1y-1d',
    'daily ranges have no extended-hours variant',
  );

  // TTLs tighten while the tape is live and relax when it closes.
  assert.equal(repository.ttlForRange('1d', 'REGULAR'), 20_000);
  assert.equal(repository.ttlForRange('1d', 'CLOSED'), 10 * 60_000);
  assert.equal(repository.ttlForRange('1w', 'PRE'), 60_000);
  assert.equal(repository.ttlForRange('1w', 'CLOSED'), 15 * 60_000);
  assert.equal(repository.ttlForRange('1m', 'POST'), 5 * 60_000);
  assert.equal(repository.ttlForRange('1m', 'CLOSED'), 30 * 60_000);
  // A weekday close keeps the 4-hour daily TTL; a weekend stretches to 12.
  const wednesday = Date.UTC(2026, 0, 14, 22, 0, 0);
  const saturday = Date.UTC(2026, 0, 17, 22, 0, 0);
  assert.equal(repository.ttlForRange('1y', 'CLOSED', wednesday), 4 * 60 * 60_000);
  assert.equal(repository.ttlForRange('1y', 'CLOSED', saturday), 12 * 60 * 60_000);
  assert.equal(
    repository.ttlForRange('1d', 'CLOSED', saturday),
    10 * 60_000,
    'the weekend stretch applies to daily ranges, not intraday',
  );

  // Intraday bars get a real session; daily bars stay `unknown` because a bar
  // spanning whole sessions cannot honestly be called one of them.
  const intraday = repository.classifyCandleSessions(
    [
      { time: est(2026, 1, 15, 8, 0), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: est(2026, 1, 15, 10, 0), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      { time: est(2026, 1, 15, 17, 0), open: 1, high: 1, low: 1, close: 1, volume: 1 },
    ],
    '5m',
    'America/New_York',
  );
  assert.deepEqual(intraday.map((c) => c.session), ['pre', 'regular', 'post']);

  const daily = repository.classifyCandleSessions(
    [{ time: est(2026, 1, 15, 10, 0), open: 1, high: 1, low: 1, close: 1, volume: 1 }],
    '1d',
    'America/New_York',
  );
  assert.deepEqual(daily.map((c) => c.session), ['unknown']);

  assert.deepEqual(repository.normalizeChartRequest({ symbol: ' nvda ', range: '1d' }), {
    symbol: 'NVDA',
    range: '1d',
    includeExtendedHours: true,
    refresh: 'cache-first',
  });
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Retrieval precedence ---');
{
  const dir = path.join(tmp, 'repo-root');
  fs.mkdirSync(dir, { recursive: true });
  cache.setMarketCacheRoot(dir);

  function yahooResult(close, overrides = {}) {
    return {
      meta: {
        currency: 'USD',
        exchangeName: 'NasdaqGS',
        exchangeTimezoneName: 'America/New_York',
        regularMarketPrice: close,
        chartPreviousClose: close - 1,
        marketState: 'REGULAR',
        ...overrides,
      },
      timestamp: [est(2026, 1, 15, 10, 0), est(2026, 1, 15, 10, 5)],
      indicators: {
        quote: [
          {
            open: [close - 0.5, close - 0.2],
            high: [close + 0.5, close + 0.3],
            low: [close - 0.7, close - 0.4],
            close: [close - 0.1, close],
            volume: [1000, 1100],
          },
        ],
      },
    };
  }

  let calls = 0;
  const serve = (close, overrides) => {
    repository.setChartFetcherForTests(async () => {
      calls += 1;
      return yahooResult(close, overrides);
    });
  };
  const fail = () => {
    repository.setChartFetcherForTests(async () => {
      calls += 1;
      throw new Error('network down');
    });
  };

  // No cache + network success → live, persisted.
  serve(100);
  const first = await repository.getChartV3({ symbol: 'TSTA', range: '1d' });
  assert.equal(first.source, 'live');
  assert.equal(first.cache.stale, false);
  assert.equal(first.cache.persistent, true, 'a live payload is persisted');
  assert.equal(first.marketState, 'REGULAR');
  assert.deepEqual(first.candles.map((c) => c.session), ['regular', 'regular']);
  assert.equal(calls, 1);

  // Fresh cache + cache-first → no network at all.
  const cached = await repository.getChartV3({ symbol: 'TSTA', range: '1d' });
  assert.equal(calls, 1, 'a fresh persistent hit must not touch the network');
  assert.equal(cached.cache.stale, false);
  assert.equal(cached.candles.length, first.candles.length);

  // network-first goes out even when the cache is fresh.
  serve(101);
  const refreshed = await repository.getChartV3({
    symbol: 'TSTA',
    range: '1d',
    refresh: 'network-first',
  });
  assert.equal(calls, 2);
  assert.equal(refreshed.candles.at(-1).close, 101);

  // force-network ignores the cache even for reads.
  serve(102);
  const forced = await repository.getChartV3({
    symbol: 'TSTA',
    range: '1d',
    refresh: 'force-network',
  });
  assert.equal(calls, 3);
  assert.equal(forced.candles.at(-1).close, 102);

  // Stale cache + network failure → the stale LIVE payload, flagged stale.
  // Expire the entry by rewriting it with a zero TTL.
  cache.writeMarketCache('charts/TSTA/1d-5m-ext', forced, 0, 'live', dir);
  fail();
  const stale = await repository.getChartV3({ symbol: 'TSTA', range: '1d' });
  assert.equal(stale.source, 'live', 'real-but-old data beats synthetic data');
  assert.equal(stale.cache.stale, true, 'and the UI is told it is stale');
  assert.equal(stale.candles.at(-1).close, 102);

  // No cache + network failure → sample, and sample never claims to be cached
  // live data.
  fail();
  const sample = await repository.getChartV3({ symbol: 'NOCACHE', range: '1d' });
  assert.equal(sample.source, 'sample', 'sample fallback stays visibly sample');
  assert.equal(sample.cache.persistent, false, 'sample is never a persistent hit');
  assert.equal(sample.cache.stale, true);
  assert.equal(
    cache.readMarketCache('charts/NOCACHE/1d-5m-ext', dir),
    null,
    'sample payloads are never written to the persistent cache',
  );

  // A cached SAMPLE entry must not be served as a cache hit either. Plant one
  // and prove the repository refuses it and goes to the network.
  serve(200);
  cache.writeMarketCache('charts/POISON/1d-5m-ext', { ...sample, source: 'sample' }, 60_000, 'sample', dir);
  const unpoisoned = await repository.getChartV3({ symbol: 'POISON', range: '1d' });
  assert.equal(unpoisoned.source, 'live', 'a sample cache entry cannot masquerade as live');
  assert.equal(unpoisoned.candles.at(-1).close, 200);

  // Extended-hours values are normalized when present and never fabricated.
  serve(300, {
    marketState: 'POST',
    postMarketPrice: 305,
    postMarketChange: 5,
    postMarketChangePercent: 1.67,
    postMarketTime: est(2026, 1, 15, 17, 30),
  });
  const withPost = await repository.getChartV3({ symbol: 'EXT', range: '1d' });
  assert.equal(withPost.postMarket.price, 305);
  assert.equal(withPost.postMarket.change, 5);
  assert.ok(withPost.postMarket.updatedAt.startsWith('2026-01-15T'), 'the post-market stamp is ISO');
  assert.equal(withPost.preMarket, null, 'no pre-market price means null, not a derived value');
  assert.equal(
    withPost.regularMarketPrice,
    300,
    'the regular mark is preserved alongside the extended-hours quote',
  );
  assert.notEqual(
    withPost.candles.at(-1).close,
    withPost.postMarket.price,
    'quote metadata does not overwrite the candle series',
  );

  // Opting out of extended hours yields a different key and no extended values.
  serve(400, { postMarketPrice: 405, postMarketTime: est(2026, 1, 15, 17, 30) });
  const noExt = await repository.getChartV3({
    symbol: 'EXT2',
    range: '1d',
    includeExtendedHours: false,
  });
  assert.equal(noExt.postMarket, null, 'extended-hours values are withheld when not requested');
  assert.equal(noExt.cache.cacheKey, 'charts/EXT2/1d-5m');

  // A provider result with no usable candles falls back rather than returning
  // an empty chart.
  repository.setChartFetcherForTests(async () => ({ meta: { currency: 'USD' }, timestamp: [], indicators: { quote: [{}] } }));
  const empty = await repository.getChartV3({ symbol: 'EMPTY', range: '1d' });
  assert.equal(empty.source, 'sample');

  // Prefetch never throws, even when everything fails.
  fail();
  await repository.prefetchChartV3('PREFETCH', '1y');

  // The 2.x compatibility delegate keeps extended hours off.
  serve(500);
  const compat = await repository.getChartCompat('COMPAT', '1d');
  assert.equal(compat.postMarket, null);
  assert.equal(compat.cache.cacheKey, 'charts/COMPAT/1d-5m');
  assert.equal(compat.source, 'live');

  repository.setChartFetcherForTests(null);
  cache.setMarketCacheRoot(null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll chart v3 tests passed successfully!');
