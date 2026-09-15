# Quant 3.0 — Full-Market Discovery & Personal Attention Engine

> **For agentic workers:** Implement after Plan 01. Portfolio relevance portions depend on Plan 03. Use test-first changes. Do not add GitHub Actions.

**Target release:** `3.0.0`

**Goal:** Replace Quant 2.1's prefix-limited signal scan with an honest full-universe research discovery pipeline that identifies what changed, what is statistically unusual, and what deserves investigation today — then personalizes the ranking using portfolio relevance without turning it into an order recommendation.

**Architecture:** Use a two-stage funnel. Stage A computes cheap normalized features for the hydrated universe from persistent daily-bar cache. Stage B runs expensive Signal Engine / historical validation only on a bounded candidate set. A separate Attention Engine ranks candidates by independent evidence groups, novelty, data quality, and optional portfolio relevance.

## Global Constraints

- Discovery output is `Research Candidate`, not `Buy Recommendation`.
- Never claim full-market coverage unless the scan actually covered the eligible universe; always expose coverage counts and data dates.
- Do not silently rank symbols with stale or incomplete data as if they were current.
- Stocks and ETFs remain separately filterable.
- Leveraged/inverse/single-stock ETF filtering must be explicit metadata policy if used; do not infer solely from ticker names.
- The existing Signal Engine V2 remains authoritative for its own `BUY CANDIDATE`/`SHORT CANDIDATE` output; Discovery does not alter its historical rules.
- No GitHub Actions.

---

## 1. Problem Being Replaced

Quant 2.1 `signalScanner.ts` currently constructs a universe and then performs:

```ts
const selected = universe.slice(0, request.limit);
```

With defaults near 120 and a hard cap of 500, this means `us-stocks` is not an unbiased market-wide discovery operation. Quant 3.0 must remove the semantic mismatch between `US stocks` and `first N directory rows`.

The 3.0 scanner must answer:

```text
Universe size
Hydrated with current-enough history
Eligible after data/liquidity rules
Actually scanned
Candidate count
Deep-analyzed count
As-of session
```

---

## 2. New Workspace Semantics

Primary navigation becomes:

```text
Today | Portfolio | Discover | Research | Lab
```

`Discover` answers:

> What is statistically or structurally interesting now?

`Today` answers:

> Of those changes, what deserves my attention first given what I own and what changed since the previous scan?

Do not make Today a duplicate sorted table of Discover.

---

## 3. Universe Contract

Create `src/shared/discovery.ts`.

```ts
export type DiscoveryAssetType = 'stock' | 'etf';

export interface DiscoveryUniverseMember {
  symbol: string;
  name: string;
  assetType: DiscoveryAssetType;
  exchange: string;
  active: boolean;
  sector?: string;
  industry?: string;
  leveraged?: boolean;
  inverse?: boolean;
  singleStockEtf?: boolean;
}

export interface UniverseCoverage {
  universeCount: number;
  hydratedCount: number;
  eligibleCount: number;
  scannedCount: number;
  currentSessionCount: number;
  staleCount: number;
  failedCount: number;
  asOf: string;
}
```

Universe source initially derives from the existing symbol directory plus explicit metadata enrichment. No UI may call this `all U.S. securities`; use `Quant U.S. universe` and show the count.

---

## 4. Universe Hydration

Create `src/main/services/universeHydrator.ts`.

Purpose: maintain enough daily history to make discovery cheap after the first hydration.

Required behavior:

- use Plan 01 persistent market cache;
- desired history per symbol: minimum 260 completed daily bars;
- use bounded request concurrency (`6` default, configurable 2–10);
- process symbols in deterministic batches;
- newest/stale/missing cache entries first;
- prioritize portfolio + watchlist before broad universe;
- persist progress so restart resumes instead of beginning at symbol zero;
- do not block app startup.

Required API:

```ts
export interface UniverseHydrationStatus {
  running: boolean;
  total: number;
  complete: number;
  current: string[];
  failed: number;
  startedAt: string | null;
  updatedAt: string;
}

export function getUniverseHydrationStatus(): UniverseHydrationStatus;
export async function startUniverseHydration(): Promise<void>;
export function stopUniverseHydration(): void;
```

This is an app-runtime background job, not a cloud/background promise. It exists only while Quant runs.

Failure policy:

- exponential delay per repeatedly failing symbol;
- no infinite tight retry loops;
- failures recorded with last attempt timestamp;
- a symbol failure cannot stop the batch.

---

## 5. Eligibility Rules

Create pure `evaluateDiscoveryEligibility()`.

Initial defaults:

```ts
export interface DiscoveryEligibilitySettings {
  minimumPrice: number;              // default 2
  minimumMedianDollarVolume20: number; // default 5_000_000
  minimumHistoryBars: number;        // default 140; 260 preferred
  includeEtfs: boolean;              // default true
  includeLeveragedEtfs: boolean;     // default false
  includeInverseEtfs: boolean;       // default false
  includeSingleStockEtfs: boolean;   // default false
}
```

Dollar volume:

```text
median(close * volume) over last 20 completed daily bars
```

The user can relax liquidity thresholds, but the result must visibly flag low-liquidity candidates rather than hide the fact.

---

## 6. Stage A — Fast Feature Engine

Create `src/shared/discoveryFeatures.ts`.

Input is cached daily candles + optional benchmark/sector histories. No network I/O.

Required feature vector:

```ts
export interface DiscoveryFeatures {
  symbol: string;
  asOf: number;
  return1: number | null;
  return5: number | null;
  return20: number | null;
  return63: number | null;
  return126: number | null;
  realizedVol20: number | null;
  atrPercent14: number | null;
  volumeRatio20: number | null;
  dollarVolumeMedian20: number | null;
  distanceMa20Atr: number | null;
  distanceMa50Atr: number | null;
  distanceMa200Percent: number | null;
  distance52wHighPercent: number | null;
  returnZ20: number | null;
  volumeZ60: number | null;
  volatilityRatio20To60: number | null;
  spyResidual5: number | null;
  spyResidual20: number | null;
  sectorResidual5: number | null;
  sectorResidual20: number | null;
  relativeStrengthPercentile126: number | null;
  regime: MarketRegime;
  priorRegime: MarketRegime | null;
}
```

### Robust abnormal-return score

Do not use raw percent move alone. For returns `r` over a rolling baseline:

```text
median = median(r)
MAD = median(|r - median|)
robustSigma = max(1e-8, 1.4826 * MAD)
z = (currentReturn - median) / robustSigma
```

Cap only the display contribution, not the stored raw z-score.

### Residual move

Initial deterministic residual:

```text
asset return - beta60 * SPY return
```

where beta60 uses overlapping daily returns and requires >= 40 observations. Sector residual is equivalent using a mapped sector ETF when metadata exists.

No regression result is produced when overlap is inadequate.

---

## 7. Cross-Sectional Percentiles

Create `src/shared/discoveryRanking.ts`.

Percentiles are calculated only among candidates with comparable, current-enough data for that metric.

Required helper:

```ts
export function percentileRank(
  values: Array<{ symbol: string; value: number | null }>,
): Map<string, number | null>;
```

Tie handling must be deterministic using average rank, then symbol only for display ordering.

Do not compare a stale Friday row to current Monday rows without marking the stale row ineligible for current-session ranking.

---

## 8. Evidence Groups, Not Indicator Pile-Up

Quant 2.x can reward correlated indicators repeatedly. Quant 3.0 Attention Score must group evidence and cap each group.

```ts
export interface AttentionComponents {
  abnormalMove: number;      // 0..20
  participation: number;     // 0..15
  relativeStrength: number;  // 0..15
  structuralChange: number;  // 0..15
  modelEvidence: number;     // 0..15
  novelty: number;           // 0..10
  personalRelevance: number; // 0..10
  qualityPenalty: number;    // 0..30 subtraction
}
```

Final:

```text
attentionScore = clamp(
  abnormalMove + participation + relativeStrength + structuralChange +
  modelEvidence + novelty + personalRelevance - qualityPenalty,
  0, 100
)
```

This is a ranking heuristic, not a calibrated probability. UI must say `Attention`, not `Confidence`.

### Group examples

`abnormalMove` can use max/capped combination of return robust-z and benchmark residual percentile; it must not award full points independently for 1D, 5D, and 20D versions of the same move.

`participation` uses abnormal volume and dollar-liquidity quality.

`relativeStrength` uses cross-sectional 126D and sector-relative evidence.

`structuralChange` rewards new regime transition, MA structure change, volatility expansion, breakout/compression state change.

`modelEvidence` is zero during Stage A and populated after Stage B.

---

## 9. Novelty Engine

Create `src/main/services/discoveryHistoryStore.ts` and pure `src/shared/discoveryNovelty.ts`.

Persist daily/scan snapshots:

```text
<userData>/discovery-history-v3/
  2026-09-15T190000Z.json.gz
  latest.json.gz
```

Keep 30 days by default.

Novelty is based on **change in state**, not absolute bullishness:

```ts
export interface NoveltyResult {
  score: number; // 0..10
  changes: string[];
}
```

Examples that increase novelty:

- regime changed since prior completed scan;
- robust return z crossed from <1 to >2;
- volume z crossed from normal to >2;
- relative-strength percentile jumped >= 20 points;
- symbol was not top-100 previously and enters top-25 now;
- Signal Engine decision changed.

Repeatedly strong but unchanged symbols should naturally lose novelty points.

---

## 10. Stage A Candidate Funnel

Default:

```text
Hydrated eligible universe: variable, target thousands
↓ Stage A feature compute
Top 300 Attention-preliminary candidates
↓ Stage B
Top 50 deep candidates
↓ Today shortlist
Top 10–20 attention items
```

The numbers are configurable ceilings, not claims that exactly 5,000 symbols are always available.

Stage A must complete without calling Signal Engine historical replay for every symbol.

Performance target on a modern desktop once history is cached:

- feature compute for 5,000 symbols: target < 5 seconds;
- renderer must remain responsive;
- if target is missed, move compute to worker thread before reducing universe dishonestly.

---

## 11. Stage B — Deep Research Candidate Pass

Create `src/main/services/discoveryDeepScan.ts`.

For preliminary top 300:

1. run deterministic Signal Engine core;
2. retain setup type/quality/decision;
3. calculate pattern tags;
4. select top 50 by revised Attention Score;
5. run expensive setup-specific historical validation only on top 50;
6. update model evidence using historical evidence strength/expectancy without interpreting it as guaranteed edge.

Do not run Kronos/QRM on all 300 in 3.0. Plan 05 may run heavy models only on the final shortlist or explicit user request.

---

## 12. Model Evidence Contribution

Initial V2 contribution is conservative.

Example mapping:

```text
no directional candidate                  0
candidate, evidence insufficient           2
candidate, thin evidence                   5
candidate, usable evidence + expectancy>0  9
candidate, large-sample + expectancy>0    12
large-sample + lower CI bound > 0          15
```

If expectancy CI is null, do not infer its sign.

This score is capped at 15 so a backtest cannot dominate abnormal market evidence.

---

## 13. Personal Relevance

Depends on Plan 03.

Personal relevance answers `Why should I care?`, not `Should I buy?`.

Create `src/shared/personalRelevance.ts`.

Signals can include:

- directly owned symbol;
- known ETF look-through exposure;
- high return correlation to an owned position;
- same sector as a concentrated position;
- diversification relevance via low correlation, clearly labeled;
- upcoming event affecting an owned symbol.

Required output:

```ts
export interface PersonalRelevance {
  score: number; // 0..10
  reasons: Array<{
    kind: 'owned' | 'indirect-exposure' | 'correlated' | 'sector' | 'diversifier' | 'event';
    text: string;
    value?: number;
  }>;
}
```

Do not label low correlation as `good diversification`; label `low observed correlation to portfolio`.

---

## 14. Discovery Result Contract

```ts
export interface DiscoveryCandidate {
  symbol: string;
  name: string;
  assetType: DiscoveryAssetType;
  asOf: string;
  attentionScore: number;
  components: AttentionComponents;
  features: DiscoveryFeatures;
  decision: TradeDecision | null;
  setupType: SetupType | null;
  setupQuality: number | null;
  historicalEvidence?: HistoricalValidationSummary;
  novelty: NoveltyResult;
  personal?: PersonalRelevance;
  dataAgeSeconds: number;
  warnings: string[];
}

export interface DiscoveryRunResult {
  id: string;
  startedAt: string;
  completedAt: string;
  coverage: UniverseCoverage;
  settings: DiscoveryEligibilitySettings;
  preliminaryCount: number;
  deepCount: number;
  candidates: DiscoveryCandidate[];
}
```

---

## 15. IPC

Add:

```ts
discoveryHydrationStatus: 'discovery:hydration-status',
discoveryHydrationStart: 'discovery:hydration-start',
discoveryHydrationStop: 'discovery:hydration-stop',
discoveryRun: 'discovery:run',
discoveryLatest: 'discovery:latest',
```

A second `discovery:run` while one is active returns the active run ID/status instead of launching duplicate computation.

---

## 16. UI

Create:

```text
src/renderer/components/discovery/
  DiscoverPage.tsx
  DiscoveryCoverageBar.tsx
  CandidateTable.tsx
  CandidateReasonCell.tsx
  DiscoveryFilters.tsx
  TodayPage.tsx
  TodaySection.tsx
```

### Discover table

Columns:

```text
Symbol | Attention | Why Now | Signal | 1D | Volume | RS | Novelty | Data
```

`Why Now` contains at most 2 strongest reasons and a details affordance.

### Today sections

Exactly four default groups:

```text
YOUR PORTFOLIO
NEW OPPORTUNITIES
REGIME CHANGES
UNUSUAL MOVES
```

A symbol can qualify for multiple groups, but Today should deduplicate the primary card and display secondary reason chips rather than four duplicate cards.

Clicking any candidate opens Plan 02 ChartWorkspace at that symbol with the strongest relevant annotation layer enabled.

---

## 17. Worker/Performance Boundary

Stage A starts in main process only if measured compute stays responsive. Add instrumentation before deciding.

If the p95 Stage A compute block exceeds 100 ms slices or creates visible renderer/main IPC stalls, move feature computation into:

```text
src/main/workers/discoveryWorker.ts
```

using Node `worker_threads` with serialized candle arrays/features. The service contract must remain unchanged.

Do not prematurely introduce a worker farm before measurement.

---

## 18. Implementation Tasks

### Task 1 — Replace prefix semantics with explicit universe/coverage types

Keep old Signal Board operational while new Discover pipeline is developed.

### Task 2 — Hydrator + progress persistence

Use mocked provider/cache tests. Restart simulation must resume remaining symbols.

### Task 3 — Pure Stage A features

Synthetic-series tests must verify robust z-score, volume ratio/z, beta residual, MA distance, volatility ratio, and regime transition.

### Task 4 — Cross-sectional ranks + eligibility

Test ties, nulls, stale rows, ETFs, leveraged metadata, and liquidity threshold boundaries.

### Task 5 — Attention grouping

Regression test: three correlated momentum indicators cannot independently award three full evidence-group scores.

### Task 6 — Novelty history

Run two synthetic scans and verify unchanged leaders lose novelty while a regime-transition entrant gains it.

### Task 7 — Stage B deep scan

Mock 300 preliminary candidates; prove historical replay is called only for selected deep candidates, not the entire universe.

### Task 8 — Portfolio relevance

With no portfolio, score is 0 and generic Discovery behaves normally. With synthetic portfolio, reasons are deterministic and never change the instrument's Signal Engine decision.

### Task 9 — Discover + Today UI

Coverage is always visible. Empty/incomplete hydration must show progress rather than presenting a tiny scan as market-wide truth.

---

## 19. Verification

Add:

```json
"test:discovery-v3": "node scripts/test-discovery-v3.mjs",
"test:discovery-ranking-v3": "node scripts/test-discovery-ranking-v3.mjs"
```

Required:

```bash
npm run typecheck
npm run test:market-data-v3
npm run test:signal-v2
npm run test:discovery-v3
npm run test:discovery-ranking-v3
npm run build
npm run smoke:signals
npm run smoke
```

No GitHub Actions.

---

## 20. Definition of Done

- `US stocks` no longer means the first N directory rows.
- Quant exposes exact universe/hydration/scan coverage.
- Thousands of cached symbols can be Stage-A scanned without performing deep replay on each.
- Ranking emphasizes abnormal information change, not raw biggest gainers alone.
- correlated indicators are grouped/capped rather than blindly summed.
- novelty distinguishes a new information event from a persistent old trend.
- stock and ETF filters are explicit.
- Today incorporates owned-position relevance without changing market-model decisions.
- every candidate has `Why now`, data age, warnings, and a deterministic deep-link to Research chart.

## 21. Dependency Order

Plan 01 is mandatory. Plan 03 enables personal relevance but is not required for generic Discover. Plan 02 provides the destination Research workspace. Plan 05 consumes only a small final shortlist from this pipeline; it must never turn heavy local forecasting into a prerequisite for basic market discovery.