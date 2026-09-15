// Immutable signal history tests (docs/quant-v3/02, Tasks 6 and 7).
//
// The contract under test: a stored snapshot shows what the model said then.
// Task 7 asks specifically for a regression proving that changing the current
// model output cannot alter a stored old snapshot — Test 3.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-signal-history-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const electronMock = {
  name: 'electron-mock',
  setup(build) {
    build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron-mock', namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({
      contents: `export const app = { getPath: () => ${JSON.stringify(tmp)} };`,
    }));
  },
};

const bundle = path.join(tmp, 'history-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as history from './src/main/services/signalHistoryStore';",
      "export * as annotations from './src/renderer/components/chart-v3/model/chartAnnotations';",
      "export * as layout from './src/renderer/components/chart-v3/model/annotationLayout';",
      "export * as signalLayer from './src/renderer/components/chart-v3/layers/SignalMarkersLayer';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'history-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { history, annotations, layout, signalLayer } = await import(bundle);

const DAY = 86_400;
const T0 = 1_700_000_000;

let counter = 0;
function freshPaths() {
  const id = counter++;
  return {
    historyPath: path.join(tmp, `history-${id}.json`),
    v2Path: path.join(tmp, `outcomes-${id}.json`),
  };
}

function evaluation(overrides = {}) {
  return {
    symbol: 'NVDA',
    timeframe: '1d',
    signalBarTime: T0,
    setupType: 'breakout',
    decision: 'buy-candidate',
    direction: 'long',
    regime: 'trending-up',
    setupQuality: 78,
    components: [],
    noTradeReasons: [],
    reason: 'A long candidate is forming.',
    risk: {
      direction: 'long',
      entry: 100,
      stop: 95,
      target1: 112,
      target2: 120,
      riskPerUnit: 5,
      rewardPerUnit1: 12,
      rewardPerUnit2: 20,
      rewardRisk1: 2.4,
      rewardRisk2: 4,
      maxDollarRisk: 750,
      positionSize: 150,
      maxDollarLoss: 750,
      estimatedGain1: 1800,
      estimatedGain2: 3000,
      invalidation: 95,
    },
    strategyVersion: 'QuantDeskSignal_v2',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Append, read back, and range query ---');
{
  const { historyPath } = freshPaths();
  const snapshot = history.appendSignalSnapshot(
    { evaluation: evaluation(), dataCutoffTime: T0, observedAt: '2026-01-15T21:00:00.000Z' },
    historyPath,
  );
  assert.equal(snapshot.id, 'NVDA:QuantDeskSignal_v2:' + T0);
  assert.equal(snapshot.source, 'forward-observed');
  assert.equal(snapshot.decision, 'buy-candidate');
  assert.equal(snapshot.entry, 100);
  assert.equal(snapshot.target2, 120);
  assert.equal(snapshot.dataCutoffTime, T0);
  assert.equal(snapshot.modelName, 'Signal Engine V2');

  const all = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0], snapshot);

  // A different symbol is not returned.
  assert.deepEqual(history.getSignalHistory('AAPL', undefined, undefined, historyPath), []);

  // Range filtering by signal bar.
  history.appendSignalSnapshot(
    { evaluation: evaluation({ signalBarTime: T0 + 10 * DAY }), dataCutoffTime: T0 + 10 * DAY },
    historyPath,
  );
  assert.equal(history.getSignalHistory('NVDA', undefined, undefined, historyPath).length, 2);
  assert.equal(
    history.getSignalHistory('NVDA', T0 + 5 * DAY, undefined, historyPath).length,
    1,
    'from bound applies',
  );
  assert.equal(
    history.getSignalHistory('NVDA', undefined, T0 + 5 * DAY, historyPath).length,
    1,
    'to bound applies',
  );

  // Records come back oldest-first.
  const ordered = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.ok(ordered[0].signalBarTime < ordered[1].signalBarTime);

  // A missing or corrupt file is an empty history, not a crash.
  assert.deepEqual(history.getSignalHistory('NVDA', undefined, undefined, path.join(tmp, 'nope.json')), []);
  const corrupt = path.join(tmp, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ not json');
  assert.deepEqual(history.getSignalHistory('NVDA', undefined, undefined, corrupt), []);
  fs.writeFileSync(corrupt, JSON.stringify({ schemaVersion: 99, records: [{}] }));
  assert.deepEqual(history.getSignalHistory('NVDA', undefined, undefined, corrupt), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Appending is idempotent per bar ---');
{
  const { historyPath } = freshPaths();
  const first = history.appendSignalSnapshot(
    { evaluation: evaluation(), dataCutoffTime: T0 },
    historyPath,
  );
  const second = history.appendSignalSnapshot(
    { evaluation: evaluation(), dataCutoffTime: T0 },
    historyPath,
  );
  assert.equal(first.id, second.id);
  assert.equal(history.getSignalHistory('NVDA', undefined, undefined, historyPath).length, 1);

  // Case and whitespace in the symbol resolve to the same record.
  history.appendSignalSnapshot(
    { evaluation: evaluation({ symbol: ' nvda ' }), dataCutoffTime: T0 },
    historyPath,
  );
  assert.equal(history.getSignalHistory('NVDA', undefined, undefined, historyPath).length, 1);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: A newer model cannot rewrite an old snapshot (Task 7) ---');
{
  const { historyPath } = freshPaths();
  const original = history.appendSignalSnapshot(
    {
      evaluation: evaluation({ decision: 'buy-candidate', setupQuality: 78, setupType: 'breakout' }),
      dataCutoffTime: T0,
      observedAt: '2024-03-01T21:00:00.000Z',
    },
    historyPath,
  );

  // The model now says something completely different about the same bar:
  // opposite decision, opposite direction, different setup, new version's
  // geometry. None of it may reach the stored record.
  const rewritten = history.appendSignalSnapshot(
    {
      evaluation: evaluation({
        decision: 'short-candidate',
        direction: 'short',
        setupType: 'failed-breakout',
        setupQuality: 12,
        noTradeReasons: ['Everything changed'],
        risk: { ...evaluation().risk, entry: 999, stop: 1001, target1: 900, target2: 880 },
      }),
      dataCutoffTime: T0,
      observedAt: '2026-09-15T21:00:00.000Z',
    },
    historyPath,
  );

  assert.deepEqual(rewritten, original, 'the stored snapshot is returned unchanged');
  const stored = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.equal(stored.length, 1, 'and no second record appears for the same bar');
  assert.equal(stored[0].decision, 'buy-candidate');
  assert.equal(stored[0].setupQuality, 78);
  assert.equal(stored[0].setupType, 'breakout');
  assert.equal(stored[0].entry, 100);
  assert.equal(stored[0].observedAt, '2024-03-01T21:00:00.000Z');
  assert.deepEqual(stored[0].noTradeReasons, []);

  // A genuinely new strategy version is a different record, not an overwrite —
  // two models may both have an opinion about the same bar.
  history.appendSignalSnapshot(
    {
      evaluation: evaluation({ strategyVersion: 'QuantDeskSignal_v3', setupQuality: 44 }),
      dataCutoffTime: T0,
    },
    historyPath,
  );
  const both = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.equal(both.length, 2);
  assert.equal(
    both.find((record) => record.strategyVersion === 'QuantDeskSignal_v2').setupQuality,
    78,
    'the v2 record is still intact',
  );

  // Only the outcome block is writable after the fact.
  const updated = history.attachSignalOutcome(
    original.id,
    { status: 'target', netR: 2.4, resolvedAt: '2024-03-20T21:00:00.000Z' },
    historyPath,
  );
  assert.equal(updated.outcome.status, 'target');
  assert.equal(updated.decision, 'buy-candidate', 'the claim itself is untouched');
  assert.equal(updated.setupQuality, 78);
  assert.equal(
    history.attachSignalOutcome('does-not-exist', { status: 'open', netR: null, resolvedAt: null }, historyPath),
    null,
    'an outcome cannot create a record',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: v2 migration runs once and invents nothing ---');
{
  const { historyPath, v2Path } = freshPaths();
  const v2Records = [
    {
      id: 'NVDA:QuantDeskSignal_v2:' + T0,
      schemaVersion: 1,
      symbol: 'NVDA',
      strategyVersion: 'QuantDeskSignal_v2',
      executionModelVersion: 'DailyOHLC_Conservative_v1',
      timeframe: '1d',
      setupType: 'breakout',
      direction: 'long',
      regime: 'trending-up',
      signalBarTime: T0,
      observedAt: '2025-06-01T21:00:00.000Z',
      setupQuality: 71,
      plannedStop: 95,
      plannedTarget1: 112,
      status: 'resolved',
      exitReason: 'target1',
      netR: 2.1,
      resolvedAt: '2025-06-12T21:00:00.000Z',
    },
    {
      id: 'AAPL:QuantDeskSignal_v2:' + (T0 + DAY),
      schemaVersion: 1,
      symbol: 'AAPL',
      strategyVersion: 'QuantDeskSignal_v2',
      executionModelVersion: 'DailyOHLC_Conservative_v1',
      timeframe: '1d',
      setupType: 'lower-high-rejection',
      direction: 'short',
      regime: 'trending-down',
      signalBarTime: T0 + DAY,
      observedAt: '2025-06-02T21:00:00.000Z',
      setupQuality: 63,
      plannedStop: 210,
      plannedTarget1: 190,
      status: 'pending-entry',
    },
    {
      id: 'MSFT:QuantDeskSignal_v2:' + (T0 + 2 * DAY),
      schemaVersion: 1,
      symbol: 'MSFT',
      strategyVersion: 'QuantDeskSignal_v2',
      executionModelVersion: 'DailyOHLC_Conservative_v1',
      timeframe: '1d',
      setupType: 'breakout',
      direction: 'long',
      regime: 'range-bound',
      signalBarTime: T0 + 2 * DAY,
      observedAt: '2025-06-03T21:00:00.000Z',
      setupQuality: 58,
      plannedStop: 400,
      plannedTarget1: 430,
      status: 'skipped',
      skippedReason: 'gap-invalidated',
      resolvedAt: '2025-06-04T21:00:00.000Z',
    },
  ];
  fs.writeFileSync(v2Path, JSON.stringify(v2Records, null, 2));

  const first = history.migrateV2SignalOutcomes(historyPath, v2Path);
  assert.equal(first.ran, true);
  assert.equal(first.imported, 3);

  const imported = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.equal(imported.length, 1);
  const nvda = imported[0];
  assert.equal(nvda.source, 'imported-v2', 'imported records are marked as such');
  assert.equal(nvda.decision, 'buy-candidate', 'a long v2 record is a buy candidate');
  assert.equal(nvda.setupQuality, 71);
  assert.equal(nvda.stop, 95);
  assert.equal(nvda.target1, 112);
  // v2 never stored these, so they must not be invented.
  assert.equal(nvda.entry, null, 'v2 had no entry field');
  assert.equal(nvda.target2, null, 'v2 had no second target');
  assert.deepEqual(nvda.noTradeReasons, [], 'v2 had no blocker list');
  assert.equal(nvda.dataCutoffTime, T0, 'the cutoff falls back to the signal bar');
  assert.equal(nvda.outcome.status, 'target');
  assert.equal(nvda.outcome.netR, 2.1);

  const aapl = history.getSignalHistory('AAPL', undefined, undefined, historyPath)[0];
  assert.equal(aapl.decision, 'short-candidate');
  assert.equal(aapl.outcome.status, 'open', 'a pending v2 record is open');
  assert.equal(aapl.outcome.netR, null);

  const msft = history.getSignalHistory('MSFT', undefined, undefined, historyPath)[0];
  assert.equal(msft.outcome.status, 'invalidated', 'a skipped v2 record is invalidated');

  // Running it twice imports nothing and duplicates no ids.
  const second = history.migrateV2SignalOutcomes(historyPath, v2Path);
  assert.equal(second.ran, false, 'the migration marker prevents a second run');
  assert.equal(second.imported, 0);
  const everything = [
    ...history.getSignalHistory('NVDA', undefined, undefined, historyPath),
    ...history.getSignalHistory('AAPL', undefined, undefined, historyPath),
    ...history.getSignalHistory('MSFT', undefined, undefined, historyPath),
  ];
  assert.equal(everything.length, 3);
  assert.equal(new Set(everything.map((record) => record.id)).size, 3, 'no duplicate ids');

  const file = history.readSignalHistoryFile(historyPath);
  assert.equal(file.migratedFrom.source, 'quant-signal-outcomes-v1');
  assert.equal(file.migratedFrom.imported, 3);

  // A native record for a bar already present is not replaced by an import.
  const { historyPath: clashPath, v2Path: clashV2 } = freshPaths();
  history.appendSignalSnapshot({ evaluation: evaluation(), dataCutoffTime: T0 }, clashPath);
  fs.writeFileSync(clashV2, JSON.stringify([v2Records[0]], null, 2));
  const clash = history.migrateV2SignalOutcomes(clashPath, clashV2);
  assert.equal(clash.imported, 0);
  assert.equal(clash.skipped, 1, 'the colliding v2 record is skipped, not merged');
  assert.equal(
    history.getSignalHistory('NVDA', undefined, undefined, clashPath)[0].source,
    'forward-observed',
    'the native record survives',
  );

  // A missing v2 file is not an error; the marker is still written so the
  // migration does not retry forever.
  const { historyPath: emptyPath } = freshPaths();
  const none = history.migrateV2SignalOutcomes(emptyPath, path.join(tmp, 'absent.json'));
  assert.equal(none.ran, true);
  assert.equal(none.imported, 0);
  assert.ok(history.readSignalHistoryFile(emptyPath).migratedFrom);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Marker models, semantics and accessibility ---');
{
  const snapshot = (overrides) => ({
    id: 'x',
    symbol: 'NVDA',
    signalBarTime: T0,
    observedAt: '2026-01-15T21:00:00.000Z',
    modelName: 'Signal Engine V2',
    strategyVersion: 'QuantDeskSignal_v2',
    decision: 'buy-candidate',
    setupType: 'breakout',
    direction: 'long',
    setupQuality: 78,
    entry: 100,
    stop: 95,
    target1: 112,
    target2: 120,
    noTradeReasons: [],
    dataCutoffTime: T0,
    source: 'forward-observed',
    ...overrides,
  });

  // BUY below the bar, SHORT above it: direction reads from position as well
  // as from colour.
  const buy = annotations.buildSignalMarker(snapshot({}), false);
  assert.equal(buy.position, 'belowBar');
  assert.equal(buy.tone, 'bullish');
  assert.ok(buy.glyph.length > 0, 'a glyph exists so colour is not the only cue');
  assert.ok(buy.accessibleLabel.includes('Buy candidate'));
  assert.ok(buy.accessibleLabel.includes('78'), 'the label carries the quality');

  const short = annotations.buildSignalMarker(snapshot({ decision: 'short-candidate' }), false);
  assert.equal(short.position, 'aboveBar');
  assert.equal(short.tone, 'bearish');

  const invalidated = annotations.buildSignalMarker(snapshot({ decision: 'invalidated' }), false);
  assert.equal(invalidated.tone, 'invalidated');
  assert.ok(invalidated.accessibleLabel.includes('invalidated'));

  // WAIT and NO TRADE are hidden unless all decisions are requested.
  assert.equal(annotations.buildSignalMarker(snapshot({ decision: 'wait' }), false), null);
  assert.equal(annotations.buildSignalMarker(snapshot({ decision: 'no-trade' }), false), null);
  assert.ok(annotations.buildSignalMarker(snapshot({ decision: 'wait' }), true));

  // Inspector rows read only the snapshot, and say "Not captured" rather than
  // computing today's numbers.
  const rows = annotations.signalInspectorRows(snapshot({ entry: null, dataCutoffTime: 0 }));
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  assert.equal(byLabel.Entry, 'Not captured');
  assert.equal(byLabel['Data cutoff'], 'Not captured');
  assert.equal(byLabel.Decision, 'buy-candidate');
  assert.ok(byLabel.Model.includes('QuantDeskSignal_v2'), 'model provenance is inspectable');
  assert.equal(byLabel['Forward outcome'], 'Open');

  // Series markers are ascending by time, which lightweight-charts requires.
  const markers = signalLayer.buildSignalSeriesMarkers([
    annotations.buildSignalMarker(snapshot({ signalBarTime: T0 + DAY }), false),
    annotations.buildSignalMarker(snapshot({ signalBarTime: T0 }), false),
  ]);
  assert.deepEqual(markers.map((marker) => marker.time), [T0, T0 + DAY]);
  assert.ok(markers.every((marker) => typeof marker.text === 'string' && marker.text.length > 0));
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Viewport filtering and clustering keep marker counts sane ---');
{
  // 1,000 events across four years; only viewport-relevant markers may reach
  // the renderer.
  const records = Array.from({ length: 1000 }, (_, index) => ({
    time: T0 + index * 6 * 3600,
    id: `e${index}`,
  }));

  const range = { from: T0, to: T0 + 30 * DAY };
  const visible = layout.filterToVisibleRange(records, range);
  assert.ok(visible.length < records.length, 'the viewport filter removes most records');
  assert.ok(
    visible.every((record) => record.time >= T0 - 2 * DAY && record.time <= T0 + 32 * DAY),
    'only near-viewport records survive',
  );

  const clusters = layout.clusterByPixelBucket(visible, range, 900);
  assert.ok(clusters.length <= visible.length);
  assert.ok(
    clusters.length <= Math.ceil(900 / 14),
    `a 900px chart cannot show more than ~64 separated markers, got ${clusters.length}`,
  );
  // Nothing is lost: every filtered record is still reachable through a cluster.
  assert.equal(
    clusters.reduce((sum, cluster) => sum + cluster.records.length, 0),
    visible.length,
  );

  // With no range, every record is its own cluster rather than being dropped.
  assert.equal(layout.clusterByPixelBucket(records.slice(0, 5), null, 900).length, 5);
  assert.deepEqual(layout.clusterByPixelBucket([], range, 900), []);
  assert.deepEqual(layout.filterToVisibleRange(records, null).length, records.length);

  // Session bands: contiguous runs only, and a gap breaks the run instead of
  // being shaded over.
  const candles = [
    { time: T0, session: 'pre' },
    { time: T0 + 3600, session: 'pre' },
    { time: T0 + 7200, session: 'regular' },
    { time: T0 + 10800, session: undefined },
    { time: T0 + 14400, session: 'post' },
  ].map((candle) => ({ open: 1, high: 1, low: 1, close: 1, volume: 1, ...candle }));
  const bands = layout.buildSessionBands(candles);
  assert.deepEqual(
    bands.map((band) => [band.session, band.from, band.to]),
    [
      ['pre', T0, T0 + 3600],
      ['regular', T0 + 7200, T0 + 7200],
      ['post', T0 + 14400, T0 + 14400],
    ],
    'an unclassified bar breaks the run rather than extending a band',
  );
  assert.deepEqual(layout.buildSessionBands([]), []);

  const dividers = layout.buildSessionDividers(candles);
  assert.ok(dividers.some((divider) => divider.session === 'regular'));

  // Events snap to the last bar at or before them, and never clamp to the
  // left edge when they predate the series.
  assert.equal(layout.snapEventToBar(candles, T0 + 8000), T0 + 7200);
  assert.equal(layout.snapEventToBar(candles, T0 - 10), null);
  assert.equal(layout.snapEventToBar([], T0), null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll signal history tests passed successfully!');
