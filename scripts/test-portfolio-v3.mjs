// Portfolio store, aggregation, exposure and CSV import tests
// (docs/quant-v3/03, Tasks 1, 2, 4 and 5).
//
// All fixtures are synthetic. No real personal position data appears here.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = path.join(os.tmpdir(), `quant-portfolio-test-${process.pid}`);
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

const bundle = path.join(tmp, 'portfolio-bundle.mjs');
await build({
  stdin: {
    contents: [
      "export * as contracts from './src/shared/portfolio';",
      "export * as aggregation from './src/shared/portfolioAggregation';",
      "export * as exposure from './src/shared/portfolioExposure';",
      "export * as store from './src/main/services/portfolioStore';",
      "export * as csv from './src/main/services/portfolioImport';",
      "export * as history from './src/main/services/signalHistoryStore';",
    ].join('\n'),
    resolveDir: root,
    loader: 'ts',
    sourcefile: 'portfolio-test-entry.ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  plugins: [electronMock],
  outfile: bundle,
  logLevel: 'silent',
});
const { contracts, aggregation, exposure, store, csv, history } = await import(bundle);

let caseCounter = 0;
function freshStoreRoot() {
  const dir = path.join(tmp, `store-${caseCounter++}`);
  fs.mkdirSync(dir, { recursive: true });
  store.setPortfolioRoot(dir);
  return dir;
}

function doc(overrides = {}) {
  return {
    schemaVersion: 3,
    updatedAt: '2026-09-15T12:00:00.000Z',
    baseCurrency: 'USD',
    accounts: [
      { id: 'acc-1', name: 'Taxable', type: 'taxable', currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
    lots: [],
    cashByAccount: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
console.log('--- Test 1: Document validation is relational, not per-field ---');
{
  assert.equal(contracts.validatePortfolioDocument(doc()).ok, true);
  assert.equal(contracts.validatePortfolioDocument(null).ok, false);
  assert.equal(contracts.validatePortfolioDocument({ schemaVersion: 2 }).ok, false);

  // A lot pointing at an account that does not exist is individually
  // well-formed — this is exactly what whole-document validation is for.
  const orphan = contracts.validatePortfolioDocument(
    doc({
      lots: [
        { id: 'l1', symbol: 'NVDA', quantity: 10, costPerShare: 100, acquiredAt: null, accountId: 'missing' },
      ],
    }),
  );
  assert.equal(orphan.ok, false);
  assert.ok(orphan.errors.some((error) => /unknown account/i.test(error)), orphan.errors.join('; '));

  // Cash filed under a non-existent account, likewise.
  const orphanCash = contracts.validatePortfolioDocument(doc({ cashByAccount: { nope: 100 } }));
  assert.equal(orphanCash.ok, false);
  assert.ok(orphanCash.errors.some((error) => /unknown account/i.test(error)));

  // Duplicate ids.
  const dupAccounts = contracts.validatePortfolioDocument(
    doc({ accounts: [doc().accounts[0], doc().accounts[0]] }),
  );
  assert.equal(dupAccounts.ok, false);
  assert.ok(dupAccounts.errors.some((error) => /Duplicate account/i.test(error)));

  const lot = (overrides) => ({
    id: 'l1',
    symbol: 'NVDA',
    quantity: 10,
    costPerShare: 100,
    acquiredAt: null,
    accountId: 'acc-1',
    ...overrides,
  });
  const dupLots = contracts.validatePortfolioDocument(doc({ lots: [lot({}), lot({})] }));
  assert.ok(dupLots.errors.some((error) => /Duplicate lot/i.test(error)));

  // Numeric and symbol guards.
  for (const [patch, pattern] of [
    [{ quantity: 0 }, /greater than zero/i],
    [{ quantity: -5 }, /greater than zero/i],
    [{ quantity: Number.NaN }, /greater than zero/i],
    [{ quantity: Number.POSITIVE_INFINITY }, /greater than zero/i],
    [{ costPerShare: -1 }, /zero or greater/i],
    [{ symbol: 'not a symbol!' }, /invalid symbol/i],
    [{ symbol: '' }, /invalid symbol/i],
    [{ acquiredAt: 'yesterday' }, /valid date/i],
    [{ acquiredAt: 5 }, /ISO date or null/i],
  ]) {
    const result = contracts.validatePortfolioDocument(doc({ lots: [lot(patch)] }));
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(patch)}`);
    assert.ok(
      result.errors.some((error) => pattern.test(error)),
      `for ${JSON.stringify(patch)} got ${result.errors.join('; ')}`,
    );
  }

  assert.equal(contracts.validatePortfolioDocument(doc({ cashByAccount: { 'acc-1': -1 } })).ok, false);
  assert.equal(contracts.validatePortfolioDocument(doc({ cashByAccount: { 'acc-1': 0 } })).ok, true);
  assert.equal(contracts.totalPortfolioCash(doc({ cashByAccount: { 'acc-1': 250 } })), 250);
}

// ---------------------------------------------------------------------------
console.log('--- Test 2: Atomic writes, backup, and refusal to seed on corruption ---');
{
  const dir = freshStoreRoot();

  // An empty store is empty, not seeded.
  const initial = store.getPortfolioDocument();
  assert.deepEqual(initial.lots, []);
  assert.deepEqual(initial.accounts, []);

  const withAccount = store.addPortfolioAccount({ name: 'Taxable', type: 'taxable', currency: 'USD' });
  assert.equal(withAccount.accounts.length, 1);
  const accountId = withAccount.accounts[0].id;
  assert.match(accountId, /^[0-9a-f-]{36}$/, 'ids are UUIDs');

  const added = store.addPortfolioLot({
    symbol: 'nvda',
    quantity: 10,
    costPerShare: 100,
    accountId,
    acquiredAt: null,
  });
  assert.equal(added.lots.length, 1);
  assert.equal(added.lots[0].symbol, 'NVDA', 'symbols are normalized on write');

  // No temp files survive a successful write.
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')),
    [],
  );

  // A second write produces the backup from the previously committed file.
  const second = store.addPortfolioLot({
    symbol: 'MSFT',
    quantity: 5,
    costPerShare: 300,
    accountId,
    acquiredAt: null,
  });
  assert.equal(second.lots.length, 2);
  const backupPath = path.join(dir, 'portfolio-v3.backup.json');
  assert.ok(fs.existsSync(backupPath), 'a backup exists after the second write');
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  assert.equal(backup.lots.length, 1, 'the backup is the prior good version');

  // Corrupt the primary: the backup is used and a warning is exposed.
  fs.writeFileSync(path.join(dir, 'portfolio-v3.json'), '{ truncated');
  const recovered = store.getPortfolioDocument();
  assert.equal(recovered.lots.length, 1, 'the backup was restored');
  const warning = store.consumePortfolioRecoveryWarning();
  assert.ok(warning && /previous good version/i.test(warning), warning);
  assert.equal(store.consumePortfolioRecoveryWarning(), null, 'the warning is consumed once');

  // Corrupt both: empty, warned, and explicitly NOT seeded.
  fs.writeFileSync(backupPath, 'also broken');
  const empty = store.getPortfolioDocument();
  assert.deepEqual(empty.lots, [], 'no positions are fabricated');
  assert.deepEqual(empty.accounts, []);
  const bothWarning = store.consumePortfolioRecoveryWarning();
  assert.ok(bothWarning && /could not be read/i.test(bothWarning), bothWarning);
  assert.ok(/nothing was deleted/i.test(bothWarning), 'the user is told nothing was lost on disk');

  // A primary that parses but fails validation is treated as corrupt.
  fs.writeFileSync(
    path.join(dir, 'portfolio-v3.json'),
    JSON.stringify({ schemaVersion: 3, updatedAt: 'x', baseCurrency: 'EUR', accounts: [], lots: [], cashByAccount: {} }),
  );
  fs.rmSync(backupPath);
  assert.deepEqual(store.getPortfolioDocument().lots, []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 3: Store mutations reject invalid input ---');
{
  freshStoreRoot();
  const withAccount = store.addPortfolioAccount({ name: 'IRA', type: 'ira', currency: 'USD' });
  const accountId = withAccount.accounts[0].id;

  assert.throws(
    () => store.addPortfolioLot({ symbol: 'bad symbol', quantity: 1, costPerShare: 1, accountId, acquiredAt: null }),
    /Invalid symbol/,
  );
  assert.throws(
    () => store.addPortfolioLot({ symbol: 'NVDA', quantity: 0, costPerShare: 1, accountId, acquiredAt: null }),
    /greater than zero/,
  );
  assert.throws(
    () => store.addPortfolioLot({ symbol: 'NVDA', quantity: 1, costPerShare: 1, accountId: 'nope', acquiredAt: null }),
    /unknown account/i,
  );
  assert.throws(() => store.removePortfolioLot('missing'), /No lot with id/);
  assert.throws(() => store.updatePortfolioLot('missing', { quantity: 5 }), /No lot with id/);
  assert.throws(() => store.setAccountCash('missing', 100), /No account with id/);
  assert.throws(() => store.setAccountCash(accountId, -5), /zero or greater/);
  assert.throws(() => store.setAccountCash(accountId, Number.NaN), /finite/);

  const lotDoc = store.addPortfolioLot({
    symbol: 'NVDA',
    quantity: 10,
    costPerShare: 100,
    accountId,
    acquiredAt: null,
  });
  const lotId = lotDoc.lots[0].id;
  assert.equal(store.updatePortfolioLot(lotId, { quantity: 20 }).lots[0].quantity, 20);
  assert.throws(() => store.updatePortfolioLot(lotId, { quantity: -1 }), /greater than zero/);
  assert.equal(store.setAccountCash(accountId, 1_000).cashByAccount[accountId], 1_000);

  // Deleting an account that still holds positions is refused with an
  // actionable message rather than a validation error about orphans.
  assert.throws(() => store.removePortfolioAccount(accountId), /reassign/i);
  store.removePortfolioLot(lotId);
  assert.equal(store.removePortfolioAccount(accountId).accounts.length, 0);

  // A batch import is one write: a partial failure applies nothing.
  freshStoreRoot();
  const batchAccount = store.addPortfolioAccount({ name: 'Batch', type: 'other', currency: 'USD' })
    .accounts[0].id;
  assert.throws(
    () =>
      store.addPortfolioLots([
        { symbol: 'NVDA', quantity: 1, costPerShare: 1, accountId: batchAccount, acquiredAt: null },
        { symbol: 'not valid', quantity: 1, costPerShare: 1, accountId: batchAccount, acquiredAt: null },
      ]),
    /Invalid symbol/,
  );
  assert.equal(store.getPortfolioDocument().lots.length, 0, 'nothing was half-applied');
}

// ---------------------------------------------------------------------------
console.log('--- Test 4: Aggregation is exact, and a missing price is not zero ---');
{
  const document = doc({
    lots: [
      // Two lots of the same symbol: 10 @ $100 and 30 @ $140 -> avg $130.
      { id: 'l1', symbol: 'NVDA', quantity: 10, costPerShare: 100, acquiredAt: null, accountId: 'acc-1' },
      { id: 'l2', symbol: 'NVDA', quantity: 30, costPerShare: 140, acquiredAt: null, accountId: 'acc-1' },
      { id: 'l3', symbol: 'MSFT', quantity: 10, costPerShare: 300, acquiredAt: null, accountId: 'acc-1' },
    ],
    cashByAccount: { 'acc-1': 2_000 },
  });

  const positions = aggregation.aggregatePortfolioPositions(document, [
    { symbol: 'NVDA', price: 150, previousClose: 145, source: 'live' },
    { symbol: 'MSFT', price: 400, previousClose: 400, source: 'live' },
  ]);

  const nvda = positions.find((position) => position.symbol === 'NVDA');
  assert.equal(nvda.quantity, 40);
  assert.equal(nvda.costBasis, 10 * 100 + 30 * 140);
  assert.equal(nvda.averageCost, 5_200 / 40, 'weighted average cost, not a simple mean');
  assert.equal(nvda.averageCost, 130);
  assert.equal(nvda.marketValue, 6_000);
  assert.equal(nvda.unrealizedPnl, 800);
  assert.ok(Math.abs(nvda.unrealizedPnlPercent - (800 / 5_200) * 100) < 1e-9);
  assert.equal(nvda.dayChange, (150 - 145) * 40);
  assert.ok(Math.abs(nvda.dayChangePercent - (5 / 145) * 100) < 1e-9);

  // Weight denominator is priced value plus cash: 6000 + 4000 + 2000 = 12000.
  assert.ok(Math.abs(nvda.portfolioWeightPercent - 50) < 1e-9, `${nvda.portfolioWeightPercent}`);

  // Now drop the MSFT price. Its quantity and cost basis survive; its market
  // metrics are null; and it leaves the denominator rather than counting zero.
  const partial = aggregation.aggregatePortfolioPositions(document, [
    { symbol: 'NVDA', price: 150, previousClose: 145, source: 'live' },
  ]);
  const unpricedMsft = partial.find((position) => position.symbol === 'MSFT');
  assert.equal(unpricedMsft.quantity, 10, 'quantity is preserved');
  assert.equal(unpricedMsft.costBasis, 3_000, 'cost basis is preserved');
  assert.equal(unpricedMsft.marketValue, null, 'a missing price is not zero');
  assert.equal(unpricedMsft.unrealizedPnl, null);
  assert.equal(unpricedMsft.portfolioWeightPercent, null);

  const pricedNvda = partial.find((position) => position.symbol === 'NVDA');
  // Denominator is now 6000 + 2000 = 8000, so NVDA is 75% — not 50%, and not
  // the 100% it would be if cash were excluded.
  assert.ok(Math.abs(pricedNvda.portfolioWeightPercent - 75) < 1e-9, `${pricedNvda.portfolioWeightPercent}`);

  // Snapshot totals.
  const snapshot = aggregation.buildPortfolioSnapshot(document, [
    { symbol: 'NVDA', price: 150, previousClose: 145, source: 'live' },
  ]);
  assert.equal(snapshot.dataHealth, 'partial');
  assert.deepEqual(snapshot.unpricedSymbols, ['MSFT']);
  assert.equal(snapshot.pricedPositionCount, 1);
  assert.equal(snapshot.totalMarketValue, 8_000);
  assert.equal(snapshot.totalCash, 2_000);
  assert.equal(snapshot.totalCostBasis, 8_200, 'cost basis covers unpriced positions too');
  // P/L is measured only against what could be priced: 6000 - 5200.
  assert.equal(snapshot.unrealizedPnl, 800);

  const complete = aggregation.buildPortfolioSnapshot(document, [
    { symbol: 'NVDA', price: 150, previousClose: 145, source: 'live' },
    { symbol: 'MSFT', price: 400, previousClose: 400, source: 'live' },
  ]);
  assert.equal(complete.dataHealth, 'complete');
  assert.equal(complete.totalMarketValue, 12_000);
  assert.equal(complete.unrealizedPnl, 12_000 - 2_000 - 8_200);

  const nothingPriced = aggregation.buildPortfolioSnapshot(document, []);
  assert.equal(nothingPriced.dataHealth, 'unavailable');
  assert.equal(nothingPriced.totalMarketValue, null);
  assert.equal(nothingPriced.unrealizedPnl, null);

  // An empty portfolio is complete, not an error state.
  const emptySnapshot = aggregation.buildPortfolioSnapshot(doc(), []);
  assert.equal(emptySnapshot.dataHealth, 'complete');
  assert.equal(emptySnapshot.totalMarketValue, 0);
  assert.deepEqual(emptySnapshot.positions, []);

  // Cash-only is fully knowable.
  const cashOnly = aggregation.buildPortfolioSnapshot(doc({ cashByAccount: { 'acc-1': 5_000 } }), []);
  assert.equal(cashOnly.totalMarketValue, 5_000);
  assert.equal(cashOnly.dataHealth, 'complete');

  // Symbol context for the chart Position tab.
  const context = aggregation.symbolPortfolioContext(complete, 'nvda', 23.7, 4.1);
  assert.equal(context.owned, true);
  assert.equal(context.quantity, 40);
  assert.equal(context.componentRiskPercent, 23.7);
  assert.equal(context.indirectExposurePercent, 4.1);
  const notOwned = aggregation.symbolPortfolioContext(complete, 'TSLA');
  assert.equal(notOwned.owned, false);
  assert.equal(notOwned.quantity, 0);
  assert.equal(notOwned.weightPercent, null);
}

// ---------------------------------------------------------------------------
console.log('--- Test 5: Exposure keeps direct and indirect separate ---');
{
  const positions = [
    { symbol: 'NVDA', assetType: 'stock', quantity: 10, averageCost: 100, marketPrice: 150, marketValue: 1_500, costBasis: 1_000, unrealizedPnl: 500, unrealizedPnlPercent: 50, dayChange: 0, dayChangePercent: 0, portfolioWeightPercent: 30, source: 'live' },
    { symbol: 'VOO', assetType: 'etf', quantity: 10, averageCost: 350, marketPrice: 350, marketValue: 3_500, costBasis: 3_500, unrealizedPnl: 0, unrealizedPnlPercent: 0, dayChange: 0, dayChangePercent: 0, portfolioWeightPercent: 70, source: 'live' },
  ];

  const report = exposure.calculatePortfolioExposure({
    positions,
    totalCash: 0,
    holdingsBySymbol: {
      // Synthetic fund: 10% NVDA, 5% MSFT. Top holdings only, so 85% of the
      // fund is unknown.
      VOO: {
        etfSymbol: 'VOO',
        asOf: '2026-09-01',
        source: 'live',
        holdings: [
          { symbol: 'NVDA', name: 'NVIDIA', weightPercent: 10 },
          { symbol: 'MSFT', name: 'Microsoft', weightPercent: 5 },
        ],
      },
    },
    sectorBySymbol: { NVDA: 'Technology', VOO: null },
  });

  // Direct weights: 1500/5000 = 30%, 3500/5000 = 70%.
  const directByKey = Object.fromEntries(report.direct.map((slice) => [slice.key, slice.weightPercent]));
  assert.equal(directByKey.NVDA, 30);
  assert.equal(directByKey.VOO, 70);

  // NVDA is held directly AND inside the fund. The two columns stay separate
  // and are summed only in the explicitly named combined field.
  const nvda = report.topUnderlying.find((item) => item.symbol === 'NVDA');
  assert.equal(nvda.directWeightPercent, 30);
  assert.equal(nvda.indirectWeightPercent, 7, '10% of a 3500 fund position is 350, i.e. 7%');
  assert.equal(nvda.combinedKnownWeightPercent, 37);
  assert.equal(
    nvda.directWeightPercent + nvda.indirectWeightPercent,
    nvda.combinedKnownWeightPercent,
    'combined is the explicit sum, and neither column double-counts',
  );

  // A fund constituent not held directly has no direct weight.
  const msft = report.topUnderlying.find((item) => item.symbol === 'MSFT');
  assert.equal(msft.directWeightPercent, 0);
  assert.equal(msft.indirectWeightPercent, 3.5);

  // The fund itself is not listed as its own underlying holding.
  assert.ok(report.topUnderlying.some((item) => item.symbol === 'VOO'), 'the fund keeps its direct row');

  // Coverage is honest about the 85% of the fund we cannot see.
  assert.ok(report.coveragePercent < 100, `expected partial coverage, got ${report.coveragePercent}`);
  assert.ok(report.warnings.some((warning) => /top holdings only/i.test(warning)));
  assert.ok(report.warnings.some((warning) => /covers/i.test(warning)));

  // Unclassified value is named, not dropped.
  const sectorByKey = Object.fromEntries(report.sector.map((slice) => [slice.key, slice.weightPercent]));
  assert.equal(sectorByKey.Technology, 30);
  assert.equal(sectorByKey.Unclassified, 70, 'the unclassified share is visible');
  assert.ok(
    Math.abs(Object.values(sectorByKey).reduce((sum, value) => sum + value, 0) - 100) < 0.01,
    'sector weights account for the whole portfolio',
  );

  // Concentration is over direct positions, so an index fund is one decision.
  assert.equal(report.concentration.top1Percent, 70);
  assert.equal(report.concentration.top3Percent, 100);
  assert.equal(report.concentration.hhi, 30 * 30 + 70 * 70);

  // A fund with no constituent data is reported as unknown, not as zero.
  const noHoldings = exposure.calculatePortfolioExposure({
    positions,
    holdingsBySymbol: { VOO: null },
    sectorBySymbol: {},
  });
  assert.ok(noHoldings.warnings.some((warning) => /no constituent data/i.test(warning)));
  assert.equal(
    noHoldings.topUnderlying.find((item) => item.symbol === 'MSFT'),
    undefined,
    'no underlying is invented without data',
  );

  // Cash participates in the denominator and appears as its own slice.
  const withCash = exposure.calculatePortfolioExposure({ positions, totalCash: 5_000 });
  const cashSlice = withCash.direct.find((slice) => slice.key === 'CASH');
  assert.equal(cashSlice.weightPercent, 50);

  const nothing = exposure.calculatePortfolioExposure({ positions: [], totalCash: 0 });
  assert.equal(nothing.coveragePercent, 0);
  assert.deepEqual(nothing.direct, []);
}

// ---------------------------------------------------------------------------
console.log('--- Test 6: Portfolio action context never blends with the signal ---');
{
  const thresholds = contracts.DEFAULT_PORTFOLIO_ACTION_THRESHOLDS;
  const call = (overrides) =>
    exposure.portfolioActionContext({
      symbol: 'NVDA',
      positionWeightPercent: 5,
      componentRiskPercent: 5,
      combinedExposurePercent: 5,
      coveragePercent: 100,
      thresholds,
      ...overrides,
    });

  assert.equal(call({}), 'add-compatible');
  assert.equal(
    call({ positionWeightPercent: null, combinedExposurePercent: null }),
    'not-owned',
  );
  assert.equal(call({ positionWeightPercent: 25 }), 'concentration-warning');
  assert.equal(call({ componentRiskPercent: 35 }), 'risk-budget-warning');
  assert.equal(call({ combinedExposurePercent: 40 }), 'overlap-warning');
  assert.equal(call({ coveragePercent: 20 }), 'data-insufficient');
  assert.equal(call({ coveragePercent: null }), 'data-insufficient');

  // A warning outranks incomplete coverage: partial data may downgrade a
  // verdict but must never upgrade one into false reassurance.
  assert.equal(
    call({ positionWeightPercent: 25, coveragePercent: 10 }),
    'concentration-warning',
  );

  // Every context has user-facing copy.
  for (const key of Object.keys(contracts.PORTFOLIO_ACTION_LABELS)) {
    assert.ok(contracts.PORTFOLIO_ACTION_LABELS[key].length > 0, `${key} needs a label`);
  }
  // The vocabularies are disjoint: no portfolio context can be mistaken for an
  // instrument decision.
  const instrumentDecisions = ['buy-candidate', 'short-candidate', 'wait', 'no-trade', 'invalidated'];
  for (const key of Object.keys(contracts.PORTFOLIO_ACTION_LABELS)) {
    assert.ok(!instrumentDecisions.includes(key), `${key} collides with an instrument decision`);
  }
}

// ---------------------------------------------------------------------------
console.log('--- Test 7: CSV parsing, detection, and no silent skipping ---');
{
  // Quoted commas, escaped quotes, CRLF, and a UTF-8 BOM.
  const text =
    '﻿Symbol,Quantity,Cost Per Share,Account,Acquired\r\n' +
    'NVDA,10,100.50,"Taxable, Main",2026-01-15\r\n' +
    '"MSFT",5,"1,300.00",Taxable,2026-02-01\r\n' +
    'AAPL,"2.5",$180.25,Taxable,\r\n' +
    ',10,100,Taxable,2026-01-01\r\n' +
    'BADQTY,0,100,Taxable,2026-01-01\r\n' +
    'BADDATE,1,100,Taxable,not-a-date\r\n' +
    'NOCOST,1,,Taxable,2026-01-01\r\n' +
    'WEIRD"NAME,1,100,Taxable,2026-01-01\r\n';

  const rows = csv.parseCsv(text);
  assert.equal(rows[0][0], 'Symbol', 'the BOM is stripped from the first header cell');
  assert.equal(rows[1][3], 'Taxable, Main', 'a quoted comma stays inside its field');

  const preview = csv.buildCsvPreview({ text });
  assert.deepEqual(preview.header, ['Symbol', 'Quantity', 'Cost Per Share', 'Account', 'Acquired']);
  assert.equal(preview.detectedMapping.symbol, 0);
  assert.equal(preview.detectedMapping.quantity, 1);
  assert.equal(preview.detectedMapping.cost_per_share, 2);
  assert.equal(preview.detectedMapping.account, 3);
  assert.equal(preview.detectedMapping.acquired_at, 4);

  // Every row is reported, valid or not — nothing is silently skipped.
  assert.equal(preview.rows.length, 8, 'all data rows appear in the preview');
  assert.equal(preview.validRowCount + preview.invalidRowCount, preview.rows.length);

  const byNumber = Object.fromEntries(preview.rows.map((row) => [row.rowNumber, row]));
  assert.equal(byNumber[1].symbol, 'NVDA');
  assert.equal(byNumber[1].quantity, 10);
  assert.equal(byNumber[1].costPerShare, 100.5);
  assert.equal(byNumber[1].accountName, 'Taxable, Main');
  assert.ok(byNumber[1].acquiredAt.startsWith('2026-01-15'));

  assert.equal(byNumber[2].costPerShare, 1_300, 'thousands separators parse');
  assert.equal(byNumber[3].costPerShare, 180.25, 'currency symbols parse');
  assert.equal(byNumber[3].quantity, 2.5, 'fractional shares parse');
  assert.equal(byNumber[3].acquiredAt, null, 'an empty date is null, not an error');
  assert.equal(byNumber[3].valid, true);

  // Each rejection carries its row number and a reason.
  assert.equal(byNumber[4].valid, false);
  assert.ok(byNumber[4].errors.some((error) => /Missing symbol/i.test(error)));
  assert.equal(byNumber[5].valid, false);
  assert.ok(byNumber[5].errors.some((error) => /greater than zero/i.test(error)));
  assert.equal(byNumber[6].valid, false);
  assert.ok(byNumber[6].errors.some((error) => /Unrecognised date/i.test(error)));
  assert.equal(byNumber[7].valid, false);
  assert.ok(byNumber[7].errors.some((error) => /Missing or unreadable cost/i.test(error)));
  assert.equal(byNumber[8].valid, false);
  assert.ok(byNumber[8].errors.some((error) => /Invalid symbol/i.test(error)));
  for (const row of preview.rows) {
    if (!row.valid) assert.ok(row.errors.length > 0, `row ${row.rowNumber} has no reason`);
  }

  // A total-cost column is divided by quantity.
  const totalCost = csv.buildCsvPreview({
    text: 'symbol,shares,total cost\nNVDA,10,1000\n',
  });
  assert.equal(totalCost.rows[0].costPerShare, 100);
  assert.equal(totalCost.rows[0].valid, true);

  // Loose header matching must not let "Total Cost Basis" claim the
  // per-share column.
  const ambiguous = csv.detectCsvMapping(['Ticker', 'Shares', 'Total Cost Basis']);
  assert.equal(ambiguous.symbol, 0);
  assert.equal(ambiguous.quantity, 1);
  assert.equal(ambiguous.total_cost, 2);
  assert.equal(ambiguous.cost_per_share, undefined);

  // Missing required columns produce warnings rather than an empty success.
  const noColumns = csv.buildCsvPreview({ text: 'a,b,c\n1,2,3\n' });
  assert.ok(noColumns.warnings.some((warning) => /symbol/i.test(warning)));
  assert.ok(noColumns.warnings.some((warning) => /quantity/i.test(warning)));
  assert.ok(noColumns.warnings.some((warning) => /cost/i.test(warning)));
  assert.equal(noColumns.validRowCount, 0);

  assert.equal(csv.buildCsvPreview({ text: '' }).rows.length, 0);
  assert.ok(csv.buildCsvPreview({ text: '' }).warnings.length > 0);
  assert.equal(csv.parseCsvNumber('(1,234.50)'), -1234.5, 'parenthesised negatives parse');
  assert.equal(csv.parseCsvNumber('--'), null);
  assert.equal(csv.parseCsvNumber(null), null);

  // Only valid rows become lots, and an unknown account name falls back to the
  // chosen account rather than creating one implicitly.
  const document = doc({
    accounts: [
      { id: 'acc-1', name: 'Taxable', type: 'taxable', currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'acc-2', name: 'IRA', type: 'ira', currency: 'USD', createdAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const lots = csv.csvPreviewToLots(
    csv.buildCsvPreview({ text: 'symbol,qty,price,account\nNVDA,10,100,IRA\nMSFT,5,300,Unknown Acct\n' }),
    'acc-1',
    document,
  );
  assert.equal(lots.length, 2);
  assert.equal(lots.find((lot) => lot.symbol === 'NVDA').accountId, 'acc-2', 'a known name maps');
  assert.equal(
    lots.find((lot) => lot.symbol === 'MSFT').accountId,
    'acc-1',
    'an unknown name falls back rather than creating an account',
  );
}

// ---------------------------------------------------------------------------
console.log('--- Test 8: Portfolio weights cannot mutate a stored signal (Task 8) ---');
{
  // The regression this guards: a portfolio rule reaching back into the signal
  // record. A stored snapshot is what the model said at the time; ownership is
  // a separate fact about the user. If concentration could rewrite a snapshot,
  // the historical signal record would become a function of today's portfolio.
  const historyPath = path.join(tmp, 'signal-history-task8.json');
  const evaluation = {
    symbol: 'NVDA',
    timeframe: '1d',
    signalBarTime: 1_700_000_000,
    setupType: 'breakout',
    decision: 'buy-candidate',
    direction: 'long',
    regime: 'trending-up',
    setupQuality: 81,
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
  };
  const snapshot = history.appendSignalSnapshot(
    { evaluation, dataCutoffTime: 1_700_000_000, observedAt: '2026-05-01T21:00:00.000Z' },
    historyPath,
  );
  const before = JSON.stringify(
    history.getSignalHistory('NVDA', undefined, undefined, historyPath),
  );

  // Now build a portfolio wildly over-concentrated in NVDA and take every
  // portfolio-side reading available.
  freshStoreRoot();
  const accountId = store.addPortfolioAccount({ name: 'Taxable', type: 'taxable', currency: 'USD' })
    .accounts[0].id;
  store.addPortfolioLot({
    symbol: 'NVDA',
    quantity: 1_000,
    costPerShare: 50,
    accountId,
    acquiredAt: null,
  });
  const document = store.getPortfolioDocument();
  const portfolioSnapshot = aggregation.buildPortfolioSnapshot(document, [
    { symbol: 'NVDA', price: 150, previousClose: 149, source: 'live' },
  ]);

  const nvda = portfolioSnapshot.positions.find((position) => position.symbol === 'NVDA');
  assert.ok(nvda.portfolioWeightPercent > 90, 'the fixture really is over-concentrated');

  const action = exposure.portfolioActionContext({
    symbol: 'NVDA',
    positionWeightPercent: nvda.portfolioWeightPercent,
    componentRiskPercent: 100,
    combinedExposurePercent: nvda.portfolioWeightPercent,
    coveragePercent: 100,
    thresholds: contracts.DEFAULT_PORTFOLIO_ACTION_THRESHOLDS,
  });
  assert.equal(action, 'concentration-warning', 'the portfolio-side verdict is a warning');

  // The two outputs coexist and stay distinct.
  const stored = history.getSignalHistory('NVDA', undefined, undefined, historyPath);
  assert.equal(
    JSON.stringify(stored),
    before,
    'the stored signal snapshot is byte-identical after the portfolio changed',
  );
  assert.equal(stored[0].decision, 'buy-candidate', 'the instrument decision still says buy');
  assert.equal(stored[0].setupQuality, 81);
  assert.deepEqual(stored[0].noTradeReasons, [], 'no portfolio reason leaked into the signal');
  assert.equal(snapshot.decision, 'buy-candidate');

  // And the portfolio context carries no signal field that could be confused
  // for the model's conclusion.
  const context = aggregation.symbolPortfolioContext(portfolioSnapshot, 'NVDA', 100, null);
  assert.equal('decision' in context, false);
  assert.equal('setupQuality' in context, false);
}

store.setPortfolioRoot(null);
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nAll portfolio tests passed successfully!');
