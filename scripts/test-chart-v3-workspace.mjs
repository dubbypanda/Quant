// Workspace presentation tests (docs/quant-v3/02, Tasks 2, 5 and 8).
//
// Covers the session quote formatter across PRE/REGULAR/POST/CLOSED and the
// missing-quote case, the extended-hours layer rules, and the workspace
// preference migration.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-chart-workspace-test-${process.pid}`);
fs.mkdirSync(tmp, { recursive: true });

const bundle = path.join(tmp, 'workspace-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as quote from './src/shared/sessionQuote';",
      "export * as extended from './src/renderer/components/chart-v3/layers/ExtendedHoursLayer';",
      "export * as eventLayer from './src/renderer/components/chart-v3/layers/EventMarkersLayer';",
      "export * as annotations from './src/renderer/components/chart-v3/model/chartAnnotations';",
      "export * as workspace from './src/renderer/components/chart-v3/hooks/useChartWorkspaceState';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'workspace-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // The hook module imports React for its hook exports. Only its pure
  // exports — the coercion and migration functions — are exercised here, so
  // React is stubbed rather than pulled into a Node bundle.
  plugins: [
    {
      name: 'react-stub',
      setup(build) {
        build.onResolve({ filter: /^react$/ }, () => ({ path: 'react-stub', namespace: 'stub' }));
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: [
            'const unsupported = () => { throw new Error("React hooks are not exercised in this test"); };',
            'export const useState = unsupported;',
            'export const useEffect = unsupported;',
            'export const useCallback = unsupported;',
            'export const useMemo = unsupported;',
            'export default {};',
          ].join('\n'),
        }));
      },
    },
  ],
  outfile: bundle,
  logLevel: 'silent',
});
const { quote, extended, eventLayer, annotations, workspace } = await import(bundle);

const T0 = Math.floor(Date.UTC(2026, 0, 15, 21, 0, 0) / 1000); // 16:00 ET
const NOW = T0 + 600;

function chart(overrides = {}) {
  return {
    symbol: 'NVDA',
    range: '1d',
    interval: '5m',
    candles: [
      { time: T0 - 3600, open: 180, high: 181, low: 179, close: 180, volume: 1000, session: 'regular' },
      { time: T0, open: 180, high: 185, low: 180, close: 184.26, volume: 2000, session: 'regular' },
    ],
    currency: 'USD',
    regularMarketPrice: 184.26,
    previousClose: 180.4,
    marketState: 'REGULAR',
    source: 'live',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: REGULAR session shows one coherent line ---');
{
  const presentation = quote.buildSessionQuotePresentation(chart(), NOW);
  assert.equal(presentation.session, 'regular');
  assert.equal(presentation.sessionLabel, 'Regular hours');
  assert.equal(presentation.primaryPrice, '$184.26');
  assert.equal(presentation.primaryChange, '+$3.86 (+2.14%)');
  // During REGULAR the secondary line is omitted: a pre-market quote from this
  // morning would read as a second current price.
  assert.equal(presentation.secondaryLabel, null);
  assert.equal(presentation.secondaryPrice, null);

  const withStalePre = quote.buildSessionQuotePresentation(
    chart({ preMarket: { price: 181, change: 0.6, changePercent: 0.33, updatedAt: null } }),
    NOW,
  );
  assert.equal(
    withStalePre.secondaryLabel,
    null,
    'a pre-market quote is not surfaced during the regular session',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: POST shows After Hours on its own basis ---');
{
  const presentation = quote.buildSessionQuotePresentation(
    chart({
      marketState: 'POST',
      postMarket: {
        price: 185.03,
        change: 0.77,
        changePercent: 0.42,
        updatedAt: new Date((T0 + 300) * 1000).toISOString(),
      },
    }),
    NOW,
  );
  assert.equal(presentation.session, 'post');
  assert.equal(presentation.secondaryLabel, 'After Hours');
  assert.equal(presentation.secondaryPrice, '$185.03');
  assert.equal(presentation.secondaryChange, '+$0.77 (+0.42%)');
  // The provider gave the figure, so the basis says so rather than implying a
  // recomputation.
  assert.equal(presentation.secondaryBasisCaption, quote.PROVIDER_PERCENT_CAPTION);

  // The regular line is untouched: the two moves are never summed.
  assert.equal(presentation.primaryChange, '+$3.86 (+2.14%)');
  const combinedPercent = 2.14 + 0.42;
  assert.ok(
    !presentation.primaryChange.includes(combinedPercent.toFixed(2)),
    'pre/post change is never added to regular change',
  );

  // With no provider percentage, the basis is the regular close and is stated.
  const derived = quote.buildSessionQuotePresentation(
    chart({
      marketState: 'POST',
      postMarket: { price: 186.26, change: null, changePercent: null, updatedAt: null },
    }),
    NOW,
  );
  assert.equal(derived.secondaryBasisCaption, quote.REGULAR_CLOSE_PERCENT_CAPTION);
  assert.ok(derived.secondaryChange.includes('+$2.00'), derived.secondaryChange);
  assert.ok(derived.secondaryChange.includes('(+1.09%)'), derived.secondaryChange);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: PRE, CLOSED, and a missing extended-hours quote ---');
{
  const pre = quote.buildSessionQuotePresentation(
    chart({
      marketState: 'PRE',
      preMarket: { price: 178.9, change: -1.5, changePercent: -0.83, updatedAt: null },
    }),
    NOW,
  );
  assert.equal(pre.session, 'pre');
  assert.equal(pre.secondaryLabel, 'Pre-Market');
  assert.equal(pre.secondaryChange, '-$1.50 (-0.83%)');

  // CLOSED retains the most recent post-market value and date-qualifies it.
  const closed = quote.buildSessionQuotePresentation(
    chart({
      marketState: 'CLOSED',
      postMarket: {
        price: 185.03,
        change: 0.77,
        changePercent: 0.42,
        updatedAt: new Date((T0 - 30 * 3600) * 1000).toISOString(),
      },
    }),
    NOW,
  );
  assert.equal(closed.session, 'closed');
  assert.equal(closed.secondaryLabel, 'After Hours');
  assert.ok(closed.secondaryAsOf, 'a day-old value is date-qualified');
  assert.equal(closed.primaryLabel, 'Close', 'the primary label stops saying Last');

  // A fresh value inside the same session needs no qualifier.
  const fresh = quote.buildSessionQuotePresentation(
    chart({
      marketState: 'POST',
      postMarket: {
        price: 185.03,
        change: 0.77,
        changePercent: 0.42,
        updatedAt: new Date((T0 + 60) * 1000).toISOString(),
      },
    }),
    NOW,
  );
  assert.equal(fresh.secondaryAsOf, null);

  // No extended-hours quote at all: one line, no empty second line.
  const none = quote.buildSessionQuotePresentation(chart({ marketState: 'POST' }), NOW);
  assert.equal(none.secondaryLabel, null);
  assert.equal(none.secondaryChange, null);
  assert.equal(none.secondaryBasisCaption, null);

  // No price data at all renders an em dash rather than NaN.
  const empty = quote.buildSessionQuotePresentation(
    { ...chart(), candles: [], regularMarketPrice: null, previousClose: null, marketState: undefined },
    NOW,
  );
  assert.equal(empty.primaryPrice, '—');
  assert.equal(empty.primaryChange, null);
  assert.equal(empty.session, 'unknown');

  // The session falls back to the last bar when the provider says nothing.
  const fromBar = quote.buildSessionQuotePresentation(
    { ...chart(), marketState: undefined },
    NOW,
  );
  assert.equal(fromBar.session, 'regular', 'the last bar classifies the session');
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Extended-hours layer rules ---');
{
  assert.equal(extended.supportsExtendedHours('5m'), true);
  assert.equal(extended.supportsExtendedHours('60m'), true);
  assert.equal(extended.supportsExtendedHours('1d'), false, 'a daily bar spans whole sessions');
  assert.equal(extended.supportsExtendedHours('1wk'), false);
  assert.equal(extended.supportsExtendedHours('1mo'), false);

  const candles = [
    { time: 1, session: 'regular' },
    { time: 2, session: 'post' },
  ].map((candle) => ({ open: 1, high: 1, low: 1, close: 1, volume: 1, ...candle }));
  assert.equal(extended.hasExtendedHoursBars(candles), true);
  assert.equal(
    extended.hasExtendedHoursBars([{ time: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, session: 'regular' }]),
    false,
    'the toggle stays hidden when there is nothing to shade',
  );

  // Extended bars are de-emphasised, never hidden: dropping them would make a
  // gap-up look like it came from nowhere.
  assert.ok(extended.sessionBarOpacity('pre') < 1);
  assert.ok(extended.sessionBarOpacity('pre') > 0);
  assert.equal(extended.sessionBarOpacity('regular'), 1);
  assert.equal(extended.sessionBarOpacity(undefined), 1);

  // Only extended windows are shaded; tinting the regular session would wash
  // out the whole chart.
  const bands = extended.visibleSessionBands([
    { session: 'pre', from: 1, to: 2 },
    { session: 'regular', from: 3, to: 4 },
    { session: 'post', from: 5, to: 6 },
  ]);
  assert.deepEqual(bands.map((band) => band.session), ['pre', 'post']);
  assert.equal(extended.SESSION_BAND_COLORS.regular, 'transparent');

  assert.equal(extended.defaultExtendedHoursEnabled('1d'), true);
  assert.equal(extended.defaultExtendedHoursEnabled('1w'), true);
  assert.equal(extended.defaultExtendedHoursEnabled('1y'), false);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Event markers stay quiet and degrade gracefully ---');
{
  const record = (overrides = {}) => ({
    id: 'e1',
    kind: 'fomc',
    title: 'FOMC statement',
    scheduledAt: '2026-01-28T19:00:00.000Z',
    occurredAt: '2026-01-28T19:00:00.000Z',
    sourceName: 'Federal Reserve',
    values: [],
    provenance: 'live',
    ...overrides,
  });

  const single = annotations.buildEventMarker(1000, [record()]);
  assert.equal(single.count, 1);
  assert.equal(single.tone, 'neutral', 'event markers are neutral, not directional');
  assert.ok(single.accessibleLabel.includes('FOMC statement'));

  // A collision stack keeps every record reachable.
  const stacked = annotations.buildEventMarker(1000, [
    record(),
    record({ id: 'e2', kind: 'cpi', title: 'Consumer Price Index' }),
    record({ id: 'e3', kind: 'earnings', title: 'NVDA earnings' }),
  ]);
  assert.equal(stacked.count, 3);
  assert.ok(stacked.glyph.includes('+2'), `the stack is visible: ${stacked.glyph}`);
  assert.ok(stacked.accessibleLabel.includes('2 more events'));
  assert.equal(stacked.records.length, 3);
  assert.equal(annotations.buildEventMarker(1000, []), null);

  // Incomplete enrichment must not blank the marker or the rows.
  const bare = annotations.buildEventMarker(1000, [
    record({ title: '', occurredAt: null, sourceName: '', values: [] }),
  ]);
  assert.ok(bare.title.length > 0, 'the title falls back to the category label');
  const rows = annotations.eventInspectorRows(
    record({ title: '', sourceName: '', occurredAt: null, values: [{ label: 'CPI', actual: null, expected: '3.1%', previous: '3.0%' }] }),
  );
  const byLabel = Object.fromEntries(rows.map((row) => [row.label, row.value]));
  assert.equal(byLabel.Occurred, 'Not reported');
  assert.equal(byLabel.Source, '—');
  assert.ok(byLabel.CPI.includes('—'), 'a missing actual renders as an em dash');
  assert.ok(byLabel.CPI.includes('est. 3.1%'));

  // Glyph text is suppressed when labels would collide.
  assert.equal(eventLayer.shouldShowEventGlyphs(4, 900), true);
  assert.equal(eventLayer.shouldShowEventGlyphs(60, 900), false, 'too dense for labels');
  assert.equal(eventLayer.shouldShowEventGlyphs(0, 900), false);
  const markers = eventLayer.buildEventSeriesMarkers([stacked], { showGlyphs: false });
  assert.equal(markers[0].text, undefined, 'no glyph text when suppressed');
  assert.equal(markers[0].position, 'belowBar');

  // Crosshair names the session in words, not by colour alone.
  assert.equal(annotations.crosshairSessionLabel('pre'), 'Pre-market');
  assert.equal(annotations.crosshairSessionLabel('post'), 'After hours');
  assert.equal(annotations.crosshairSessionLabel('unknown'), null);
  assert.equal(annotations.crosshairSessionLabel(undefined), null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Workspace preferences coerce and migrate conservatively ---');
{
  const defaults = workspace.DEFAULT_WORKSPACE_PREFERENCES;
  assert.equal(defaults.version, 3);
  assert.equal(
    defaults.showAllSignalDecisions,
    false,
    'WAIT/NO TRADE markers are off by default so candidates are not buried',
  );

  // Garbage in, defaults out — per field, not whole-object.
  assert.deepEqual(workspace.coerceWorkspacePreferences(null), defaults);
  assert.deepEqual(workspace.coerceWorkspacePreferences('nonsense'), defaults);
  const partial = workspace.coerceWorkspacePreferences({
    showEvents: false,
    inspectorTab: 'not-a-tab',
    movingAverages: [20, 999],
    eventKinds: ['cpi', 42],
    logScale: 'yes',
  });
  assert.equal(partial.showEvents, false, 'a valid field is kept');
  assert.equal(partial.inspectorTab, 'overview', 'an invalid enum falls back');
  assert.deepEqual(partial.movingAverages, [20], 'unknown MA lengths are dropped');
  assert.deepEqual(partial.eventKinds, ['cpi'], 'non-string kinds are dropped');
  assert.equal(partial.logScale, false, 'a non-boolean falls back rather than coercing');
  assert.equal(partial.version, 3);

  // An empty list falls back rather than leaving the chart with no layers.
  assert.deepEqual(
    workspace.coerceWorkspacePreferences({ movingAverages: [] }).movingAverages,
    defaults.movingAverages,
  );

  // Only obvious 2.x mappings carry over; nothing else is invented.
  const migrated = workspace.migrateLegacyOverlayPreferences({
    forecastOverlay: true,
    logScale: true,
    someUnrelatedToggle: true,
    showRiskOverlay: true,
  });
  assert.deepEqual(
    migrated,
    { showForecast: true, logScale: true },
    'unrelated 2.x controls are not mapped onto new ones',
  );
  assert.deepEqual(workspace.migrateLegacyOverlayPreferences(null), {});
  assert.deepEqual(workspace.migrateLegacyOverlayPreferences({}), {});

  // Migration composes with the defaults for everything it does not touch.
  const composed = workspace.coerceWorkspacePreferences({
    ...defaults,
    ...workspace.migrateLegacyOverlayPreferences({ forecastOverlay: true }),
  });
  assert.equal(composed.showForecast, true);
  assert.equal(composed.showExtendedHours, defaults.showExtendedHours);
  assert.notEqual(workspace.WORKSPACE_STORAGE_KEY, workspace.LEGACY_OVERLAY_STORAGE_KEY);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll chart workspace tests passed successfully!');
