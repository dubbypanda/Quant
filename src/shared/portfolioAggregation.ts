// Pure portfolio aggregation: lots plus prices become positions.
//
// The rule that shapes everything here: **a missing price is not zero**. An
// unpriced position keeps its quantity and cost basis, reports null market
// metrics, is excluded from the weight denominator, and is named in
// `unpricedSymbols` so the UI can say the totals are incomplete. Valuing it at
// zero would understate the portfolio and overstate every other weight.

import type { DataSource } from './types';
import type {
  PortfolioAssetType,
  PortfolioDocumentV3,
  PortfolioPosition,
  PortfolioSnapshot,
} from './portfolio';
import { totalPortfolioCash } from './portfolio';

export interface PortfolioPriceInput {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  source: DataSource;
  assetType?: PortfolioAssetType;
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Aggregates lots into one position per symbol.
 *
 * Weights are computed against priced market value plus cash. Cash belongs in
 * the denominator because a portfolio that is half cash genuinely has half its
 * value in cash — leaving it out would report every position at double its real
 * weight.
 */
export function aggregatePortfolioPositions(
  doc: PortfolioDocumentV3,
  prices: PortfolioPriceInput[],
): PortfolioPosition[] {
  const priceBySymbol = new Map(
    prices.map((price) => [price.symbol.trim().toUpperCase(), price]),
  );

  interface Accumulator {
    symbol: string;
    quantity: number;
    costBasis: number;
  }
  const bySymbol = new Map<string, Accumulator>();
  for (const lot of doc.lots) {
    const symbol = lot.symbol.trim().toUpperCase();
    const entry = bySymbol.get(symbol) ?? { symbol, quantity: 0, costBasis: 0 };
    entry.quantity += lot.quantity;
    entry.costBasis += lot.quantity * lot.costPerShare;
    bySymbol.set(symbol, entry);
  }

  const cash = totalPortfolioCash(doc);

  // First pass: value what can be valued. The denominator has to be known
  // before any weight can be assigned.
  const valued = [...bySymbol.values()].map((entry) => {
    const price = priceBySymbol.get(entry.symbol);
    const marketPrice = finite(price?.price ?? null);
    const marketValue = marketPrice === null ? null : entry.quantity * marketPrice;
    return { entry, price, marketPrice, marketValue };
  });

  const pricedMarketValue = valued.reduce(
    (sum, item) => sum + (item.marketValue ?? 0),
    0,
  );
  const denominator = pricedMarketValue + cash;

  return valued
    .map(({ entry, price, marketPrice, marketValue }) => {
      const costBasis = entry.costBasis;
      const averageCost = entry.quantity > 0 ? costBasis / entry.quantity : null;
      const previousClose = finite(price?.previousClose ?? null);
      const unrealizedPnl = marketValue === null ? null : marketValue - costBasis;
      const unrealizedPnlPercent =
        unrealizedPnl === null || costBasis <= 0 ? null : (unrealizedPnl / costBasis) * 100;
      const dayChange =
        marketPrice === null || previousClose === null
          ? null
          : (marketPrice - previousClose) * entry.quantity;
      const dayChangePercent =
        marketPrice === null || previousClose === null || previousClose === 0
          ? null
          : ((marketPrice - previousClose) / previousClose) * 100;

      return {
        symbol: entry.symbol,
        assetType: price?.assetType ?? 'stock',
        quantity: entry.quantity,
        averageCost,
        marketPrice,
        marketValue,
        costBasis,
        unrealizedPnl,
        unrealizedPnlPercent,
        dayChange,
        dayChangePercent,
        portfolioWeightPercent:
          marketValue === null || denominator <= 0 ? null : (marketValue / denominator) * 100,
        source: price?.source ?? 'sample',
      } satisfies PortfolioPosition;
    })
    .sort((a, b) => (b.marketValue ?? -1) - (a.marketValue ?? -1));
}

/**
 * Builds the snapshot totals.
 *
 * `totalMarketValue` is null only when nothing at all could be priced and there
 * is no cash — an all-cash portfolio has a perfectly knowable value.
 */
export function buildPortfolioSnapshot(
  doc: PortfolioDocumentV3,
  prices: PortfolioPriceInput[],
  asOf = new Date().toISOString(),
): PortfolioSnapshot {
  const positions = aggregatePortfolioPositions(doc, prices);
  const cash = totalPortfolioCash(doc);

  const priced = positions.filter((position) => position.marketValue !== null);
  const unpricedSymbols = positions
    .filter((position) => position.marketValue === null)
    .map((position) => position.symbol);

  const pricedMarketValue = priced.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  // Cost basis covers every position, priced or not: it is known from the lots
  // and does not depend on market data.
  const totalCostBasis = positions.reduce((sum, position) => sum + (position.costBasis ?? 0), 0);

  const hasPositions = positions.length > 0;
  const totalMarketValue =
    !hasPositions || priced.length > 0 ? pricedMarketValue + cash : null;

  // P/L is only meaningful against the cost basis of the positions that could
  // actually be priced; mixing in an unpriced position's basis would report a
  // loss equal to its entire cost.
  const pricedCostBasis = priced.reduce((sum, position) => sum + (position.costBasis ?? 0), 0);
  const unrealizedPnl = priced.length > 0 ? pricedMarketValue - pricedCostBasis : null;
  const unrealizedPnlPercent =
    unrealizedPnl === null || pricedCostBasis <= 0 ? null : (unrealizedPnl / pricedCostBasis) * 100;

  const dayChangeContributions = priced.filter((position) => position.dayChange !== null);
  const dayChange =
    dayChangeContributions.length > 0
      ? dayChangeContributions.reduce((sum, position) => sum + (position.dayChange ?? 0), 0)
      : null;
  const previousValue =
    dayChangeContributions.length > 0
      ? dayChangeContributions.reduce(
          (sum, position) => sum + ((position.marketValue ?? 0) - (position.dayChange ?? 0)),
          0,
        ) + cash
      : 0;
  const dayChangePercent =
    dayChange === null || previousValue <= 0 ? null : (dayChange / previousValue) * 100;

  const dataHealth: PortfolioSnapshot['dataHealth'] = !hasPositions
    ? 'complete'
    : unpricedSymbols.length === 0
      ? 'complete'
      : priced.length === 0
        ? 'unavailable'
        : 'partial';

  return {
    asOf,
    totalMarketValue,
    totalCash: cash,
    totalCostBasis,
    unrealizedPnl,
    unrealizedPnlPercent,
    dayChange,
    dayChangePercent,
    positions,
    pricedPositionCount: priced.length,
    unpricedSymbols,
    dataHealth,
  };
}

/** Portfolio context for one symbol, for the chart's Position tab. */
export function symbolPortfolioContext(
  snapshot: PortfolioSnapshot,
  symbolRaw: string,
  componentRiskPercent: number | null = null,
  indirectExposurePercent: number | null = null,
): import('./portfolio').SymbolPortfolioContext {
  const symbol = symbolRaw.trim().toUpperCase();
  const position = snapshot.positions.find((item) => item.symbol === symbol);
  if (!position) {
    return {
      owned: false,
      quantity: 0,
      averageCost: null,
      marketValue: null,
      unrealizedPnl: null,
      weightPercent: null,
      componentRiskPercent: null,
      indirectExposurePercent,
    };
  }
  return {
    owned: true,
    quantity: position.quantity,
    averageCost: position.averageCost,
    marketValue: position.marketValue,
    unrealizedPnl: position.unrealizedPnl,
    weightPercent: position.portfolioWeightPercent,
    componentRiskPercent,
    indirectExposurePercent,
  };
}
