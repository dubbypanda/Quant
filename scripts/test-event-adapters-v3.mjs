// Event source adapter parser tests (docs/quant-v3/02, Task 3).
//
// Fixture-based and fully offline. No test may reach federalreserve.gov,
// bls.gov, bea.gov or treasurydirect.gov.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-event-adapters-test-${process.pid}`);
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

// One bundle so `economicEvents` shares the marketCache instance the test
// configures — the same trap the chart tests hit.
const bundle = path.join(tmp, 'events-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as fed from './src/main/services/events/federalReserve';",
      "export * as bls from './src/main/services/events/laborStatistics';",
      "export * as bea from './src/main/services/events/economicAnalysis';",
      "export * as ust from './src/main/services/events/treasury';",
      "export * as earnings from './src/main/services/events/earningsAdapter';",
      "export * as bundled from './src/main/services/events/bundledSchedule';",
      "export * as events from './src/main/services/economicEvents';",
      "export * as cache from './src/main/services/marketCache';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'events-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { fed, bls, bea, ust, earnings, bundled, events, cache } = await import(bundle);

// ---------------------------------------------------------------------------
console.log('--- Test 1: Federal Reserve RSS parsing and classification ---');
{
  const fixture = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Federal Reserve issues FOMC statement</title>
    <link>https://www.federalreserve.gov/newsevents/pressreleases/monetary20260128a.htm</link>
    <pubDate>Wed, 28 Jan 2026 19:00:00 GMT</pubDate>
  </item>
  <item>
    <title><![CDATA[Minutes of the Federal Open Market Committee, December 2025]]></title>
    <link>https://www.federalreserve.gov/monetarypolicy/fomcminutes20251210.htm</link>
    <pubDate>Wed, 14 Jan 2026 19:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Chair Powell press conference</title>
    <pubDate>Wed, 28 Jan 2026 19:30:00 GMT</pubDate>
  </item>
  <item>
    <title>Federal Reserve Board announces termination of enforcement action</title>
    <pubDate>Thu, 15 Jan 2026 15:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Missing a date entirely</title>
  </item>
</channel></rss>`;

  const records = fed.parseFederalReserveCalendar(fixture);
  const kinds = records.map((record) => record.kind);
  assert.deepEqual(
    kinds.sort(),
    ['fed-minutes', 'fed-press-conference', 'fomc'],
    `unrecognised press miscellany is skipped, got ${JSON.stringify(kinds)}`,
  );

  const statement = records.find((record) => record.kind === 'fomc');
  assert.equal(statement.scheduledAt, '2026-01-28T19:00:00.000Z');
  assert.equal(statement.occurredAt, '2026-01-28T19:00:00.000Z', 'a press release has occurred');
  assert.equal(statement.sourceName, 'Federal Reserve');
  assert.ok(statement.sourceUrl.startsWith('https://'));
  assert.equal(statement.provenance, 'live');
  assert.deepEqual(statement.values, []);

  // CDATA is unwrapped, not rendered literally.
  const minutes = records.find((record) => record.kind === 'fed-minutes');
  assert.ok(!minutes.title.includes('CDATA'), minutes.title);
  assert.ok(minutes.title.startsWith('Minutes of the Federal Open Market Committee'));

  // "Minutes of the FOMC meeting" must not classify as a rate decision.
  assert.equal(fed.classifyFederalReserveTitle('Minutes of the FOMC meeting'), 'fed-minutes');
  assert.equal(fed.classifyFederalReserveTitle('FOMC statement'), 'fomc');
  assert.equal(fed.classifyFederalReserveTitle('Speech by Governor Waller'), 'fed-speech');
  assert.equal(fed.classifyFederalReserveTitle('Consumer complaint report'), null);

  // Ids are content-derived and stable, so re-parsing does not duplicate.
  const again = fed.parseFederalReserveCalendar(fixture);
  assert.deepEqual(records.map((r) => r.id), again.map((r) => r.id));
  assert.equal(new Set(records.map((r) => r.id)).size, records.length, 'ids are unique');

  // Entity decoding must not double-decode: "&amp;lt;" is a literal "&lt;".
  const entity = fed.parseFederalReserveCalendar(
    `<rss><channel><item><title>FOMC statement A &amp;lt;B&amp;gt; C</title><pubDate>Wed, 28 Jan 2026 19:00:00 GMT</pubDate></item></channel></rss>`,
  );
  assert.equal(entity[0].title, 'FOMC statement A &lt;B&gt; C');

  assert.deepEqual(fed.parseFederalReserveCalendar(''), []);
  assert.deepEqual(fed.parseFederalReserveCalendar('not xml at all'), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: BLS schedule parsing, Eastern times, and DST ---');
{
  const fixture = `<table><tbody>
  <tr><th>Release</th><th>Reference</th><th>Date</th></tr>
  <tr><td>Consumer Price Index</td><td>December 2025</td><td>Jan. 13, 2026 08:30 AM</td></tr>
  <tr><td>Producer Price Index</td><td>December 2025</td><td>Jan. 14, 2026 08:30 AM</td></tr>
  <tr><td>Employment Situation</td><td>December 2025</td><td>Jan. 09, 2026 08:30 AM</td></tr>
  <tr><td>Job Openings and Labor Turnover Survey</td><td>November 2025</td><td>Jan. 07, 2026 10:00 AM</td></tr>
  <tr><td>Consumer Price Index</td><td>June 2026</td><td>Jul. 14, 2026 08:30 AM</td></tr>
  <tr><td>County Employment and Wages</td><td>Q3 2025</td><td>Jan. 21, 2026 10:00 AM</td></tr>
  <tr><td>Consumer Price Index</td><td>Unparseable</td><td>sometime soon</td></tr>
  </tbody></table>`;

  const records = bls.parseLaborStatisticsSchedule(fixture);
  const kinds = records.map((record) => record.kind);
  assert.ok(kinds.includes('cpi'));
  assert.ok(kinds.includes('ppi'));
  assert.ok(kinds.includes('payrolls'), 'Employment Situation is the payrolls release');
  assert.ok(kinds.includes('jolts'));
  assert.ok(!kinds.includes('custom'), 'untracked releases are skipped, not filed as custom');
  assert.equal(
    records.filter((record) => record.title === 'County Employment and Wages').length,
    0,
  );

  // 08:30 ET in January is 13:30 UTC (EST, UTC-5).
  const januaryCpi = records.find(
    (record) => record.kind === 'cpi' && record.scheduledAt.startsWith('2026-01'),
  );
  assert.equal(januaryCpi.scheduledAt, '2026-01-13T13:30:00.000Z');

  // 08:30 ET in July is 12:30 UTC (EDT, UTC-4). Same wall clock, different UTC
  // instant — the property a fixed offset would get wrong half the year.
  const julyCpi = records.find(
    (record) => record.kind === 'cpi' && record.scheduledAt.startsWith('2026-07'),
  );
  assert.equal(julyCpi.scheduledAt, '2026-07-14T12:30:00.000Z');

  // A schedule entry has not happened yet.
  assert.equal(januaryCpi.occurredAt, null, 'a future release has no occurredAt');
  assert.equal(januaryCpi.sourceName, 'Bureau of Labor Statistics');
  assert.deepEqual(januaryCpi.values, [
    { label: 'Reference period', actual: 'December 2025', expected: null, previous: null },
  ]);

  // The 10:00 AM JOLTS row keeps its own time rather than the 08:30 default.
  const jolts = records.find((record) => record.kind === 'jolts');
  assert.equal(jolts.scheduledAt, '2026-01-07T15:00:00.000Z');

  assert.equal(bls.classifyLaborRelease('Real Earnings'), null);
  assert.equal(bls.classifyLaborRelease('Unemployment Insurance Weekly Claims'), 'jobless-claims');
  assert.equal(bls.parseEasternDateTime('nonsense', '08:30 AM'), null);
  assert.deepEqual(bls.parseLaborStatisticsSchedule(''), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: BEA schedule, both column orders ---');
{
  const releaseFirst = `<table>
    <tr><td>Personal Income and Outlays, December 2025</td><td>Jan. 30, 2026 08:30 AM</td></tr>
    <tr><td>Gross Domestic Product, 4th Quarter 2025</td><td>Jan. 29, 2026 08:30 AM</td></tr>
    <tr><td>Trade in Goods and Services</td><td>Feb. 05, 2026 08:30 AM</td></tr>
  </table>`;
  const a = bea.parseEconomicAnalysisSchedule(releaseFirst);
  assert.deepEqual(a.map((record) => record.kind).sort(), ['gdp', 'pce']);
  assert.equal(a.find((record) => record.kind === 'pce').scheduledAt, '2026-01-30T13:30:00.000Z');

  const dateFirst = `<table>
    <tr><td>Jan. 30, 2026 08:30 AM</td><td>Personal Income and Outlays</td></tr>
    <tr><td>Jan. 29, 2026 08:30 AM</td><td>Gross Domestic Product</td></tr>
  </table>`;
  const b = bea.parseEconomicAnalysisSchedule(dateFirst);
  assert.deepEqual(
    b.map((record) => record.kind).sort(),
    ['gdp', 'pce'],
    'both column orders parse',
  );

  assert.equal(
    bea.classifyEconomicAnalysisRelease('Personal Income and Outlays'),
    'pce',
    'the PCE release is named Personal Income and Outlays',
  );
  assert.equal(bea.classifyEconomicAnalysisRelease('Trade in Goods'), null);
  assert.deepEqual(bea.parseEconomicAnalysisSchedule(''), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Treasury auctions ---');
{
  const payload = [
    {
      cusip: '912797TX1',
      securityType: 'Bill',
      securityTerm: '13-Week',
      auctionDate: '2026-01-15',
      issueDate: '2026-01-22',
      offeringAmount: '85000000000',
    },
    {
      cusip: '912797TY9',
      securityType: 'Bill',
      securityTerm: '26-Week',
      auctionDate: '2026-01-15',
      issueDate: '2026-01-22',
      offeringAmount: '79000000000',
    },
    { cusip: 'bad', auctionDate: 'not a date' },
    null,
    'nonsense',
  ];
  const records = ust.parseTreasuryAuctions(payload);
  assert.equal(records.length, 2, 'unparseable and non-object rows are skipped');
  assert.equal(new Set(records.map((record) => record.id)).size, 2, 'same-day auctions get distinct ids');
  assert.equal(records[0].kind, 'treasury-auction');
  assert.equal(records[0].occurredAt, null);
  // 13:00 ET in January is 18:00 UTC.
  assert.equal(records[0].scheduledAt, '2026-01-15T18:00:00.000Z');
  assert.ok(records[0].title.includes('13-Week'));
  assert.ok(records[0].values.every((value) => value.actual !== null), 'empty fields are dropped');
  assert.deepEqual(ust.parseTreasuryAuctions(null), []);
  assert.deepEqual(ust.parseTreasuryAuctions({}), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Earnings adapter timing and reported state ---');
{
  const records = earnings.earningsToChartEvents([
    {
      symbol: 'NVDA',
      companyName: 'NVIDIA',
      date: '2026-02-25',
      time: 'amc',
      epsEstimate: 1.2,
      epsActual: 1.35,
      epsSurprisePercent: 12.5,
      source: 'live',
    },
    {
      symbol: 'AAPL',
      companyName: 'Apple',
      date: '2026-01-29',
      time: 'bmo',
      epsEstimate: 2.4,
      source: 'live',
    },
    { symbol: 'BAD', companyName: 'x', date: 'not-a-date', time: 'unknown', epsEstimate: null, source: 'sample' },
  ]);

  assert.equal(records.length, 2, 'an unparseable date is skipped');

  const nvda = records.find((record) => record.title.startsWith('NVDA'));
  // 16:30 ET in February is 21:30 UTC — after the close, so the reaction
  // belongs to the next session.
  assert.equal(nvda.scheduledAt, '2026-02-25T21:30:00.000Z');
  assert.equal(nvda.occurredAt, nvda.scheduledAt, 'a reported EPS means it happened');
  const eps = nvda.values.find((value) => value.label === 'EPS');
  assert.equal(eps.actual, '1.35');
  assert.equal(eps.expected, '1.20');

  const aapl = records.find((record) => record.title.startsWith('AAPL'));
  // 07:30 ET in January is 12:30 UTC — before the open.
  assert.equal(aapl.scheduledAt, '2026-01-29T12:30:00.000Z');
  assert.equal(aapl.occurredAt, null, 'no reported EPS means it has not occurred');
  assert.ok(
    aapl.values.some((value) => value.label === 'Timing' && value.actual === 'Before open'),
  );
  assert.deepEqual(earnings.earningsToChartEvents([]), []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Bundled fallback cannot masquerade as live ---');
{
  assert.ok(bundled.BUNDLED_MACRO_EVENTS.length > 0, 'a fallback schedule ships with the app');
  for (const record of bundled.BUNDLED_MACRO_EVENTS) {
    assert.equal(record.provenance, 'sample', 'bundled records are labelled sample');
    assert.equal(record.occurredAt, null, 'a bundled date has not occurred');
    assert.ok(Number.isFinite(Date.parse(record.scheduledAt)));
  }
  assert.equal(
    new Set(bundled.BUNDLED_MACRO_EVENTS.map((record) => record.id)).size,
    bundled.BUNDLED_MACRO_EVENTS.length,
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: Merging, filtering, and single-source failure ---');
{
  const scheduled = {
    id: 'fed:fomc:2026-01-28:fomc-statement',
    kind: 'fomc',
    title: 'FOMC statement',
    scheduledAt: '2026-01-28T19:00:00.000Z',
    occurredAt: null,
    sourceName: 'Bundled schedule',
    values: [],
    provenance: 'sample',
  };
  const occurred = { ...scheduled, occurredAt: '2026-01-28T19:00:00.000Z', provenance: 'live', sourceName: 'Federal Reserve' };

  // A live record that has occurred supersedes the bundled placeholder.
  const merged = events.mergeEventRecords([scheduled], [occurred]);
  assert.equal(merged.length, 1, 'same id merges rather than duplicating');
  assert.equal(merged[0].provenance, 'live');
  assert.equal(merged[0].occurredAt, '2026-01-28T19:00:00.000Z');

  // The richer record wins regardless of argument order.
  const reversed = events.mergeEventRecords([occurred], [scheduled]);
  assert.equal(reversed[0].provenance, 'live', 'a bundled record never overwrites a live one');

  // Output is chronological.
  const sorted = events.mergeEventRecords(
    [{ ...scheduled, id: 'b', scheduledAt: '2026-03-01T00:00:00.000Z' }],
    [{ ...scheduled, id: 'a', scheduledAt: '2026-02-01T00:00:00.000Z' }],
  );
  assert.deepEqual(sorted.map((record) => record.id), ['a', 'b']);

  // Range filtering is inclusive of the `to` date's whole day.
  const pool = [
    { ...scheduled, id: 'jan', scheduledAt: '2026-01-15T14:00:00.000Z' },
    { ...scheduled, id: 'feb', scheduledAt: '2026-02-15T14:00:00.000Z' },
    { ...scheduled, id: 'mar', scheduledAt: '2026-03-15T14:00:00.000Z', kind: 'cpi' },
  ];
  assert.deepEqual(
    events.filterEventRecords(pool, '2026-02-01', '2026-02-28').map((r) => r.id),
    ['feb'],
  );
  assert.deepEqual(
    events.filterEventRecords(pool, '2026-01-01', '2026-03-31', ['cpi']).map((r) => r.id),
    ['mar'],
    'kind filtering applies',
  );
  assert.deepEqual(
    events.filterEventRecords(pool, '2026-03-15', '2026-03-15').map((r) => r.id),
    ['mar'],
    'a single-day range includes that whole day',
  );

  // One failing source must not empty the calendar. Every fetch throws here,
  // so only the bundled schedule remains — and it still returns records.
  events.setEventFetcherForTests(async () => {
    throw new Error('network down');
  });
  events.setEarningsProvider(async () => []);
  const offline = await events.getChartEvents({
    symbol: 'NVDA',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  assert.ok(offline.length > 0, 'the bundled schedule survives a total network failure');
  assert.ok(
    offline.every((record) => record.provenance === 'sample'),
    'and is honestly labelled',
  );

  // With one source working, its records merge in alongside the bundle.
  events.setEventFetcherForTests(async (url) =>
    url.includes('press_monetary')
      ? `<rss><channel><item><title>Federal Reserve issues FOMC statement</title><pubDate>Wed, 28 Jan 2026 19:00:00 GMT</pubDate></item></channel></rss>`
      : (() => {
          throw new Error('unavailable');
        })(),
  );
  events.setEarningsProvider(async (symbol) => [
    {
      symbol,
      companyName: symbol,
      date: '2026-02-25',
      time: 'amc',
      epsEstimate: 1.2,
      epsActual: 1.35,
      source: 'live',
    },
  ]);
  const partial = await events.getChartEvents({
    symbol: 'NVDA',
    from: '2026-01-01',
    to: '2026-12-31',
  });
  assert.ok(
    partial.some((record) => record.provenance === 'live' && record.kind === 'fomc'),
    'the working source contributes live records',
  );
  assert.ok(
    partial.some((record) => record.kind === 'earnings'),
    'earnings come through the injected provider',
  );

  events.setEventFetcherForTests(null);
  events.setEarningsProvider(null);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll event adapter tests passed successfully!');
