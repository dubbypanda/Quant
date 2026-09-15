# Quant 3.0 — Personal Portfolio & Risk Engine

> **For agentic workers:** Implement after Plan 01 and in parallel with the non-Position portions of Plan 02. Use test-first changes. Do not add GitHub Actions.

**Target release:** `3.0.0`

**Goal:** Make Quant a genuinely personal terminal by tracking what the user owns locally, calculating portfolio exposure/risk, and connecting every owned position to chart research and daily attention ranking.

**Architecture:** Portfolio data is private, local-first, and independent from watchlist/ETF-constituent data. The Electron main process owns versioned portfolio storage and deterministic analytics; the renderer receives normalized snapshots through IPC. Quant 3.0 supports manual entry and CSV import, not broker authentication or trade execution.

## Global Constraints

- Never confuse `HoldingsResult` (ETF constituents) with the user's portfolio.
- No brokerage login, OAuth, order placement, or transaction execution in 3.0.
- Do not commit personal portfolio fixtures containing real user positions.
- Store portfolio data only under `app.getPath('userData')` unless the user explicitly exports it.
- All return/risk calculations must identify the price date and data source used.
- Missing market data yields explicit `unavailable` metrics; do not silently substitute zero.
- Portfolio calculations consume Plan 01's persistent chart/history cache when available.
- No GitHub Actions.

---

## 1. Domain Separation

Rename nothing in the existing ETF holdings API during the first migration; instead establish explicit new naming:

```text
ETF constituents        -> HoldingsResult / Holding (existing)
User-owned positions    -> Portfolio / PortfolioPosition / PortfolioLot (new)
```

Renderer copy must use `Portfolio` or `My Positions`, never generic `Holdings` where ambiguity exists.

---

## 2. Canonical Contracts

Add `src/shared/portfolio.ts`.

```ts
export type PortfolioAssetType = 'stock' | 'etf' | 'cash';

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
  type: 'taxable' | 'ira' | 'roth-ira' | '401k' | 'other';
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
```

Do not store derived market values in the persistent document. Recalculate them from lots + current market data.

---

## 3. Storage

Create `src/main/services/portfolioStore.ts`.

Path:

```text
<userData>/portfolio-v3.json
```

Persistence rules:

1. Validate the whole candidate document before write.
2. Write `portfolio-v3.json.tmp`.
3. Rename atomically.
4. Retain `portfolio-v3.backup.json` containing the prior successfully parsed version.
5. On corruption: try backup; if backup also fails, expose a recoverable error and initialize no positions. Do not fabricate a seeded portfolio.

Required API:

```ts
export function getPortfolioDocument(): PortfolioDocumentV3;
export function replacePortfolioDocument(doc: PortfolioDocumentV3): PortfolioDocumentV3;
export function addPortfolioLot(input: Omit<PortfolioLot, 'id'>): PortfolioDocumentV3;
export function updatePortfolioLot(id: string, patch: Partial<Pick<PortfolioLot,
  'quantity' | 'costPerShare' | 'acquiredAt' | 'accountId' | 'note'>>): PortfolioDocumentV3;
export function removePortfolioLot(id: string): PortfolioDocumentV3;
export function setAccountCash(accountId: string, amount: number): PortfolioDocumentV3;
```

IDs use `crypto.randomUUID()`.

Validation:

- symbol normalized with existing `normalizeSymbol`;
- quantity > 0;
- costPerShare >= 0;
- cash may be >= 0;
- account IDs must exist;
- no NaN/Infinity;
- acquiredAt is ISO date or null.

---

## 4. Portfolio Aggregation

Create `src/shared/portfolioAggregation.ts` as pure logic.

Required API:

```ts
export interface PortfolioPriceInput {
  symbol: string;
  price: number | null;
  previousClose: number | null;
  source: DataSource;
}

export function aggregatePortfolioPositions(
  doc: PortfolioDocumentV3,
  prices: PortfolioPriceInput[],
): PortfolioPosition[];
```

Rules:

```text
quantity = sum(lot.quantity)
costBasis = sum(quantity * costPerShare)
averageCost = costBasis / quantity
marketValue = quantity * marketPrice
unrealizedPnl = marketValue - costBasis
weight = marketValue / (all priced positions + cash)
```

If a symbol price is missing:

- preserve quantity/cost basis;
- market metrics are null;
- exclude unpriced market value from percentage denominator and expose an incomplete-data warning in the portfolio snapshot.

Do not value missing assets at zero.

---

## 5. Portfolio Snapshot

Add:

```ts
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
  unpricedSymbols: string[];
  dataHealth: 'complete' | 'partial' | 'unavailable';
}
```

Create `src/main/services/portfolioService.ts`:

```ts
export async function getPortfolioSnapshot(): Promise<PortfolioSnapshot>;
```

Use existing quote/chart services; batch requests and honor provider/cache limits.

---

## 6. Risk Engine

Create `src/shared/portfolioRisk.ts`.

Risk is calculated from daily adjusted/normalized price return histories when available. If only raw closes exist, document that limitation in the result provenance.

Required result:

```ts
export interface PositionRiskContribution {
  symbol: string;
  weightPercent: number;
  annualizedVolatilityPercent: number | null;
  betaToSpy: number | null;
  marginalRiskContribution: number | null;
  componentRiskPercent: number | null;
}

export interface PortfolioRiskReport {
  asOf: string;
  lookbackTradingDays: number;
  annualizedVolatilityPercent: number | null;
  betaToSpy: number | null;
  maxDrawdownPercent: number | null;
  oneDayVaR95Percent: number | null;
  oneDayCVaR95Percent: number | null;
  diversificationRatio: number | null;
  contributions: PositionRiskContribution[];
  warnings: string[];
}
```

Default lookback: `252` completed daily bars; minimum usable overlap: `60`.

### Core formulas

For return matrix `R`, weights `w`, covariance `Σ`:

```text
portfolio variance = wᵀ Σ w
portfolio volatility = sqrt(wᵀ Σ w) * sqrt(252)
marginal contribution_i = (Σw)_i / sqrt(wᵀΣw)
component contribution_i = w_i * marginal contribution_i
component risk % = component contribution_i / sum(component contribution)
```

Beta to SPY:

```text
beta = cov(portfolioReturn, spyReturn) / var(spyReturn)
```

Historical VaR/CVaR:

- VaR95 = empirical 5th percentile of daily portfolio returns expressed as positive loss magnitude;
- CVaR95 = mean loss magnitude of observations at or below that percentile.

Do not assume normality for VaR/CVaR.

### Missing-data policy

Use date intersection, not forward-filled stock returns. Report symbols excluded due to insufficient overlap. If excluded priced positions exceed 20% of non-cash market value, portfolio risk is `partial` and UI must show warning.

---

## 7. Exposure Engine

Create `src/shared/portfolioExposure.ts`.

3.0 supports:

- direct symbol weights;
- stock vs ETF vs cash;
- sector exposure when symbol metadata exists;
- ETF look-through exposure using existing `HoldingsResult` top constituents;
- concentration indicators.

Required output:

```ts
export interface PortfolioExposureReport {
  direct: Array<{ key: string; weightPercent: number }>;
  assetType: Array<{ key: string; weightPercent: number }>;
  sector: Array<{ key: string; weightPercent: number }>;
  topUnderlying: Array<{
    symbol: string;
    directWeightPercent: number;
    indirectWeightPercent: number;
    combinedKnownWeightPercent: number;
  }>;
  concentration: {
    top1Percent: number;
    top3Percent: number;
    top5Percent: number;
    hhi: number;
  };
  coveragePercent: number;
  warnings: string[];
}
```

ETF look-through is explicitly partial because Quant currently has top-holdings data, not guaranteed complete fund constituent sets. `coveragePercent` communicates how much portfolio value had known classification.

---

## 8. CSV Import

Create `src/main/services/portfolioImport.ts`.

Do not build broker-specific parsers into the core domain. Implement a normalized CSV import with mapping preview.

Minimum accepted semantic columns:

```text
symbol
quantity
cost_per_share OR total_cost
account (optional)
acquired_at (optional)
```

Required flow:

```text
Select CSV
→ parse locally
→ detect likely columns
→ show mapping preview
→ validate rows
→ show exact additions/errors
→ explicit Import button
→ atomic portfolio update
```

Never silently skip invalid rows. The preview must list row number + reason.

CSV parser must correctly handle quoted commas and UTF-8 BOM. If a small parser dependency is introduced, it must be pure JS and packaging-safe.

---

## 9. IPC Contracts

Add channels:

```ts
portfolioGet: 'portfolio:get',
portfolioSnapshotGet: 'portfolio:snapshot-get',
portfolioRiskGet: 'portfolio:risk-get',
portfolioExposureGet: 'portfolio:exposure-get',
portfolioLotAdd: 'portfolio:lot-add',
portfolioLotUpdate: 'portfolio:lot-update',
portfolioLotRemove: 'portfolio:lot-remove',
portfolioCashSet: 'portfolio:cash-set',
portfolioCsvPreview: 'portfolio:csv-preview',
portfolioCsvImport: 'portfolio:csv-import',
```

All writes validate again in the main process. Renderer validation is usability only, not authority.

---

## 10. Portfolio UI

Create:

```text
src/renderer/components/portfolio/
  PortfolioPage.tsx
  PortfolioSummary.tsx
  PositionsTable.tsx
  RiskPanel.tsx
  ExposurePanel.tsx
  PositionEditor.tsx
  CsvImportDialog.tsx
```

Primary layout:

```text
Portfolio Value      Day Change       Unrealized P/L       Cash

[allocation strip / risk status]

Positions
Symbol | Qty | Avg Cost | Price | Value | Day | Total P/L | Weight | Risk %

Risk                  Exposure
Volatility            Asset types
Beta vs SPY           Sectors
Max drawdown           Underlying overlap
CVaR                   Concentration
```

Keep UI flat and terminal-like. Avoid one card per metric.

---

## 11. Chart Integration

Plan 02's `ResearchInspector` Position tab consumes:

```ts
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
```

On an owned ticker chart, show:

```text
Your Position
120 shares
Avg cost $60.00
Portfolio weight 14.2%
Risk contribution 23.7%
```

Do not draw cost-basis or lot lines on chart by default. Provide an explicit `Position` overlay toggle to prevent clutter.

---

## 12. Portfolio-Aware Decision Layer

Do **not** rewrite the authoritative instrument signal based on ownership.

Maintain two distinct outputs:

```text
Instrument Decision: BUY CANDIDATE
Portfolio Context: DO NOT ADD — concentration threshold exceeded
```

Create:

```ts
export type PortfolioActionContext =
  | 'not-owned'
  | 'add-compatible'
  | 'concentration-warning'
  | 'risk-budget-warning'
  | 'data-insufficient';
```

This prevents a portfolio rule from corrupting the model's historical signal truth.

Initial deterministic warnings:

- direct position weight > 20% → concentration warning;
- component risk contribution > 30% → risk warning;
- known combined direct + ETF look-through exposure > 30% → overlap warning;
- incomplete exposure coverage → warning, never false reassurance.

Thresholds are settings, not claims of universal optimality.

---

## 13. Implementation Tasks

### Task 1 — Add portfolio contracts and validated local store

Create pure schema validation tests, atomic write tests, backup recovery tests, and duplicate-account rejection tests.

### Task 2 — Aggregation and snapshot service

Use synthetic lots and quote fixtures; assert weighted average cost and P/L exactly.

### Task 3 — Risk mathematics

Tests must cover:

- single asset;
- two perfectly correlated assets;
- two imperfectly correlated assets;
- cash-only portfolio;
- missing return history;
- date intersection;
- VaR/CVaR sign conventions;
- component contributions summing to ~100% when complete.

Tolerance for floating-point contribution sum: `±0.01 percentage point`.

### Task 4 — Exposure/look-through

Use synthetic ETF constituent fixtures. Assert direct and indirect exposure are never double-counted inside their individual columns and combined weight is explicit.

### Task 5 — IPC write/read boundary

Attempt invalid writes from test harness and prove main-process validation rejects them.

### Task 6 — Portfolio page

Add navigation entry `Portfolio`. The page must work with an empty portfolio and provide `Add position` + `Import CSV`, not an error state.

### Task 7 — Chart Position inspector

Wire `SymbolPortfolioContext` into Plan 02 without coupling ChartStage to portfolio store internals.

### Task 8 — Portfolio-aware action context

Compute warning context separately from Signal Engine V2/QRM. Add a regression test proving changing portfolio weights cannot mutate an immutable historical signal snapshot.

---

## 14. Verification

Add scripts:

```json
"test:portfolio-v3": "node scripts/test-portfolio-v3.mjs",
"test:portfolio-risk-v3": "node scripts/test-portfolio-risk-v3.mjs"
```

Required:

```bash
npm run typecheck
npm run test:market-data-v3
npm run test:portfolio-v3
npm run test:portfolio-risk-v3
npm run test:signal-v2
npm run build
npm run smoke
npm run smoke:modal
```

No GitHub Actions.

---

## 15. Definition of Done

- User can create accounts/positions and enter cash locally.
- User can import a CSV through a preview + explicit confirmation flow.
- Quant shows quantity, average cost, market value, daily change, P/L, and portfolio weight.
- Quant computes volatility, SPY beta, max drawdown, historical VaR/CVaR, and risk contribution when data is sufficient.
- ETF look-through exposure is shown with coverage/warnings instead of false precision.
- Owned symbols show portfolio context in the chart workspace.
- Instrument signal and portfolio action context remain separate concepts.
- No real personal position data exists in repository fixtures.
- All portfolio state survives restart and recovers safely from corrupted primary storage.

## 16. Dependency Order

Requires Plan 01 market-data contracts. Integrates into Plan 02's Position inspector. Plan 04 consumes portfolio risk/exposure to calculate personal attention relevance. Plan 05 may consume portfolio constraints for utility/risk context but must never train or calibrate the market model on the user's private holdings.