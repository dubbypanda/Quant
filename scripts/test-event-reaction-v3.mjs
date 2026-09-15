// Event reaction engine tests (docs/quant-v3/02, Task 4).
//
// Deterministic synthetic candles only. Every case checks that the engine
// reports what happened and refuses to invent what it cannot measure.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-event-reaction-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const outfile = path.join(tmp, 'eventReaction.mjs');
await build({
  entryPoints: [path.join(root, 'src/shared/eventReaction.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile,
  logLevel: 'silent',
});
const engine = await import(outfile);

const HOUR = 3600;
const DAY = 86_400;
const T0 = Date.UTC(2026, 0, 14, 14, 30, 0) / 1000; // 09:30 ET, a Wednesday

function series(closes, { start = T0, step = HOUR } = {}) {
  return closes.map((close, index) => ({
    time: start + index * step,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1_000,
  }));
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Positive residual when the symbol outruns its benchmark ---');
{
  // Event at the second bar. Asset +4%, benchmark +1% over the 1-hour window.
  const eventTime = T0 + HOUR;
  const asset = series([100, 100, 104, 104]);
  const benchmark = series([50, 50, 50.5, 50.5]);
  const reaction = engine.calculateEventReaction({
    asset,
    benchmark,
    eventTime,
    window: '1h',
    baselineVolatilityPercent: 2,
  });

  assert.equal(reaction.reactionWindow, '1h');
  assert.ok(Math.abs(reaction.assetReturnPercent - 4) < 1e-9, `asset ${reaction.assetReturnPercent}`);
  assert.ok(Math.abs(reaction.benchmarkReturnPercent - 1) < 1e-9);
  assert.ok(Math.abs(reaction.residualReturnPercent - 3) < 1e-9, 'residual is asset minus benchmark');
  assert.ok(Math.abs(reaction.normalizedShock - 1.5) < 1e-9, '3% residual over a 2% baseline');
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Negative residual, and a benchmark-neutral move ---');
{
  const eventTime = T0 + HOUR;
  const down = engine.calculateEventReaction({
    asset: series([100, 100, 97, 97]),
    benchmark: series([50, 50, 50.5, 50.5]),
    eventTime,
    window: '1h',
    baselineVolatilityPercent: 1.5,
  });
  assert.ok(down.assetReturnPercent < 0);
  assert.ok(down.residualReturnPercent < down.assetReturnPercent, 'a rising benchmark deepens the residual');
  assert.ok(down.normalizedShock < 0, 'the shock keeps the residual sign');

  // The whole market moved; the symbol did nothing special. A raw return of
  // +3% would look like news, so the residual is the number that matters.
  const neutral = engine.calculateEventReaction({
    asset: series([100, 100, 103, 103]),
    benchmark: series([50, 50, 51.5, 51.5]),
    eventTime,
    window: '1h',
    baselineVolatilityPercent: 2,
  });
  assert.ok(Math.abs(neutral.assetReturnPercent - 3) < 1e-9);
  assert.ok(
    Math.abs(neutral.residualReturnPercent) < 1e-9,
    `a market-wide move has no residual, got ${neutral.residualReturnPercent}`,
  );
  assert.ok(Math.abs(neutral.normalizedShock) < 1e-9);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Missing bars and invalid alignment yield nulls, not guesses ---');
{
  const eventTime = T0 + HOUR;

  // No benchmark at all: the asset return still stands, the residual does not.
  const noBenchmark = engine.calculateEventReaction({
    asset: series([100, 100, 104, 104]),
    benchmark: [],
    eventTime,
    window: '1h',
    baselineVolatilityPercent: 2,
  });
  assert.ok(noBenchmark.assetReturnPercent !== null);
  assert.equal(noBenchmark.benchmarkReturnPercent, null);
  assert.equal(noBenchmark.residualReturnPercent, null);
  assert.equal(noBenchmark.normalizedShock, null, 'no residual means no shock');

  // No asset bars: everything is null.
  const noAsset = engine.calculateEventReaction({
    asset: [],
    benchmark: series([50, 51]),
    eventTime,
    window: '1h',
  });
  assert.equal(noAsset.assetReturnPercent, null);
  assert.equal(noAsset.reactionWindow, '1h', 'the requested window is still reported');

  // An event long before the series starts must not anchor to the first bar.
  const farBefore = engine.calculateEventReaction({
    asset: series([100, 101, 102]),
    benchmark: series([50, 50, 50]),
    eventTime: T0 - 400 * DAY,
    window: '1h',
  });
  assert.equal(farBefore.assetReturnPercent, null, 'an event before the series has no anchor');

  // An event long after the last bar must not anchor to it either: measuring a
  // reaction from a bar four days earlier would describe an unrelated move.
  const farAfter = engine.calculateEventReaction({
    asset: series([100, 101, 102]),
    benchmark: series([50, 50, 50]),
    eventTime: T0 + 400 * DAY,
    window: '1h',
  });
  assert.equal(farAfter.assetReturnPercent, null, 'a stale anchor is refused');

  // A clock window with no bar inside it cannot be answered.
  const emptyWindow = engine.calculateEventReaction({
    asset: series([100, 101], { step: 5 * DAY }),
    benchmark: series([50, 51], { step: 5 * DAY }),
    eventTime: T0,
    window: '30m',
  });
  assert.equal(emptyWindow.assetReturnPercent, null, 'no bar printed inside 30 minutes');

  // A non-positive close cannot be a return base.
  const zeroBase = engine.calculateEventReaction({
    asset: [
      { time: T0, open: 0, high: 0, low: 0, close: 0, volume: 1 },
      { time: T0 + HOUR, open: 5, high: 5, low: 5, close: 5, volume: 1 },
      { time: T0 + 2 * HOUR, open: 6, high: 6, low: 6, close: 6, volume: 1 },
    ],
    benchmark: series([50, 50, 50]),
    eventTime: T0,
    window: '1h',
  });
  assert.ok(
    zeroBase.assetReturnPercent === null || Number.isFinite(zeroBase.assetReturnPercent),
    'a zero close never produces Infinity',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Zero and missing baseline volatility ---');
{
  const eventTime = T0 + HOUR;
  const base = {
    asset: series([100, 100, 104, 104]),
    benchmark: series([50, 50, 50.5, 50.5]),
    eventTime,
    window: '1h',
  };

  // Dividing by zero would render as a spectacular shock; null says "cannot
  // normalize" instead.
  assert.equal(
    engine.calculateEventReaction({ ...base, baselineVolatilityPercent: 0 }).normalizedShock,
    null,
  );
  assert.equal(
    engine.calculateEventReaction({ ...base, baselineVolatilityPercent: null }).normalizedShock,
    null,
  );
  assert.equal(engine.calculateEventReaction(base).normalizedShock, null);
  assert.equal(
    engine.calculateEventReaction({ ...base, baselineVolatilityPercent: Number.NaN })
      .normalizedShock,
    null,
  );

  // A flat series has no measurable volatility, so the baseline helper says so
  // rather than returning 0.
  assert.equal(engine.baselineVolatilityPercent(series([100, 100, 100, 100, 100])), null);
  assert.equal(engine.baselineVolatilityPercent(series([100, 101])), null, 'too few bars');
  const volatility = engine.baselineVolatilityPercent(
    series([100, 102, 99, 103, 98, 104, 97, 105]),
  );
  assert.ok(volatility > 0, `expected a positive baseline, got ${volatility}`);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Session and next-session windows ---');
{
  // Two trading days of hourly bars.
  const day1 = series([100, 101, 102, 103], { start: T0, step: HOUR });
  const day2 = series([106, 107, 108, 109], { start: T0 + DAY, step: HOUR });
  const asset = [...day1, ...day2];
  const benchmark = [
    ...series([50, 50, 50, 50], { start: T0, step: HOUR }),
    ...series([50, 50, 50, 50], { start: T0 + DAY, step: HOUR }),
  ];

  // An event early on day 1 measures to the last bar of day 1.
  const session = engine.calculateEventReaction({
    asset,
    benchmark,
    eventTime: T0,
    window: 'session',
  });
  assert.ok(
    Math.abs(session.assetReturnPercent - 3) < 1e-9,
    `100 -> 103 over the session, got ${session.assetReturnPercent}`,
  );

  // The next-session window runs from the anchor to the end of the following
  // day, so it includes the overnight gap.
  const next = engine.calculateEventReaction({
    asset,
    benchmark,
    eventTime: T0,
    window: 'next-session',
  });
  assert.ok(
    Math.abs(next.assetReturnPercent - 9) < 1e-9,
    `100 -> 109 including the gap, got ${next.assetReturnPercent}`,
  );

  // With no following day there is nothing to measure.
  assert.equal(
    engine.calculateEventReaction({
      asset: day1,
      benchmark: series([50, 50, 50, 50]),
      eventTime: T0,
      window: 'next-session',
    }).assetReturnPercent,
    null,
  );

  // Daily bars: the anchor bar IS the session, so it measures close over close
  // against the prior bar instead of returning null.
  const daily = series([100, 100, 105, 106], { step: DAY });
  const dailySession = engine.calculateEventReaction({
    asset: daily,
    benchmark: series([50, 50, 50, 50], { step: DAY }),
    eventTime: daily[2].time,
    window: 'session',
  });
  assert.ok(
    Math.abs(dailySession.assetReturnPercent - 5) < 1e-9,
    `daily session should read 100 -> 105, got ${dailySession.assetReturnPercent}`,
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Binary search helpers, and non-causal copy ---');
{
  const candles = series([1, 2, 3, 4, 5]);
  assert.equal(engine.indexAtOrBefore(candles, candles[2].time), 2, 'exact match');
  assert.equal(engine.indexAtOrBefore(candles, candles[2].time + 1), 2, 'between bars');
  assert.equal(engine.indexAtOrBefore(candles, candles[0].time - 1), -1, 'before the series');
  assert.equal(engine.indexAtOrBefore(candles, candles[4].time + DAY), 4, 'after the series');
  assert.equal(engine.indexAtOrAfter(candles, candles[2].time), 2);
  assert.equal(engine.indexAtOrAfter(candles, candles[2].time + 1), 3);
  assert.equal(engine.indexAtOrAfter(candles, candles[4].time + 1), -1);
  assert.equal(engine.indexAtOrBefore([], 1), -1);

  // The copy must never claim causation.
  for (const label of Object.values(engine.REACTION_WINDOW_LABELS)) {
    assert.ok(
      /^(Reaction|Observed move)/.test(label),
      `window labels say Reaction or Observed move, got "${label}"`,
    );
    assert.ok(!/impact|caused/i.test(label), `"${label}" implies causation`);
  }
  // The caption does contain the word "caused" — in the clause that denies
  // causation, which is the point.
  assert.ok(
    /not what the event caused/i.test(engine.RESIDUAL_MOVE_CAPTION),
    'the caption states the limit explicitly',
  );
  assert.ok(
    /residual move is/i.test(engine.RESIDUAL_MOVE_CAPTION),
    'and defines the term it is captioning',
  );
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll event reaction tests passed successfully!');
