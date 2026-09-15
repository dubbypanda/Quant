// Composes the portfolio document with live market data.
//
// Everything priced is derived here and nothing derived is persisted, so a
// stale market value cannot outlive the session that produced it. Requests are
// batched and go through the existing quote, history and holdings services so
// provider limits and the Plan 01 persistent cache are honoured rather than
// bypassed.

import type { DataSource } from '../../shared/types';
import type {
  PortfolioActionContext,
  PortfolioAssetType,
  PortfolioSnapshot,
  SymbolPortfolioContext,
} from '../../shared/portfolio';
import { DEFAULT_PORTFOLIO_ACTION_THRESHOLDS, totalPortfolioCash } from '../../shared/portfolio';
import {
  buildPortfolioSnapshot,
  symbolPortfolioContext,
  type PortfolioPriceInput,
} from '../../shared/portfolioAggregation';
import {
  calculatePortfolioRisk,
  type PortfolioRiskReport,
} from '../../shared/portfolioRisk';
import {
  calculatePortfolioExposure,
  portfolioActionContext,
  type PortfolioExposureReport,
} from '../../shared/portfolioExposure';
import { getPortfolioDocument } from './portfolioStore';
import { getQuotes } from './quotes';
import { getDailyHistory } from './dailyHistory';
import { getHoldings } from './holdings';
import { getSymbolDirectory } from './dataFiles';
import { pLimit } from './util';

const HISTORY_CONCURRENCY = 4;
const HOLDINGS_CONCURRENCY = 3;
const BENCHMARK_SYMBOL = 'SPY';
const SNAPSHOT_TTL_MS = 30_000;

interface CachedSnapshot {
  snapshot: PortfolioSnapshot;
  cachedAt: number;
}
let snapshotCache: CachedSnapshot | null = null;

export function clearPortfolioCache(): void {
  snapshotCache = null;
}

/** Asset type from the bundled symbol directory. Unknown symbols default to
 *  `stock`: guessing `etf` would silently enable look-through for something
 *  that is not a fund. */
function assetTypeFor(symbol: string): PortfolioAssetType {
  const entry = getSymbolDirectory().find((item) => item.symbol === symbol);
  return entry?.type === 'etf' ? 'etf' : 'stock';
}

function uniqueSymbols(symbols: string[]): string[] {
  return [...new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean))];
}

export async function getPortfolioSnapshot(force = false): Promise<PortfolioSnapshot> {
  const now = Date.now();
  if (!force && snapshotCache && now - snapshotCache.cachedAt < SNAPSHOT_TTL_MS) {
    return snapshotCache.snapshot;
  }

  const doc = getPortfolioDocument();
  const symbols = uniqueSymbols(doc.lots.map((lot) => lot.symbol));

  let prices: PortfolioPriceInput[] = [];
  if (symbols.length) {
    // One batched quote request rather than one per symbol.
    const quotes = await getQuotes(symbols).catch(() => []);
    const quoteBySymbol = new Map(quotes.map((quote) => [quote.symbol.toUpperCase(), quote]));
    prices = symbols.map((symbol) => {
      const quote = quoteBySymbol.get(symbol);
      return {
        symbol,
        price: quote?.price ?? null,
        previousClose: quote?.previousClose ?? null,
        source: (quote?.source ?? 'sample') as DataSource,
        assetType: assetTypeFor(symbol),
      };
    });
  }

  const snapshot = buildPortfolioSnapshot(doc, prices);
  snapshotCache = { snapshot, cachedAt: now };
  return snapshot;
}

export async function getPortfolioRisk(): Promise<PortfolioRiskReport> {
  const snapshot = await getPortfolioSnapshot();
  const doc = getPortfolioDocument();
  const priced = snapshot.positions.filter((position) => position.marketValue !== null);

  if (!priced.length) {
    return calculatePortfolioRisk({
      positions: snapshot.positions,
      historyBySymbol: {},
      benchmark: [],
      totalCash: totalPortfolioCash(doc),
    });
  }

  const limit = pLimit(HISTORY_CONCURRENCY);
  const histories = await Promise.all(
    priced.map((position) =>
      limit(async () => {
        const history = await getDailyHistory(position.symbol).catch(() => null);
        return [position.symbol, history?.candles ?? []] as const;
      }),
    ),
  );
  const benchmark = await getDailyHistory(BENCHMARK_SYMBOL)
    .then((result) => result.candles)
    .catch(() => []);

  return calculatePortfolioRisk({
    positions: snapshot.positions,
    historyBySymbol: Object.fromEntries(histories),
    benchmark,
    benchmarkSymbol: BENCHMARK_SYMBOL,
    totalCash: totalPortfolioCash(doc),
    // Quant's daily history is raw closes, so the report says so rather than
    // implying split/dividend adjustment it does not have.
    adjusted: false,
    asOf: snapshot.asOf,
  });
}

export async function getPortfolioExposure(): Promise<PortfolioExposureReport> {
  const snapshot = await getPortfolioSnapshot();
  const doc = getPortfolioDocument();
  const funds = snapshot.positions.filter((position) => position.assetType === 'etf');

  const limit = pLimit(HOLDINGS_CONCURRENCY);
  const holdings = await Promise.all(
    funds.map((fund) =>
      limit(async () => {
        const result = await getHoldings(fund.symbol).catch(() => null);
        return [fund.symbol, result] as const;
      }),
    ),
  );

  const directory = getSymbolDirectory();
  const sectorBySymbol: Record<string, string | null> = {};
  for (const position of snapshot.positions) {
    const entry = directory.find((item) => item.symbol === position.symbol) as
      | { symbol: string; sector?: string | null }
      | undefined;
    sectorBySymbol[position.symbol] = entry?.sector ?? null;
  }

  return calculatePortfolioExposure({
    positions: snapshot.positions,
    totalCash: totalPortfolioCash(doc),
    holdingsBySymbol: Object.fromEntries(holdings),
    sectorBySymbol,
  });
}

export interface SymbolPortfolioView {
  context: SymbolPortfolioContext;
  action: PortfolioActionContext;
}

/**
 * Portfolio context for one symbol, for the chart's Position tab.
 *
 * The action context is computed here and returned alongside the position
 * figures — never merged into them, and never allowed to touch the instrument
 * signal. A chart shows two independent statements.
 */
export async function getSymbolPortfolioView(symbolRaw: string): Promise<SymbolPortfolioView> {
  const symbol = symbolRaw.trim().toUpperCase();
  const [snapshot, exposure] = await Promise.all([
    getPortfolioSnapshot(),
    getPortfolioExposure().catch(() => null),
  ]);

  let componentRiskPercent: number | null = null;
  if (snapshot.positions.some((position) => position.symbol === symbol)) {
    const risk = await getPortfolioRisk().catch(() => null);
    componentRiskPercent =
      risk?.contributions.find((item) => item.symbol === symbol)?.componentRiskPercent ?? null;
  }

  const underlying = exposure?.topUnderlying.find((item) => item.symbol === symbol) ?? null;
  const context = symbolPortfolioContext(
    snapshot,
    symbol,
    componentRiskPercent,
    underlying?.indirectWeightPercent ?? null,
  );

  return {
    context,
    action: portfolioActionContext({
      symbol,
      positionWeightPercent: context.weightPercent,
      componentRiskPercent,
      combinedExposurePercent: underlying?.combinedKnownWeightPercent ?? context.weightPercent,
      coveragePercent: exposure?.coveragePercent ?? null,
      thresholds: DEFAULT_PORTFOLIO_ACTION_THRESHOLDS,
    }),
  };
}
