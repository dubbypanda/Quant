# Quant 3.0 Remediation and Release Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the correctness and integration gaps found in the post-implementation review so Quant 3.0 can ship as a genuinely local-first personal research terminal rather than a set of partially connected v3 subsystems.

**Architecture:** Preserve the existing Quant 3.0 direction: persistent local market data, one authoritative signal conclusion, full-universe discovery, a personal portfolio engine, and experimental QRM research. The remediation work should connect these systems through shared repositories and contracts instead of adding parallel code paths. Correctness and reproducibility take priority over presentation polish.

**Tech Stack:** Electron 31, React 18, TypeScript 5.5, Node 20 APIs, lightweight-charts 4.2, esbuild, local JSON/gzip persistence, worker_threads.

**Spec:** `docs/quant-v3/01-market-data-cache-and-session-migration.md`, `docs/quant-v3/02-modern-chart-events-signals-and-ui.md`, `docs/quant-v3/03-personal-portfolio-and-risk-engine.md`, `docs/quant-v3/04-full-market-discovery-and-attention-engine.md`, `docs/quant-v3/05-qrm-research-model-and-lab.md`

## Global Constraints

- Target release is **Quant 3.0.0**. Do not change `package.json` from `2.1.0` until Task 8 release gates pass.
- **No GitHub Actions.** Verification is local through repository scripts and packaged smoke runs.
- Keep the app local-first. Do not add brokerage login, OAuth, order placement, or required cloud infrastructure.
- Sample/synthetic market data must never be ranked, backtested, used for portfolio risk, or presented as live research evidence.
- `UnifiedSignalSummary` is the only authoritative user-facing BUY / WAIT / SELL conclusion.
- QRM remains experimental until its real holdout promotion gates pass. Do not feed QRM decisions into the production signal resolver during this plan.
- Do not weaken statistical gates to make QRM pass.
- macOS arm64 and Windows x64 packaging must continue to work.
- Preserve the existing Electron security model: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- Prefer focused modules over further growth of `src/main/main.ts` and legacy `ChartModal.tsx`.

---

## Review Findings Being Fixed

| Priority | Finding | Why it matters |
| --- | --- | --- |
| P0 | Discovery hydration marks symbols complete but 5-year daily history is not persisted | Full-universe discovery becomes network-dependent again after restart |
| P0 | QRM `holdout` metrics are actually whole-dataset metrics | Promotion gates can accidentally use development observations |
| P0 | `chart-v3/ChartWorkspace` exists but legacy `ChartModal.tsx` still owns the live production path | The v3 chart/event/signal/extended-hours experience is not actually the main chart |
| P0 | Discover and chart surfaces can show raw core decisions instead of the unified decision | One ticker can show contradictory conclusions in different parts of the app |
| P1 | QRM adverse-tail gate is asymmetric for shorts | Short candidates can ignore catastrophic upside tail risk |
| P1 | QRM worker cancellation exists internally but is not connected through service/IPC/UI | High-precision jobs cannot be stopped and shutdown can strand queued promises |
| P1 | Portfolio risk consumes raw closes | Splits and distributions can corrupt volatility, beta, covariance and VaR/CVaR |
| P2 | Nine primary navigation tabs make the new app feel like a toolbox rather than one terminal | Quant 3.0 has better features but weaker hierarchy than the intended product |

---

## File Structure for This Remediation

### New files

- `src/main/services/dailyHistoryRepository.ts` — authoritative persistent repository for 5-year daily history.
- `src/renderer/components/chart-v3/hooks/useSymbolPortfolioView.ts` — position context loader for the production chart workspace.
- `scripts/test-daily-history-v3.mjs` — persistence, stale fallback and source-integrity tests.
- `scripts/test-qrm-holdout-v3.mjs` — strict development/holdout separation tests.
- `scripts/test-chart-v3-production.mjs` — verifies the production chart route uses ChartWorkspace and unified signal data.

### Existing files to modify

- `src/main/services/dailyHistory.ts`
- `src/main/services/universeHydrator.ts`
- `src/main/services/discoveryDeepScan.ts`
- `src/main/services/portfolioService.ts`
- `src/main/services/qrmService.ts`
- `src/main/workers/qrmWorker.ts`
- `src/shared/qrmBenchmark.ts`
- `src/shared/qrmDecision.ts`
- `src/shared/discovery.ts`
- `src/shared/types.ts`
- `src/shared/ipc.ts`
- `src/main/preload.ts`
- `src/main/main.ts`
- `src/renderer/components/ChartModal.tsx`
- `src/renderer/components/chart-v3/ChartWorkspace.tsx`
- `src/renderer/components/chart-v3/ResearchInspector.tsx`
- `src/renderer/components/discovery/CandidateTable.tsx`
- `src/renderer/components/discovery/TodayPage.tsx`
- `src/renderer/components/lab/ResearchLabPage.tsx`
- `src/renderer/components/CenterTabs.tsx`
- `package.json`
- `CHANGELOG.md`

---

# Task 1: Make Daily History Truly Persistent and Authoritative

**Priority:** P0

**Files:**
- Create: `src/main/services/dailyHistoryRepository.ts`
- Create: `scripts/test-daily-history-v3.mjs`
- Modify: `src/main/services/dailyHistory.ts`
- Modify: `src/main/services/universeHydrator.ts`
- Modify: `src/main/services/discoveryDeepScan.ts`
- Modify: `src/main/services/portfolioService.ts`
- Modify: `src/main/services/qrmService.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `readMarketCache`, `writeMarketCache` from `src/main/services/marketCache.ts`; Yahoo daily chart fetch from `src/main/services/yahoo.ts`.
- Produces:

```ts
export interface DailyHistoryRepositoryResult {
  symbol: string;
  candles: Candle[];
  source: 'live' | 'unavailable';
  asOf: string | null;
  stale: boolean;
  persistent: boolean;
  adjustedCloses: Array<{ time: number; close: number }>;
}

export interface DailyHistoryRequest {
  symbol: string;
  refresh?: 'cache-first' | 'network-first' | 'force-network';
}

export async function getDailyHistoryV3(
  request: DailyHistoryRequest,
): Promise<DailyHistoryRepositoryResult>;

export function hasUsablePersistedDailyHistory(symbol: string): boolean;
```

The cache key must be exactly:

```ts
`history/${symbol.toUpperCase()}/5y-1d`
```

A persisted history record is usable only when:

```ts
result.source === 'live' &&
result.candles.length >= 250 &&
result.candles.every((c) => Number.isFinite(c.close) && c.close > 0)
```

### Required behavior

1. Fresh persistent history returns without network I/O.
2. Stale persistent live history triggers network refresh.
3. If refresh fails, stale live history is returned with `stale: true`.
4. If no persistent live history exists and network fails, return `source: 'unavailable'` with an empty candle set.
5. Sample data is never written to this repository.
6. `universeHydrator` must mark a symbol completed only after the repository confirms persisted usable live history.
7. `hydratedSymbols()` must not trust the progress file alone. It must intersect recorded completion with `hasUsablePersistedDailyHistory(symbol)`.
8. Discovery, Portfolio Risk and QRM must read through `getDailyHistoryV3`, not directly through the old network-only path.

- [ ] **Step 1: Add failing persistence tests**

Add assertions equivalent to the following in `scripts/test-daily-history-v3.mjs`:

```js
assert.equal(networkCalls, 1);
const first = await repo.getDailyHistoryV3({ symbol: 'SPY', refresh: 'cache-first' });
assert.equal(first.source, 'live');
assert.equal(first.persistent, true);

networkCalls = 0;
const second = await repo.getDailyHistoryV3({ symbol: 'SPY', refresh: 'cache-first' });
assert.equal(networkCalls, 0);
assert.equal(second.source, 'live');
assert.equal(second.persistent, true);
```

Also verify restart semantics by clearing module-local HTTP cache while retaining the filesystem root.

- [ ] **Step 2: Add stale-live fallback test**

```js
const stale = await repo.getDailyHistoryV3({ symbol: 'QQQ', refresh: 'network-first' });
assert.equal(stale.source, 'live');
assert.equal(stale.stale, true);
assert.ok(stale.candles.length >= 250);
```

The injected network fetcher must throw for this assertion.

- [ ] **Step 3: Verify tests fail before implementation**

Run:

```bash
node scripts/test-daily-history-v3.mjs
```

Expected: FAIL because `dailyHistoryRepository.ts` and `getDailyHistoryV3` do not exist.

- [ ] **Step 4: Implement the repository**

Use `marketCache.ts` rather than introducing a second storage format. Daily history TTL rules:

```ts
const ACTIVE_DAILY_HISTORY_TTL_MS = 30 * 60_000;
const CLOSED_DAILY_HISTORY_TTL_MS = 6 * 60 * 60_000;
const WEEKEND_DAILY_HISTORY_TTL_MS = 12 * 60 * 60_000;
```

The stored value must include both raw candles and adjusted close points from Yahoo `indicators.adjclose[0].adjclose` aligned by timestamp.

- [ ] **Step 5: Route the existing `getDailyHistory()` facade through the repository**

Keep the current public shape if existing callers still need it, but make it a compatibility wrapper:

```ts
export async function getDailyHistory(symbol: string): Promise<DailyHistoryResult> {
  const result = await getDailyHistoryV3({ symbol, refresh: 'cache-first' });
  return {
    symbol: result.symbol,
    candles: result.candles,
    source: result.source,
    interval: '1d',
    asOf: result.asOf ?? undefined,
    adjustedCloses: result.adjustedCloses,
    warning: result.source === 'unavailable' ? 'Live daily history is unavailable.' : undefined,
  };
}
```

- [ ] **Step 6: Fix hydration truthfulness**

Change hydration completion from “a request succeeded once” to “usable persisted record exists now.” After each successful hydration:

```ts
const history = await getDailyHistoryV3({ symbol, refresh: 'network-first' });
return history.source === 'live' &&
  history.persistent &&
  history.candles.length >= PREFERRED_HISTORY_BARS - 20;
```

`hydratedSymbols()` must filter persisted progress through repository existence checks.

- [ ] **Step 7: Route Discovery, Portfolio Risk and QRM through the same repository**

No subsystem may create its own daily-history fetch/cache policy.

- [ ] **Step 8: Run focused verification**

```bash
node scripts/test-daily-history-v3.mjs
npm run test:discovery-v3
npm run test:portfolio-risk-v3
npm run test:qrm-v3
npm run typecheck
```

Expected: all PASS.

- [ ] **Step 9: Commit**

```bash
git add src/main/services/dailyHistoryRepository.ts src/main/services/dailyHistory.ts src/main/services/universeHydrator.ts src/main/services/discoveryDeepScan.ts src/main/services/portfolioService.ts src/main/services/qrmService.ts scripts/test-daily-history-v3.mjs package.json
git commit -m "fix: persist authoritative daily history for Quant 3"
```

---

# Task 2: Make QRM Development and Holdout Metrics Actually Separate

**Priority:** P0

**Files:**
- Create: `scripts/test-qrm-holdout-v3.mjs`
- Modify: `src/shared/qrmBenchmark.ts`
- Modify: `scripts/qrm-research-loop.mjs`
- Modify: `scripts/test-qrm-v3.mjs`
- Modify: `package.json`

**Interfaces:**

Replace the current result shape with:

```ts
export interface QrmBenchmarkPartition {
  summary: QrmBenchmarkSummary;
  baselines: BaselineSummary[];
  firstOriginAt: number | null;
  lastOriginAt: number | null;
}

export interface QrmBenchmarkResult {
  development: QrmBenchmarkPartition;
  holdout: QrmBenchmarkPartition;
  split: {
    developmentOrigins: number;
    holdoutOrigins: number;
    developmentFraction: number;
    splitTimestamp: number | null;
  };
}
```

Every `OriginRecord` must carry:

```ts
originTime: number;
```

where `originTime = candles[cutoff].time`.

### Required behavior

- Global chronological partitioning must sort by `originTime`, not `cutoffIndex`.
- Development metrics are computed from development origins only.
- Holdout metrics are computed from holdout origins only.
- Baselines are recomputed separately for each partition.
- `evaluatePromotionGates()` receives only `result.holdout.summary` and `result.holdout.baselines`.
- Research output must label development and holdout metrics separately.
- No tuning result computed from holdout observations may flow back into forecast generation.

- [ ] **Step 1: Write a failing split-isolation test**

Construct deterministic origins where development returns are strongly positive and holdout returns are strongly negative. Assert:

```js
assert.notEqual(result.development.summary.meanForwardReturnOfDecisions,
                result.holdout.summary.meanForwardReturnOfDecisions);
assert.ok(result.development.lastOriginAt < result.holdout.firstOriginAt);
```

- [ ] **Step 2: Write a failing promotion-input test**

Monkey-patch the holdout summary to fail one gate while development passes. The verdict must fail.

```js
const verdict = benchmark.evaluatePromotionGates({
  holdout: result.holdout.summary,
  baselines: result.holdout.baselines,
  leakageTestsPassed: true,
  reproducibilityTestsPassed: true,
  regimesRepresented: 3,
  runtimeP95MsPerSymbol: result.holdout.summary.p95RuntimeMs,
});
assert.equal(verdict.promotable, false);
```

- [ ] **Step 3: Verify the new suite fails**

```bash
node scripts/test-qrm-holdout-v3.mjs
```

Expected: FAIL against the current `full.qrm` result shape.

- [ ] **Step 4: Extract one pure summarizer**

Inside `qrmBenchmark.ts`, create:

```ts
function summarizeOrigins(origins: OriginRecord[]): QrmBenchmarkPartition;
```

This function owns QRM metrics and baseline metrics for exactly the records passed to it.

- [ ] **Step 5: Partition by actual timestamp**

```ts
const chronological = [...origins].sort((a, b) => a.originTime - b.originTime);
const developmentCount = Math.floor(chronological.length * developmentFraction);
const developmentOrigins = chronological.slice(0, developmentCount);
const holdoutOrigins = chronological.slice(developmentCount);
```

If either partition is empty, preserve an empty summary with explicit warnings instead of silently reusing the full dataset.

- [ ] **Step 6: Fix the research loop**

The ledger row must contain:

```js
metrics: {
  development: result.development.summary,
  holdout: result.holdout.summary,
},
baselines: {
  development: result.development.baselines,
  holdout: result.holdout.baselines,
}
```

Promotion gates consume only the holdout partition.

- [ ] **Step 7: Run verification**

```bash
node scripts/test-qrm-holdout-v3.mjs
npm run test:qrm-v3
npm run research:qrm -- --fixture
npm run typecheck
```

Expected: synthetic random-walk fixture may still fail promotion; the important condition is that the gate evaluates the holdout partition only.

- [ ] **Step 8: Commit**

```bash
git add src/shared/qrmBenchmark.ts scripts/qrm-research-loop.mjs scripts/test-qrm-v3.mjs scripts/test-qrm-holdout-v3.mjs package.json
git commit -m "fix: enforce true QRM holdout evaluation"
```

---

# Task 3: Move the Production Chart onto ChartWorkspace v3

**Priority:** P0

**Files:**
- Create: `src/renderer/components/chart-v3/hooks/useSymbolPortfolioView.ts`
- Create: `scripts/test-chart-v3-production.mjs`
- Modify: `src/renderer/components/ChartModal.tsx`
- Modify: `src/renderer/components/chart-v3/ChartWorkspace.tsx`
- Modify: `src/renderer/components/chart-v3/ResearchInspector.tsx`
- Modify: `src/renderer/components/chart-v3/SymbolHeader.tsx`
- Modify: `package.json`

**Interfaces:**

`ChartModal` becomes a state/data orchestration wrapper. It must render exactly one top-level workspace:

```tsx
<ChartWorkspace
  symbol={symbol}
  companyName={watchItem?.name}
  range={range}
  onRangeChange={setRange}
  data={settledData}
  loading={loading}
  pivots={pivots}
  trendLines={trendLines}
  numbered={numbered}
  highlight={highlight}
  macroOverlays={macroSeries}
  riskPlan={signalDesk?.evaluation.risk ?? null}
  showRiskOverlay={showRiskOverlay}
  forecastRecord={forecast.record}
  forecastActual={forecast.actual}
  overviewPanel={overviewPanel}
  signalPanel={signalPanel}
  forecastPanel={forecastPanel}
  positionPanel={positionPanel}
  onNeedMoreHistory={loadOlder}
  onClose={actions.closeChart}
/>
```

Do not reproduce the old toolbar/rail inside `ChartModal` after the migration.

### Required behavior

- The production modal must visibly use session-aware price metadata from `ChartData.preMarket`, `ChartData.postMarket` and `marketState`.
- Event markers, immutable signal-history markers and extended-hours shading must be active in the production route.
- Position inspector uses `api.getPortfolioSymbolContext(symbol)` through the new hook.
- Existing forecast and Signal Desk capabilities remain available inside ResearchInspector.
- Existing smoke query behavior remains deterministic.
- Legacy chart keyboard shortcuts may be retained only where they map cleanly to v3 behavior.

- [ ] **Step 1: Add a production-path source assertion**

In `scripts/test-chart-v3-production.mjs`, inspect/bundle `ChartModal.tsx` and assert the source imports and renders `ChartWorkspace`.

```js
assert.match(chartModalSource, /from ['"].\/chart-v3\/ChartWorkspace['"]/);
assert.match(chartModalSource, /<ChartWorkspace/);
```

Also assert the legacy `cm-toolbar` and old rail root are no longer produced by `ChartModal`.

- [ ] **Step 2: Run the new test and confirm failure**

```bash
node scripts/test-chart-v3-production.mjs
```

Expected: FAIL because the current production modal still owns the legacy rendering path.

- [ ] **Step 3: Add portfolio context hook**

```ts
export function useSymbolPortfolioView(symbol: string): {
  value: SymbolPortfolioView | null;
  loading: boolean;
  error: string | null;
}
```

Reset to `null` when symbol changes; discard stale async responses.

- [ ] **Step 4: Convert ChartModal to orchestration only**

Keep data hooks, memoized pivots/trend lines and existing panel content generation. Remove duplicated layout markup after equivalent v3 content exists.

- [ ] **Step 5: Preserve production smoke support**

The following must continue to work:

```bash
npm run smoke:modal
npm run smoke:forecast
```

Add or adapt smoke selectors so the test can detect `.cv3-workspace`.

- [ ] **Step 6: Verify the production chart**

```bash
node scripts/test-chart-v3-production.mjs
npm run test:chart-v3
npm run test:events-v3
npm run test:signal-history-v3
npm run typecheck
npm run build
npm run smoke:modal
npm run smoke:forecast
```

Expected: all PASS and smoke screenshots contain the v3 workspace.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/ChartModal.tsx src/renderer/components/chart-v3 scripts/test-chart-v3-production.mjs package.json
git commit -m "feat: make ChartWorkspace the Quant 3 production chart"
```

---

# Task 4: Enforce One Authoritative Signal Across Discover, Today and Chart

**Priority:** P0

**Files:**
- Modify: `src/shared/discovery.ts`
- Modify: `src/main/services/discoveryDeepScan.ts`
- Modify: `src/renderer/components/discovery/CandidateTable.tsx`
- Modify: `src/renderer/components/discovery/TodayPage.tsx`
- Modify: `src/renderer/components/chart-v3/ResearchInspector.tsx`
- Modify: `scripts/test-discovery-v3.mjs`
- Modify: `scripts/test-unified-signal.mjs`

**Interfaces:**

A discovery candidate must separate setup research from the authoritative conclusion:

```ts
export interface DiscoveryCandidate {
  // existing fields...
  unifiedSignal: UnifiedSignalSummary;
  setup: {
    decision: TradeDecision;
    setupType: SetupType;
    setupQuality: number;
  };
}
```

The raw core decision must never be rendered under a UI label named `Signal`.

### Required behavior

- `evaluateSignalCore()` remains useful for geometry and historical replay.
- `resolveUnifiedSignal()` is called after core evaluation using the same candle series.
- Discovery ranking may use raw setup geometry as one attention component, but candidate user-facing BUY/WAIT/SELL comes from `unifiedSignal.signal` only.
- Today cards use the same unified summary.
- Chart Signal inspector renders `signalDesk.unified` when available.
- If unified signal is unavailable because data is insufficient, UI says `WAIT` / insufficient evidence rather than falling back to the raw buy-candidate wording.

- [ ] **Step 1: Add a contradiction fixture**

Create a discovery test fixture where core evaluation is positive but unified resolver is blocked by unusable risk or conflicting evidence.

Assert:

```js
assert.equal(candidate.setup.decision, 'buy-candidate');
assert.equal(candidate.unifiedSignal.signal, 'wait');
```

- [ ] **Step 2: Verify current behavior fails the contract**

```bash
npm run test:discovery-v3
```

Add the assertion before implementation so the suite fails first.

- [ ] **Step 3: Resolve unified signal inside Stage B**

For each Stage B candidate:

```ts
const unifiedSignal = resolveUnifiedSignal({
  symbol: item.symbol,
  candles: recent,
  evaluation,
});
```

Preserve the raw evaluation under `setup`.

- [ ] **Step 4: Update CandidateTable**

The `Signal` column must render:

```tsx
candidate.unifiedSignal.signal.toUpperCase()
```

Setup quality may be shown as secondary research metadata, never as a confidence percentage.

- [ ] **Step 5: Update Today and chart inspector**

Today research-priority reasons may mention `setupType`, but the action word must come from Unified Signal. Chart must not recompute a separate user-facing decision from candles in the renderer.

- [ ] **Step 6: Run verification**

```bash
npm run test:unified
npm run test:discovery-v3
npm run test:chart-v3
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/shared/discovery.ts src/main/services/discoveryDeepScan.ts src/renderer/components/discovery src/renderer/components/chart-v3/ResearchInspector.tsx scripts/test-discovery-v3.mjs scripts/test-unified-signal.mjs
git commit -m "fix: use unified signal across Quant 3 surfaces"
```

---

# Task 5: Fix QRM Short Tail Risk and Complete Cancellation

**Priority:** P1

**Files:**
- Modify: `src/shared/qrmDecision.ts`
- Modify: `src/main/services/qrmService.ts`
- Modify: `src/main/workers/qrmWorker.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/types.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/components/lab/ResearchLabPage.tsx`
- Modify: `scripts/test-qrm-v3.mjs`

**Interfaces:**

Add a direction-aware adverse tail helper:

```ts
export function qrmAdverseTailLoss(
  distribution: QrmHorizonDistribution,
  direction: 'long' | 'short',
): number {
  return direction === 'long'
    ? Math.max(0, -distribution.terminalReturn.p10)
    : Math.max(0, distribution.terminalReturn.p90);
}
```

Add cancellation service:

```ts
export function cancelQrm(jobId: string): boolean;
```

Add IPC/API:

```ts
qrmCancel: 'qrm:cancel'

cancelQrm(jobId: string): Promise<{ cancelled: boolean }>;
```

### Required behavior

- Long adverse tail = downside P10 magnitude.
- Short adverse tail = upside P90 magnitude.
- Both directions use the configured horizon loss ceiling.
- A queued QRM job can be removed before it starts.
- A running worker job receives `{ type: 'cancel', jobId }`.
- Cancelled jobs resolve/reject deterministically; no promise remains pending forever.
- `shutdownQrmPool()` rejects every queued and active pending job with a shutdown error before terminating workers.
- Research Lab shows `Cancel` while a job is running.

- [ ] **Step 1: Add short-tail regression test**

```js
const dist = makeDistribution({
  p10: -0.02,
  p50: -0.04,
  p90: 0.18,
  probabilityPositive: 0.2,
});
const result = decideQrm(dist, permissiveExceptTail);
assert.equal(result.decision, 'wait');
assert.equal(result.tailLoss, 0.18);
```

- [ ] **Step 2: Add cancellation tests**

Cover both queued and active jobs. The active worker fixture should periodically call `isCancelled()` and return a cancelled result or throw the service-defined cancellation error.

- [ ] **Step 3: Verify failures**

```bash
npm run test:qrm-v3
```

Expected: the short-tail case fails against the current long-only tail gate and cancellation API is missing.

- [ ] **Step 4: Implement symmetric tail gating**

Use `wantsLong ? 'long' : 'short'` when calculating tail loss, and apply the same maximum-loss gate to both directions.

- [ ] **Step 5: Track active job ownership in qrmService**

Maintain:

```ts
const activeJobs = new Map<string, PoolWorker>();
```

and remove entries on result, error, cancellation and worker exit.

- [ ] **Step 6: Wire IPC and Lab Cancel button**

Lab must retain the current `jobId` from progress events and call `api.cancelQrm(jobId)`.

- [ ] **Step 7: Run verification**

```bash
npm run test:qrm-v3
npm run typecheck
npm run build
```

- [ ] **Step 8: Commit**

```bash
git add src/shared/qrmDecision.ts src/main/services/qrmService.ts src/main/workers/qrmWorker.ts src/shared/ipc.ts src/shared/types.ts src/main/preload.ts src/main/main.ts src/renderer/components/lab/ResearchLabPage.tsx scripts/test-qrm-v3.mjs
git commit -m "fix: make QRM tail risk symmetric and cancellable"
```

---

# Task 6: Use Adjusted Returns for Portfolio Risk

**Priority:** P1

**Files:**
- Modify: `src/main/services/dailyHistory.ts`
- Modify: `src/main/services/dailyHistoryRepository.ts`
- Modify: `src/shared/portfolioRisk.ts`
- Modify: `src/main/services/portfolioService.ts`
- Modify: `scripts/test-portfolio-risk-v3.mjs`
- Modify: `scripts/test-daily-history-v3.mjs`

**Interfaces:**

Portfolio risk should consume explicit return points rather than assuming raw candle closes are suitable:

```ts
export interface PortfolioReturnPoint {
  time: number;
  close: number;
}

export interface PortfolioRiskInput {
  positions: PortfolioPosition[];
  returnsBySymbol: Record<string, PortfolioReturnPoint[]>;
  benchmark: PortfolioReturnPoint[];
  totalCash: number;
  adjusted: boolean;
  asOf?: string;
}
```

### Required behavior

- Chart and execution modules continue to use raw OHLC candles.
- Portfolio risk prefers adjusted close series.
- If adjusted close is missing for a symbol, risk may fall back to raw close for that symbol only and must add a warning naming the symbol.
- The report's `adjusted` flag is true only when all priced risk-bearing positions and the benchmark use adjusted data.
- Split-like raw price discontinuities must not create a false volatility spike when adjusted close is available.

- [ ] **Step 1: Add a split regression fixture**

Use a synthetic series:

```js
raw:      [100, 102, 51, 52]
adjusted: [50, 51, 51, 52]
```

Assert adjusted volatility is materially lower than raw volatility and no -50% return enters the portfolio covariance calculation.

- [ ] **Step 2: Verify the test fails against raw-close-only risk**

```bash
npm run test:portfolio-risk-v3
```

- [ ] **Step 3: Preserve adjusted close in daily-history persistence**

Align Yahoo adjusted closes to candle timestamps. Missing values are omitted rather than fabricated.

- [ ] **Step 4: Change portfolio risk inputs**

`portfolioService.ts` builds `returnsBySymbol` from adjusted series when available.

- [ ] **Step 5: Add data-quality warnings**

A mixed-adjustment report must visibly state which symbols use raw closes.

- [ ] **Step 6: Run verification**

```bash
npm run test:portfolio-risk-v3
node scripts/test-daily-history-v3.mjs
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/main/services/dailyHistory.ts src/main/services/dailyHistoryRepository.ts src/shared/portfolioRisk.ts src/main/services/portfolioService.ts scripts/test-portfolio-risk-v3.mjs scripts/test-daily-history-v3.mjs
git commit -m "fix: use adjusted returns for portfolio risk"
```

---

# Task 7: Simplify Quant 3 Navigation Without Removing Capabilities

**Priority:** P2

**Files:**
- Modify: `src/renderer/components/CenterTabs.tsx`
- Modify: `src/renderer/store.tsx`
- Modify: `src/renderer/styles/app.css` or the current center-navigation stylesheet
- Modify: smoke-tab parsing in `src/main/main.ts`

**Target primary navigation:**

```text
Today | Discover | Portfolio | Research | Settings
```

**Research secondary navigation:**

```text
Market Pulse | News | Analysis | Signals | QRM Lab
```

### Required behavior

- Do not delete Market Pulse, Market News, Analysis Lab, Signal Board or Research Lab.
- Move them under the Research workspace.
- Preserve deep state so switching primary tabs does not discard an active research sub-tab.
- Today remains the default app landing workspace.
- Discover and Portfolio remain one click away.

- [ ] **Step 1: Add state-level navigation test coverage**

The store must expose separate values:

```ts
primaryWorkspace: 'today' | 'discover' | 'portfolio' | 'research' | 'settings';
researchTab: 'pulse' | 'news' | 'analysis' | 'signals' | 'lab';
```

- [ ] **Step 2: Refactor CenterTabs**

Render only five primary tabs and a compact secondary strip when `primaryWorkspace === 'research'`.

- [ ] **Step 3: Update smoke query parsing**

Map legacy smoke values to the new state so existing local verification commands remain useful.

- [ ] **Step 4: Run verification**

```bash
npm run typecheck
npm run build
npm run smoke
npm run smoke:signals
```

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/CenterTabs.tsx src/renderer/store.tsx src/renderer/styles src/main/main.ts
git commit -m "refactor: simplify Quant 3 workspace navigation"
```

---

# Task 8: Quant 3.0 Release Verification and Version Bump

**Priority:** Release gate

**Files:**
- Modify only after every command below passes: `package.json`
- Modify: `CHANGELOG.md`
- Modify: `_changelog/2026.09.15_changelog.md` or create the release-date changelog if release occurs later

## Mandatory release checks

- [ ] **Step 1: Type and build verification**

```bash
npm run typecheck
npm run build
```

Both must exit 0.

- [ ] **Step 2: Core deterministic signal verification**

```bash
npm run test:signal-v2
npm run test:unified
```

Both must exit 0.

- [ ] **Step 3: Quant 3 subsystem verification**

```bash
npm run test:market-data-v3
node scripts/test-daily-history-v3.mjs
npm run test:chart-v3
node scripts/test-chart-v3-production.mjs
npm run test:events-v3
npm run test:signal-history-v3
npm run test:portfolio-v3
npm run test:portfolio-risk-v3
npm run test:discovery-v3
npm run test:qrm-v3
node scripts/test-qrm-holdout-v3.mjs
```

Every suite must exit 0.

- [ ] **Step 4: Real persistence restart test**

Run Quant once long enough to hydrate at least 100 symbols, quit, disconnect networking or inject network failure, restart, then confirm:

```text
hydratedCount >= 100
scannedCount >= 100
sample-ranked candidates = 0
network dependency for those persisted histories = 0
```

The UI must explicitly flag stale data if the cached history is outside freshness bounds.

- [ ] **Step 5: Real QRM benchmark**

Use at least 25 liquid stocks/ETFs covering multiple regimes. Example command shape:

```bash
npm run research:qrm -- --symbols SPY,QQQ,IWM,DIA,XLK,XLF,XLE,XLV,XLI,XLY,XLP,GLD,TLT,NVDA,AAPL,MSFT,AMZN,META,GOOGL,TSLA,AMD,AVGO,MU,JPM,XOM --horizon 10 --paths 500
```

This is research validation, not a requirement that QRM pass. The requirement is:

```text
- metrics are split into true development and holdout partitions
- promotion is evaluated from holdout only
- failing gates keep QRM experimental
- ledger appends a reproducible row with git revision and config hash
```

- [ ] **Step 6: Packaged smoke verification**

Run locally; do not replace this with GitHub Actions.

```bash
npm run smoke
npm run smoke:modal
npm run smoke:forecast
npm run smoke:signals
```

Then package the platform available on the development machine:

```bash
npm run package:mac
```

or

```bash
npm run package:win
```

Open the packaged binary and manually verify:

```text
Today loads
Discover opens a candidate
Portfolio opens and edits a local position
Chart opens ChartWorkspace v3
Pre/regular/post session state renders correctly when available
FOMC/CPI/earnings markers can render
Historical signal markers render
Position inspector renders
Research Lab can run and cancel QRM
No renderer crash/reload appears in logs
```

- [ ] **Step 7: Only now bump the version**

Change:

```json
"version": "3.0.0"
```

Move the completed Quant 3 changes from `[Unreleased]` into a `3.0.0` changelog section dated on the actual release date.

- [ ] **Step 8: Final commit**

```bash
git add package.json CHANGELOG.md _changelog
git commit -m "release: Quant 3.0.0"
```

---

# Definition of Done

Quant 3.0 is release-ready only when all of the following are true:

```text
[ ] Daily market history survives restart and is reused by Discovery, Portfolio Risk and QRM.
[ ] Hydration status reflects actual persisted usable data, not a progress marker alone.
[ ] Discovery can operate on persisted local history without ranking sample data.
[ ] QRM reports genuinely separate development and holdout metrics.
[ ] Promotion gates use holdout metrics only.
[ ] ChartWorkspace v3 is the production chart shown by ChartModal.
[ ] Production chart shows extended-hours/session metadata, events and historical signal markers.
[ ] Discover, Today, Signal Desk and chart agree on one Unified Signal conclusion.
[ ] QRM short candidates are gated against upside P90 adverse tail risk.
[ ] Running and queued QRM jobs can be cancelled without stranded promises.
[ ] Portfolio risk uses adjusted returns when available and reports fallbacks honestly.
[ ] Primary navigation is coherent and the full feature set remains reachable.
[ ] Typecheck, build, all local tests and packaged smoke verification pass.
[ ] QRM has been evaluated on real history, even if promotion gates correctly fail.
[ ] package.json is bumped to 3.0.0 only after the above gates pass.
```

## Non-goals for this remediation

Do not add the following while executing this plan:

- Brokerage connectivity.
- Trade execution.
- Cloud account sync.
- QRM auto-promotion into the production signal.
- New prediction models unrelated to fixing the reviewed 3.0 gaps.
- A database migration solely for architectural aesthetics; the existing local filesystem persistence can remain until measured performance requires otherwise.
- GitHub Actions or any CI migration.

## Recommended execution order

```text
Task 1  Persistent daily history
   ↓
Task 2  True QRM holdout
   ↓
Task 3  Production ChartWorkspace
   ↓
Task 4  Unified signal consistency
   ↓
Task 5  QRM tail/cancellation
   ↓
Task 6  Adjusted portfolio returns
   ↓
Task 7  Navigation simplification
   ↓
Task 8  Full release verification → version 3.0.0
```

Tasks 1 and 2 are correctness blockers. Tasks 3 and 4 are product-consistency blockers. Tasks 5 and 6 are risk-model correctness improvements. Task 7 is UX cleanup. Task 8 is the only place where the release version should change.
