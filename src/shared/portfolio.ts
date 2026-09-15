// The user's own positions.
//
// Naming is load-bearing here. `HoldingsResult` / `Holding` are an ETF's
// constituents; `Portfolio` / `PortfolioPosition` / `PortfolioLot` are what the
// user owns. Conflating them would mean showing a fund's top holdings as
// someone's portfolio, so the two vocabularies never mix and renderer copy says
// "Portfolio" or "My Positions" rather than a bare "Holdings".
//
// Derived market values are NOT persisted. The stored document holds lots and
// cash only; everything priced is recomputed, because a stored market value is
// a number that silently goes stale.

import type { DataSource } from './types';

export type PortfolioAssetType = 'stock' | 'etf' | 'cash';

export type PortfolioAccountType = 'taxable' | 'ira' | 'roth-ira' | '401k' | 'other';

/** One purchase. Cost basis lives at the lot level so average cost is derived
 *  rather than maintained — an average that is stored drifts as lots change. */
export interface PortfolioLot {
  id: string;
  symbol: string;
  quantity: number;
  costPerShare: number;
  acquiredAt: string | null;
  accountId: string;
  note?: string;
}

export interface PortfolioAccount {
  id: string;
  name: string;
  type: PortfolioAccountType;
  currency: 'USD';
  createdAt: string;
}

export interface PortfolioPosition {
  symbol: string;
  assetType: PortfolioAssetType;
  quantity: number;
  averageCost: number | null;
  marketPrice: number | null;
  marketValue: number | null;
  costBasis: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  portfolioWeightPercent: number | null;
  source: DataSource;
}

export interface PortfolioDocumentV3 {
  schemaVersion: 3;
  updatedAt: string;
  baseCurrency: 'USD';
  accounts: PortfolioAccount[];
  lots: PortfolioLot[];
  cashByAccount: Record<string, number>;
}

export interface PortfolioSnapshot {
  asOf: string;
  totalMarketValue: number | null;
  totalCash: number;
  totalCostBasis: number;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  dayChange: number | null;
  dayChangePercent: number | null;
  positions: PortfolioPosition[];
  pricedPositionCount: number;
  /** Symbols held but not priced. Their value is excluded from totals rather
   *  than treated as zero. */
  unpricedSymbols: string[];
  dataHealth: 'complete' | 'partial' | 'unavailable';
}

/** Portfolio context for one symbol, consumed by the chart's Position tab. */
export interface SymbolPortfolioContext {
  owned: boolean;
  quantity: number;
  averageCost: number | null;
  marketValue: number | null;
  unrealizedPnl: number | null;
  weightPercent: number | null;
  componentRiskPercent: number | null;
  indirectExposurePercent: number | null;
}

/**
 * Portfolio-level guidance, kept strictly separate from the instrument signal.
 *
 * The model's conclusion about a symbol must never change because of what the
 * user owns — that would corrupt the historical signal record. So a chart shows
 * two independent statements:
 *
 *   Instrument Decision: BUY CANDIDATE
 *   Portfolio Context:   DO NOT ADD — concentration threshold exceeded
 */
export type PortfolioActionContext =
  | 'not-owned'
  | 'add-compatible'
  | 'concentration-warning'
  | 'risk-budget-warning'
  | 'overlap-warning'
  | 'data-insufficient';

export const PORTFOLIO_ACTION_LABELS: Record<PortfolioActionContext, string> = {
  'not-owned': 'Not held',
  'add-compatible': 'No portfolio constraint triggered',
  'concentration-warning': 'Concentration threshold exceeded',
  'risk-budget-warning': 'Risk contribution threshold exceeded',
  'overlap-warning': 'Known direct plus fund overlap threshold exceeded',
  'data-insufficient': 'Not enough portfolio data to assess',
};

/** Thresholds, not claims of universal optimality — they are settings. */
export interface PortfolioActionThresholds {
  maxPositionWeightPercent: number;
  maxComponentRiskPercent: number;
  maxCombinedExposurePercent: number;
  /** Below this exposure coverage, the answer is "insufficient data" rather
   *  than false reassurance. */
  minimumCoveragePercent: number;
}

export const DEFAULT_PORTFOLIO_ACTION_THRESHOLDS: PortfolioActionThresholds = {
  maxPositionWeightPercent: 20,
  maxComponentRiskPercent: 30,
  maxCombinedExposurePercent: 30,
  minimumCoveragePercent: 60,
};

export function emptyPortfolioDocument(now = new Date().toISOString()): PortfolioDocumentV3 {
  return {
    schemaVersion: 3,
    updatedAt: now,
    baseCurrency: 'USD',
    accounts: [],
    lots: [],
    cashByAccount: {},
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

export interface PortfolioValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validates a whole candidate document before it is written.
 *
 * Whole-document rather than per-field, because the invariants that matter are
 * relational: a lot pointing at a deleted account, or cash filed under an
 * account that does not exist, are both individually well-formed.
 */
export function validatePortfolioDocument(candidate: unknown): PortfolioValidationResult {
  const errors: string[] = [];
  if (!candidate || typeof candidate !== 'object') {
    return { ok: false, errors: ['Portfolio document is not an object.'] };
  }
  const doc = candidate as Partial<PortfolioDocumentV3>;

  if (doc.schemaVersion !== 3) errors.push('schemaVersion must be 3.');
  if (doc.baseCurrency !== 'USD') errors.push('baseCurrency must be USD.');
  if (typeof doc.updatedAt !== 'string' || !Number.isFinite(Date.parse(doc.updatedAt))) {
    errors.push('updatedAt must be an ISO timestamp.');
  }

  const accountIds = new Set<string>();
  if (!Array.isArray(doc.accounts)) {
    errors.push('accounts must be an array.');
  } else {
    for (const account of doc.accounts) {
      if (!account || typeof account !== 'object') {
        errors.push('An account entry is not an object.');
        continue;
      }
      if (typeof account.id !== 'string' || !account.id) {
        errors.push('An account is missing an id.');
        continue;
      }
      if (accountIds.has(account.id)) {
        errors.push(`Duplicate account id: ${account.id}`);
        continue;
      }
      accountIds.add(account.id);
      if (typeof account.name !== 'string' || !account.name.trim()) {
        errors.push(`Account ${account.id} needs a name.`);
      }
      if (account.currency !== 'USD') errors.push(`Account ${account.id} must be USD.`);
      if (
        !['taxable', 'ira', 'roth-ira', '401k', 'other'].includes(
          account.type as PortfolioAccountType,
        )
      ) {
        errors.push(`Account ${account.id} has an unknown type.`);
      }
    }
  }

  const lotIds = new Set<string>();
  if (!Array.isArray(doc.lots)) {
    errors.push('lots must be an array.');
  } else {
    for (const lot of doc.lots) {
      if (!lot || typeof lot !== 'object') {
        errors.push('A lot entry is not an object.');
        continue;
      }
      if (typeof lot.id !== 'string' || !lot.id) {
        errors.push('A lot is missing an id.');
        continue;
      }
      if (lotIds.has(lot.id)) {
        errors.push(`Duplicate lot id: ${lot.id}`);
        continue;
      }
      lotIds.add(lot.id);
      if (typeof lot.symbol !== 'string' || !/^[A-Z0-9.\-^]{1,12}$/.test(lot.symbol)) {
        errors.push(`Lot ${lot.id} has an invalid symbol.`);
      }
      if (!isFiniteNumber(lot.quantity) || lot.quantity <= 0) {
        errors.push(`Lot ${lot.id} quantity must be greater than zero.`);
      }
      if (!isFiniteNumber(lot.costPerShare) || lot.costPerShare < 0) {
        errors.push(`Lot ${lot.id} costPerShare must be zero or greater.`);
      }
      if (lot.acquiredAt !== null && typeof lot.acquiredAt !== 'string') {
        errors.push(`Lot ${lot.id} acquiredAt must be an ISO date or null.`);
      } else if (
        typeof lot.acquiredAt === 'string' &&
        !Number.isFinite(Date.parse(lot.acquiredAt))
      ) {
        errors.push(`Lot ${lot.id} acquiredAt is not a valid date.`);
      }
      if (typeof lot.accountId !== 'string' || !accountIds.has(lot.accountId)) {
        errors.push(`Lot ${lot.id} references an unknown account.`);
      }
      if (lot.note !== undefined && typeof lot.note !== 'string') {
        errors.push(`Lot ${lot.id} note must be a string.`);
      }
    }
  }

  if (!doc.cashByAccount || typeof doc.cashByAccount !== 'object') {
    errors.push('cashByAccount must be an object.');
  } else {
    for (const [accountId, amount] of Object.entries(doc.cashByAccount)) {
      if (!accountIds.has(accountId)) {
        errors.push(`Cash references an unknown account: ${accountId}`);
      }
      if (!isFiniteNumber(amount) || amount < 0) {
        errors.push(`Cash for ${accountId} must be zero or greater.`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function totalPortfolioCash(doc: PortfolioDocumentV3): number {
  return Object.values(doc.cashByAccount).reduce(
    (sum, amount) => sum + (isFiniteNumber(amount) ? amount : 0),
    0,
  );
}
