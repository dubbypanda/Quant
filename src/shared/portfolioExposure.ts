// Portfolio exposure: where the money actually is, including through funds.
//
// The honesty constraint that shapes this module: Quant has an ETF's *top*
// holdings, not a guaranteed complete constituent set. So look-through is
// explicitly partial and `coveragePercent` reports how much portfolio value had
// known classification. Reporting a tidy 100% sector breakdown from top-10
// holdings would be false precision, which is worse than an honest gap.
//
// Direct and indirect exposure are also kept in separate columns and summed
// only in an explicitly named `combinedKnownWeightPercent`. Adding them
// silently would double-count a symbol the user holds directly and also owns
// inside an ETF.

import type { HoldingsResult } from './types';
import type { PortfolioPosition } from './portfolio';

export interface ExposureSlice {
  key: string;
  weightPercent: number;
}

export interface UnderlyingExposure {
  symbol: string;
  directWeightPercent: number;
  indirectWeightPercent: number;
  combinedKnownWeightPercent: number;
}

export interface PortfolioExposureReport {
  direct: ExposureSlice[];
  assetType: ExposureSlice[];
  sector: ExposureSlice[];
  topUnderlying: UnderlyingExposure[];
  concentration: {
    top1Percent: number;
    top3Percent: number;
    top5Percent: number;
    /** Herfindahl-Hirschman index over direct weights, 0-10000. */
    hhi: number;
  };
  coveragePercent: number;
  warnings: string[];
}

export interface PortfolioExposureInput {
  positions: PortfolioPosition[];
  totalCash?: number;
  /** ETF constituents by fund symbol, from the existing holdings service. */
  holdingsBySymbol?: Record<string, HoldingsResult | null>;
  /** Sector per symbol, when metadata exists. */
  sectorBySymbol?: Record<string, string | null>;
  maxUnderlying?: number;
}

const DEFAULT_MAX_UNDERLYING = 10;

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sortSlices(slices: ExposureSlice[]): ExposureSlice[] {
  return slices.sort((a, b) => b.weightPercent - a.weightPercent);
}

export function calculatePortfolioExposure(
  input: PortfolioExposureInput,
): PortfolioExposureReport {
  const warnings: string[] = [];
  const cash = Math.max(0, input.totalCash ?? 0);
  const maxUnderlying = input.maxUnderlying ?? DEFAULT_MAX_UNDERLYING;

  const priced = input.positions.filter((position) => position.marketValue !== null);
  const unpriced = input.positions.filter((position) => position.marketValue === null);
  const pricedValue = priced.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);
  const total = pricedValue + cash;

  if (unpriced.length) {
    warnings.push(
      `${unpriced.length} position${unpriced.length === 1 ? '' : 's'} could not be priced and are excluded from exposure.`,
    );
  }

  if (total <= 0) {
    return {
      direct: [],
      assetType: [],
      sector: [],
      topUnderlying: [],
      concentration: { top1Percent: 0, top3Percent: 0, top5Percent: 0, hhi: 0 },
      coveragePercent: 0,
      warnings: [...warnings, 'No priced value, so exposure cannot be calculated.'],
    };
  }

  // ---- Direct weights -------------------------------------------------
  const direct: ExposureSlice[] = priced.map((position) => ({
    key: position.symbol,
    weightPercent: ((position.marketValue ?? 0) / total) * 100,
  }));
  if (cash > 0) direct.push({ key: 'CASH', weightPercent: (cash / total) * 100 });

  // ---- Asset type -----------------------------------------------------
  const byAssetType = new Map<string, number>();
  for (const position of priced) {
    const key = position.assetType;
    byAssetType.set(key, (byAssetType.get(key) ?? 0) + (position.marketValue ?? 0));
  }
  if (cash > 0) byAssetType.set('cash', (byAssetType.get('cash') ?? 0) + cash);
  const assetType: ExposureSlice[] = [...byAssetType.entries()].map(([key, value]) => ({
    key,
    weightPercent: (value / total) * 100,
  }));

  // ---- Sector, with explicit unknown --------------------------------
  const sectorBySymbol = input.sectorBySymbol ?? {};
  const bySector = new Map<string, number>();
  let classifiedValue = cash; // cash is classified: it is cash
  for (const position of priced) {
    const sector = sectorBySymbol[position.symbol];
    if (sector) {
      bySector.set(sector, (bySector.get(sector) ?? 0) + (position.marketValue ?? 0));
      classifiedValue += position.marketValue ?? 0;
    } else {
      // Named rather than omitted: a breakdown that silently drops 30% of the
      // portfolio reads as a complete picture.
      bySector.set('Unclassified', (bySector.get('Unclassified') ?? 0) + (position.marketValue ?? 0));
    }
  }
  if (cash > 0) bySector.set('Cash', (bySector.get('Cash') ?? 0) + cash);
  const sector: ExposureSlice[] = [...bySector.entries()].map(([key, value]) => ({
    key,
    weightPercent: (value / total) * 100,
  }));

  // ---- Look-through ---------------------------------------------------
  const holdingsBySymbol = input.holdingsBySymbol ?? {};
  const directBySymbol = new Map<string, number>();
  for (const position of priced) {
    directBySymbol.set(
      position.symbol,
      (directBySymbol.get(position.symbol) ?? 0) + (position.marketValue ?? 0),
    );
  }

  const indirectBySymbol = new Map<string, number>();
  let fundsWithHoldings = 0;
  let fundsWithoutHoldings = 0;
  let coveredFundValue = 0;
  for (const position of priced) {
    if (position.assetType !== 'etf') continue;
    const holdings = holdingsBySymbol[position.symbol];
    if (!holdings || !holdings.holdings.length) {
      fundsWithoutHoldings += 1;
      continue;
    }
    fundsWithHoldings += 1;
    const fundValue = position.marketValue ?? 0;
    let knownWeight = 0;
    for (const holding of holdings.holdings) {
      const weight = holding.weightPercent;
      if (weight === null || !Number.isFinite(weight) || weight <= 0) continue;
      const symbol = holding.symbol.trim().toUpperCase();
      if (!symbol) continue;
      knownWeight += weight;
      indirectBySymbol.set(
        symbol,
        (indirectBySymbol.get(symbol) ?? 0) + fundValue * (weight / 100),
      );
    }
    // Only the share of the fund whose constituents are known counts toward
    // coverage. The rest is a real gap.
    coveredFundValue += fundValue * Math.min(1, knownWeight / 100);
  }

  if (fundsWithoutHoldings > 0) {
    warnings.push(
      `${fundsWithoutHoldings} fund${fundsWithoutHoldings === 1 ? '' : 's'} had no constituent data, so their underlying exposure is unknown.`,
    );
  }
  if (fundsWithHoldings > 0) {
    warnings.push(
      'Fund look-through uses top holdings only, so underlying exposure is a floor rather than a complete figure.',
    );
  }

  const underlyingSymbols = new Set([...directBySymbol.keys(), ...indirectBySymbol.keys()]);
  const topUnderlying: UnderlyingExposure[] = [...underlyingSymbols]
    .map((symbol) => {
      const directValue = directBySymbol.get(symbol) ?? 0;
      const indirectValue = indirectBySymbol.get(symbol) ?? 0;
      return {
        symbol,
        directWeightPercent: round((directValue / total) * 100),
        indirectWeightPercent: round((indirectValue / total) * 100),
        // Named "combinedKnown" precisely because it is a sum of two columns
        // that are each individually complete but jointly a floor.
        combinedKnownWeightPercent: round(((directValue + indirectValue) / total) * 100),
      };
    })
    .sort((a, b) => b.combinedKnownWeightPercent - a.combinedKnownWeightPercent)
    .slice(0, maxUnderlying);

  // ---- Concentration --------------------------------------------------
  // Over direct positions only: a fund is one decision, and exploding it into
  // constituents here would make a diversified index fund look concentrated.
  const positionWeights = priced
    .map((position) => ((position.marketValue ?? 0) / total) * 100)
    .sort((a, b) => b - a);
  const take = (count: number) =>
    round(positionWeights.slice(0, count).reduce((sum, value) => sum + value, 0));
  const hhi = round(
    positionWeights.reduce((sum, weight) => sum + weight * weight, 0),
    0,
  );

  // Classified value plus the share of fund value we could see inside.
  const coveragePercent = round(Math.min(100, ((classifiedValue + coveredFundValue) / total) * 100));
  if (coveragePercent < 100) {
    warnings.push(
      `Known classification covers ${coveragePercent.toFixed(1)}% of portfolio value.`,
    );
  }

  return {
    direct: sortSlices(direct.map((slice) => ({ ...slice, weightPercent: round(slice.weightPercent) }))),
    assetType: sortSlices(
      assetType.map((slice) => ({ ...slice, weightPercent: round(slice.weightPercent) })),
    ),
    sector: sortSlices(sector.map((slice) => ({ ...slice, weightPercent: round(slice.weightPercent) }))),
    topUnderlying,
    concentration: {
      top1Percent: take(1),
      top3Percent: take(3),
      top5Percent: take(5),
      hhi,
    },
    coveragePercent,
    warnings,
  };
}

/**
 * Deterministic portfolio-level guidance for one symbol.
 *
 * Computed entirely separately from the instrument signal, and returned as its
 * own value so a surface must render two statements rather than one blended
 * verdict. A portfolio rule may never rewrite what the model said.
 */
export function portfolioActionContext(args: {
  symbol: string;
  positionWeightPercent: number | null;
  componentRiskPercent: number | null;
  combinedExposurePercent: number | null;
  coveragePercent: number | null;
  thresholds: import('./portfolio').PortfolioActionThresholds;
}): import('./portfolio').PortfolioActionContext {
  const {
    positionWeightPercent,
    componentRiskPercent,
    combinedExposurePercent,
    coveragePercent,
    thresholds,
  } = args;

  const notHeld =
    (positionWeightPercent === null || positionWeightPercent <= 0) &&
    (combinedExposurePercent === null || combinedExposurePercent <= 0);
  if (notHeld) return 'not-owned';

  // Warnings are checked before the reassuring answer, and incomplete coverage
  // can only ever downgrade the verdict — never produce false reassurance.
  if (positionWeightPercent !== null && positionWeightPercent > thresholds.maxPositionWeightPercent) {
    return 'concentration-warning';
  }
  if (componentRiskPercent !== null && componentRiskPercent > thresholds.maxComponentRiskPercent) {
    return 'risk-budget-warning';
  }
  if (
    combinedExposurePercent !== null &&
    combinedExposurePercent > thresholds.maxCombinedExposurePercent
  ) {
    return 'overlap-warning';
  }
  if (coveragePercent === null || coveragePercent < thresholds.minimumCoveragePercent) {
    return 'data-insufficient';
  }
  return 'add-compatible';
}
