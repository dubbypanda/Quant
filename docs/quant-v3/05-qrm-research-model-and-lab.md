# Quant 3.0 — QRM Research Model, Heavy Compute Pipeline & Research Lab

> **For agentic workers:** Implement only after the data contracts in Plan 01 are stable. Discovery integration depends on Plan 04. QRM is experimental in 3.0 until promotion gates in this document are passed. Use test-first changes. Do not add GitHub Actions.

**Target release:** `3.0.0`

**Goal:** Add a desktop-class quantitative research model that estimates conditional forward outcome distributions, separates forecasting from decision policy, uses heavier local computation only on selected research candidates, measures its own calibration and entry quality, and can be falsified before it is allowed to influence authoritative production decisions.

**Working name:** `QRM-3` — Quant Research Model, version 3 research track.

**Architecture:** QRM is not a score layered onto Signal Engine V2. It is a separate point-in-time research pipeline: normalized market state → historical analogue weighting → stationary block resampling → forward path distribution → calibrated diagnostics → optional experimental decision functional. Signal Engine V2 remains an independent deterministic authority in Quant 3.0 unless QRM later passes explicit promotion gates.

## Global Constraints

- QRM never trains on or reads future observations at inference time.
- Forecast quality and decision quality are evaluated separately.
- Do not directly copy an experimental mobile decision policy into desktop production.
- No LLM is used to create QRM signals.
- No paid API is required.
- Current fundamentals such as P/E or P/B must not enter historical replay unless point-in-time historical fundamentals are available; otherwise that is lookahead leakage.
- Every run stores model version, configuration, seed, input cutoff, and provenance.
- Heavy compute runs only for explicit research or Plan 04's small final shortlist, never as a prerequisite for opening a ticker.
- No GitHub Actions.

---

## 1. Why a Separate Model

Signal Engine V2 is intentionally deterministic and explainable: setup classification, risk plan, execution-aware historical replay, bootstrap expectancy, and forward outcomes.

QRM solves a different question:

> Given the current normalized market state, what distribution of forward paths has historically followed comparable states?

The model must not answer `BUY` merely because trailing momentum is strong. A forecast distribution can be directionally positive while the current entry location is poor. Therefore Quant 3.0 keeps these objects distinct:

```text
Forecast distribution
        ↓
Forecast diagnostics
        ↓
Decision functional
        ↓
Experimental decision
```

The renderer must be able to show a distribution even when decision policy returns `WAIT` or `UNAVAILABLE`.

---

## 2. QRM Contracts

Create `src/shared/qrm.ts`.

```ts
export type QrmHorizon = 1 | 5 | 10;

export interface QrmConfig {
  modelVersion: string;
  historyYears: number;
  analoguePoolSize: number;
  targetEss: number;
  minEss: number;
  paths: number;
  stationaryBlockMean: number;
  horizons: QrmHorizon[];
  seed: number;
}

export interface QrmStateVector {
  asOf: number;
  return1Z: number;
  return5Z: number;
  return20Z: number;
  realizedVol20Z: number;
  volatilityRatio20To60: number;
  volumeZ60: number;
  ma20DistanceAtr: number;
  ma50DistanceAtr: number;
  distance52wHighZ: number;
  spyResidual5Z: number;
  spyResidual20Z: number;
  relativeStrength126: number;
  regime: MarketRegime;
}

export interface QrmQuantiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface QrmHorizonDistribution {
  horizon: QrmHorizon;
  terminalReturn: QrmQuantiles;
  probabilityPositive: number;
  mfe: QrmQuantiles;
  mae: QrmQuantiles;
  probabilityLoss5PercentBeforeGain5Percent: number | null;
}

export interface QrmDiagnostics {
  analogueCount: number;
  effectiveSampleSize: number;
  kernelTemperature: number;
  nearestDistance: number;
  medianDistance: number;
  regimeMatchPercent: number;
  dataCutoffTime: number;
  computationMs: number;
  warnings: string[];
}

export interface QrmForecastSnapshot {
  id: string;
  symbol: string;
  createdAt: string;
  config: QrmConfig;
  state: QrmStateVector;
  distributions: QrmHorizonDistribution[];
  diagnostics: QrmDiagnostics;
  sampledPaths?: number[][];
  source: DataSource;
}
```

`sampledPaths` can be omitted from ordinary persistent records if size becomes excessive; quantiles and reproducibility metadata are mandatory.

---

## 3. Data Window

For an explicit QRM run:

- fetch up to 10 years of completed daily bars when available;
- require at least 3 years / 756 completed daily bars for ordinary QRM;
- return `unavailable` below minimum rather than reducing standards silently;
- benchmark SPY history must align by date;
- sector benchmark is optional and does not block the base model.

The last incomplete live daily bar is excluded from state estimation unless the run explicitly requests `includeIncompleteSession`, which remains false in 3.0 UI.

---

## 4. Point-in-Time Feature Builder

Create `src/shared/qrmState.ts`.

Required API:

```ts
export function buildQrmStateAt(
  assetCandles: Candle[],
  spyCandles: Candle[],
  cutoffIndex: number,
): QrmStateVector | null;
```

All rolling statistics use only rows `<= cutoffIndex`.

### Robust standardization

For a raw feature history `x`:

```text
center = median(x_train)
MAD = median(|x_train - center|)
scale = max(epsilon, 1.4826 * MAD)
z = clamp((x_current - center) / scale, -8, 8)
```

`epsilon = 1e-8`.

The clamped z is the model input; retain unclamped diagnostic values where useful.

### Regime handling

`regime` remains categorical. Do not encode arbitrary ordinal numbers such as `trending-up = 1`, `choppy = 2`. Regime affects analogue weighting through a separate compatibility multiplier.

---

## 5. Historical Analogue Records

Create `src/shared/qrmAnalogue.ts`.

```ts
export interface QrmAnalogueRecord {
  time: number;
  state: QrmStateVector;
  forwardReturns: Record<QrmHorizon, number>;
  forwardMfe: Record<QrmHorizon, number>;
  forwardMae: Record<QrmHorizon, number>;
  subsequentDailyReturns: number[];
}
```

Candidate records must be strictly earlier than the current `dataCutoffTime` and far enough from the cutoff to have fully realized the longest horizon.

For a 10-day horizon, a candidate at index `i` is eligible only if at least 10 subsequent completed bars exist **before the inference cutoff in walk-forward replay**.

This is mandatory to avoid hidden future leakage.

---

## 6. Distance Function

Use robust standardized Euclidean distance in 3.0 rather than introducing unstable covariance inversion.

```text
d² = Σ_j featureWeight_j * (x_j - a_j)²
```

Initial weights:

```ts
export const QRM_FEATURE_WEIGHTS = {
  return1Z: 0.50,
  return5Z: 0.75,
  return20Z: 1.00,
  realizedVol20Z: 1.00,
  volatilityRatio20To60: 1.00,
  volumeZ60: 0.50,
  ma20DistanceAtr: 0.75,
  ma50DistanceAtr: 0.75,
  distance52wHighZ: 0.50,
  spyResidual5Z: 1.00,
  spyResidual20Z: 1.00,
  relativeStrength126: 0.75,
} as const;
```

These are versioned research parameters, not immutable truths. Any change creates a new model/config version and must be benchmarked.

Regime compatibility multiplier:

```text
same regime                1.00
compatible trend family    0.80
different but non-opposed  0.55
opposed regime             0.30
```

Implement compatibility as a named deterministic matrix; do not bury it inside the kernel expression.

---

## 7. ESS-Targeted Kernel Bandwidth

Fixed kernel temperature can concentrate all posterior weight into a few analogues. QRM solves temperature for an effective sample-size target.

For distances `d_i`:

```text
rawWeight_i(tau) = exp(-(d_i²) / tau) * regimeMultiplier_i
normalized w_i = rawWeight_i / Σ rawWeight
ESS = 1 / Σ w_i²
```

Equivalent form `(Σ rawWeight)² / Σ rawWeight²` is acceptable.

Create:

```ts
export function solveKernelTemperature(
  distances: number[],
  regimeMultipliers: number[],
  targetEss: number,
): { temperature: number; ess: number; reachable: boolean };
```

Algorithm:

1. search `log(tau)` in a bounded interval;
2. verify ESS monotonicity for the candidate set in tests;
3. bisection for max 24 iterations or relative ESS error < 0.5%;
4. if target is unreachable, choose the temperature producing maximum reachable ESS and set `reachable: false`;
5. QRM forecast is unavailable when final ESS < `minEss`.

Defaults:

```text
analoguePoolSize = 128 nearest candidates
targetEss = 40
minEss = 20
```

---

## 8. Weighted Analogue Distribution

Before path simulation, QRM can report the direct empirical weighted outcome distribution.

Create weighted quantile helper:

```ts
export function weightedQuantile(
  values: number[],
  weights: number[],
  q: number,
): number;
```

Requirements:

- q in `[0,1]`;
- deterministic tie behavior;
- normalized or unnormalized positive weights accepted;
- zero/negative/non-finite weights rejected;
- tests cover single item, equal weights, skewed weights, and duplicate values.

Direct weighted terminal return/MFE/MAE distributions are the first diagnostic baseline. The bootstrap simulator must justify itself against this simpler object.

---

## 9. Stationary Block Bootstrap

Create `src/shared/qrmBootstrap.ts`.

Goal: preserve multi-session volatility clustering better than independent daily draws.

Use stationary bootstrap behavior:

```text
choose weighted analogue/session start
for each next simulated session:
  continue to next consecutive historical session with probability c
  otherwise restart from a newly weighted analogue/session
```

If mean block length is `L`, continuation probability is:

```text
c = 1 - 1/L
```

Default `L = 5` sessions.

The random generator must be deterministic from `QrmConfig.seed`. Reuse a repository-tested deterministic PRNG rather than `Math.random()`.

For each sampled path save/derive:

- cumulative daily returns;
- terminal return at horizons 1/5/10;
- maximum favorable excursion;
- maximum adverse excursion;
- first-hit ordering for -5% / +5% when both thresholds are meaningful.

### Compute modes

```text
Discovery deep shortlist: 500 paths
Explicit Research run:    1,000 paths
Lab benchmark/high quality: 2,000 paths
```

UI may expose `Standard` and `High precision`; do not expose every sampler parameter in ordinary Research workspace.

---

## 10. Distribution Calibration

QRM 3.0 must not label a P10–P90 band as an `80% confidence interval` unless measured holdout coverage supports that interpretation.

UI labels:

```text
P10–P90 sampled range
Median sampled outcome
Observed holdout coverage: 77% (if benchmark available)
```

Never silently shrink sampled residuals for visual aesthetics. If the chart fan is visually too wide, fix presentation, not the probability distribution.

Calibration methods may be researched in Lab, but 3.0 base QRM preserves raw sampled quantiles and reports empirical coverage.

---

## 11. Experimental Decision Functional

Create `src/shared/qrmDecision.ts`.

The decision layer consumes a completed forecast; it does not influence path generation.

```ts
export type QrmExperimentalDecision =
  | 'long-candidate'
  | 'short-candidate'
  | 'wait'
  | 'unavailable';

export interface QrmDecisionResult {
  decision: QrmExperimentalDecision;
  horizon: QrmHorizon;
  edge: number | null;
  uncertainty: number | null;
  signalToNoise: number | null;
  rewardToRisk: number | null;
  probabilityDirectional: number | null;
  tailLoss: number | null;
  reasons: string[];
}
```

For a chosen horizon:

```text
edge = median terminal return
uncertainty = max(epsilon, (p90 - p10) / 2)
signalToNoise = |edge| / uncertainty
long reward/risk = median MFE / |median MAE|
short reward/risk = |median MAE| / median MFE after directional transformation
```

Initial research thresholds, versioned in config:

```text
minimum signal-to-noise = 0.25
minimum directional probability = 0.60
minimum reward/risk = 1.30
maximum adverse-tail magnitude = configurable by horizon
```

These thresholds do not become production constants merely because the code compiles. Lab benchmarks decide whether they survive.

---

## 12. Entry-Quality Metric

Forecast metrics can improve while entries get worse. Add explicit entry-location scoring.

For a long decision over its forward evaluation window:

```text
entryLocation = (entry - forwardMin) / (forwardMax - forwardMin)
```

`0` is best possible long location, `1` is worst/highest.

For a short:

```text
shortEntryPenalty = 1 - entryLocation
```

Store both raw `entryLocation` and direction-adjusted `entryPenalty`.

Degenerate window (`max == min`) is excluded from this metric and counted separately.

---

## 13. Walk-Forward Research Harness

Create:

```text
src/shared/qrmBenchmark.ts
scripts/qrm-research-loop.mjs
```

The harness must replay historical origins strictly point-in-time.

Required benchmark outputs:

```ts
export interface QrmBenchmarkSummary {
  modelVersion: string;
  configHash: string;
  forecastOrigins: number;
  symbols: number;
  crps: number | null;
  directionBrier: number | null;
  p10p90CoveragePercent: number | null;
  medianBandWidthPercent: number | null;
  decisions: number;
  longDecisions: number;
  shortDecisions: number;
  medianEntryLocationLong: number | null;
  medianEntryPenalty: number | null;
  meanForwardReturnOfDecisions: number | null;
  winRatePercent: number | null;
  expectancyR: number | null;
  expectancyCi95: ConfidenceInterval | null;
  p50RuntimeMs: number;
  p95RuntimeMs: number;
  warnings: string[];
}
```

### Split policy

Default experiment split:

```text
chronological 70% development / 30% holdout
```

Parameter changes can inspect development results. Holdout is evaluated only for candidate configurations chosen without reading holdout outcomes during that experiment cycle.

The script writes an append-only JSONL ledger:

```text
<userData or explicit research-output>/qrm-research-ledger.jsonl
```

Each row contains git revision, config hash, timestamps, dataset identity, development metrics, holdout metrics, and promotion verdict.

Repository tests use small committed synthetic fixtures; large market research data remains outside git.

---

## 14. Baselines

Every QRM experiment must compare against simple baselines:

1. `zero-return`: forward median = 0;
2. `historical-unconditional`: same symbol's unconditional historical forward distribution;
3. `momentum-sign`: directional baseline from trailing 20-day return;
4. current Signal Engine V2 decision outcomes where comparable, reported separately rather than pretending they are the same forecast object.

A complicated QRM that cannot beat simple baselines on its declared metric has not earned complexity.

---

## 15. Promotion Gates

QRM is **experimental** in Quant 3.0 by default.

It may not become the single authoritative chart decision merely because it performs well on one fixture set.

Minimum evidence before a later promotion proposal:

```text
>= 1,000 out-of-sample forecast origins
>= 25 symbols
multiple market regimes represented
P10–P90 empirical coverage between 75% and 85%
CRPS at least 2% better than unconditional baseline
Direction Brier no worse than unconditional baseline
>= 100 actual experimental decisions
median direction-adjusted entryPenalty <= 0.60
positive decision expectancy
95% bootstrap expectancy lower bound > 0 for a production-promotion claim
no point-in-time leakage failures
reproducibility tests pass
```

Runtime is a product gate, not a statistical gate:

```text
500-path shortlist run p95 <= 2.5 seconds per symbol on reference modern desktop after data is cached
```

If statistical gates pass but runtime fails, keep QRM in explicit/manual Lab mode rather than weakening the statistical gates.

---

## 16. Heavy Compute Service

Create:

```text
src/main/services/qrmService.ts
src/main/workers/qrmWorker.ts
```

Use Node `worker_threads` because QRM 3.0 is pure TypeScript/numeric logic and should not depend on Python.

Worker pool:

```text
poolSize = max(1, min(4, logicalCpuCount - 1))
```

Rules:

- one symbol job is isolated;
- deterministic seed/config passed with every job;
- cancellation token checked between path batches;
- progress emitted every 50 paths;
- result returned only after validation;
- worker crash fails that job and replaces worker; it does not terminate the app.

Required service API:

```ts
export interface QrmRunRequest {
  symbol: string;
  mode: 'discovery' | 'research' | 'lab';
  configOverride?: Partial<QrmConfig>;
}

export async function runQrm(
  request: QrmRunRequest,
  onProgress?: (progress: QrmProgress) => void,
): Promise<QrmForecastSnapshot>;
```

---

## 17. QRM Persistence

Store successful snapshots:

```text
<userData>/qrm-v3/
  forecasts/<symbol>/<snapshot-id>.json.gz
  benchmark-summary.json
```

Retention:

- research forecasts: 30 days;
- Lab results referenced by ledger: retained until explicit cleanup;
- failed/incomplete jobs are not stored as successful forecasts.

Snapshot identity includes model version + config hash + cutoff + seed.

---

## 18. Kronos Relationship

Do not merge QRM and Kronos probabilities by averaging them in 3.0.

They are different models with different assumptions.

Research workspace can show:

```text
Signal Engine V2      BUY CANDIDATE
QRM-3 Experimental    WAIT
Kronos                sampled median positive
```

When conclusions differ, show:

```text
Models disagree — investigate assumptions
```

This disagreement is itself research context, not a rule to average until consensus appears.

---

## 19. Research Model Snapshot Contract

Create a UI-neutral adapter so future models can coexist:

```ts
export interface ResearchModelView {
  modelId: string;
  modelVersion: string;
  status: 'ready' | 'running' | 'unavailable' | 'failed';
  directionalView: 'bullish' | 'bearish' | 'neutral' | 'none';
  decisionLabel: string;
  horizonLabel: string;
  reliabilityLabel: string;
  diagnostics: Array<{ label: string; value: string }>;
}
```

Do not convert all models into a shared numeric `confidence` score. Preserve their native semantics.

---

## 20. Lab UI

Create:

```text
src/renderer/components/lab/
  ResearchLabPage.tsx
  QrmRunPanel.tsx
  QrmDistributionPanel.tsx
  QrmDiagnosticsPanel.tsx
  QrmBenchmarkPanel.tsx
  ModelComparisonPanel.tsx
  ResearchLedgerPanel.tsx
```

Lab exposes:

- run QRM on symbol;
- Standard/High precision mode;
- state vector readout;
- analogue count/ESS/bandwidth;
- P10/P50/P90 terminal outcomes;
- MFE/MAE distributions;
- benchmark coverage/CRPS/Brier;
- entry quality;
- model comparison;
- experiment ledger.

Ordinary users do not need raw kernel tuning controls in the primary chart UI.

---

## 21. Research Chart Integration

Plan 02 chart may show QRM forecast as an **experimental overlay** only after user enables it.

Legend must contain model + timestamp:

```text
QRM-3 · generated Sep 15 15:42
P10–P90 sampled range
Median
```

Do not draw experimental QRM BUY/SHORT markers into the immutable production signal-history layer. If visualized, use a visually distinct research marker layer with `Experimental` in accessible label and inspector.

---

## 22. Discovery Integration

Plan 04 may request QRM only for a small final shortlist.

Default integration:

```text
Stage A full universe
→ Stage B top 50
→ Today shortlist top 10–20
→ QRM discovery mode for at most 20 symbols
```

QRM result can add a separate `Research model` reason to Today but must not overwrite Attention Score with a raw probability. If a numerical contribution is later added, it must be benchmarked and versioned as a new Attention scoring version.

---

## 23. Data-Leakage Tests

Mandatory tests:

1. Append future bars after cutoff; `buildQrmStateAt()` output must be byte-equivalent.
2. Modify future realized outcomes; analogue weights for that cutoff must not change.
3. Walk-forward candidate at index `i` cannot use an analogue whose longest outcome crosses `i`.
4. Current-day incomplete bar is excluded by default.
5. Current fundamentals cannot enter historical state unless point-in-time historical values are supplied.
6. Benchmark/sector returns align by date, not array index.

A failure in this suite blocks all model-quality claims.

---

## 24. Reproducibility Tests

Given identical:

```text
symbol
input bars
config
seed
modelVersion
```

QRM must return identical:

- state vector;
- analogue ordering;
- temperature/ESS within floating tolerance;
- sampled terminal path results;
- quantiles;
- experimental decision.

Worker scheduling order must not affect results.

---

## 25. Statistical Tests

Unit tests must cover:

- robust median/MAD scaling;
- constant-series epsilon behavior;
- weighted quantile correctness;
- ESS monotonic increase with kernel temperature;
- unreachable target ESS;
- stationary block mean behavior over many deterministic simulations;
- MFE/MAE sign conventions;
- long and short entry-location metrics;
- empirical coverage calculation;
- Brier score;
- CRPS implementation/approximation used by harness;
- bootstrap expectancy CI determinism.

Do not accept tests that only assert `not null` for mathematical outputs; use hand-checkable fixtures.

---

## 26. Implementation Tasks

### Task 1 — Contracts + point-in-time state builder

Implement `qrm.ts` and `qrmState.ts`. Pass leakage test #1 before any analogue work.

### Task 2 — Historical analogue generation

Build strictly causal records. Pass longest-horizon cutoff test.

### Task 3 — Distance + ESS bandwidth

Implement deterministic nearest pool and bandwidth solver. Test monotonicity and target reachability.

### Task 4 — Direct weighted outcome baseline

Implement weighted quantiles first. Store baseline diagnostics before adding simulation complexity.

### Task 5 — Stationary bootstrap path simulator

Use deterministic PRNG and path batches. Validate MFE/MAE/first-hit calculations.

### Task 6 — QRM forecast assembler

Produce `QrmForecastSnapshot`, validate finite values, refuse insufficient ESS/history.

### Task 7 — Experimental decision functional

Keep separate file/module. Add late-entry synthetic scenario proving positive trailing state does not automatically force a long decision when reward/risk or tail constraints fail.

### Task 8 — Walk-forward benchmark

Implement baselines, development/holdout split, metrics, JSONL ledger, and promotion verdict.

### Task 9 — Worker-thread service

Add progress/cancel/crash recovery. Verify deterministic output is independent of worker number.

### Task 10 — Lab UI

Expose diagnostics honestly, including unavailable/thin evidence states.

### Task 11 — Chart + Discovery adapters

Add experimental overlay and shortlist execution without altering immutable production Signal Engine history.

---

## 27. Verification Scripts

Add:

```json
"test:qrm-v3": "node scripts/test-qrm-v3.mjs",
"test:qrm-leakage-v3": "node scripts/test-qrm-leakage-v3.mjs",
"test:qrm-worker-v3": "node scripts/test-qrm-worker-v3.mjs",
"research:qrm": "node scripts/qrm-research-loop.mjs"
```

Required release verification:

```bash
npm run typecheck
npm run test:market-data-v3
npm run test:signal-v2
npm run test:qrm-v3
npm run test:qrm-leakage-v3
npm run test:qrm-worker-v3
npm run test:discovery-v3
npm run build
npm run smoke
npm run smoke:modal
npm run smoke:forecast
```

Research benchmark runs are not substituted for deterministic unit tests.

No GitHub Actions.

---

## 28. Definition of Done for Quant 3.0

QRM is complete for 3.0 when:

- a user can explicitly run a reproducible conditional-distribution forecast locally;
- state building is point-in-time safe;
- analogue weighting reports ESS and adaptive bandwidth;
- stationary block simulation produces 500/1,000/2,000-path modes;
- P10/P50/P90, positive frequency, MFE, MAE, and tail-order diagnostics are available;
- experimental decision is structurally separate from forecast generation;
- Lab reports CRPS, Brier, coverage, entry quality, runtime, and benchmark comparisons;
- research runs are versioned and ledgered;
- QRM cannot silently replace Signal Engine V2 without satisfying explicit future promotion gates;
- chart and Today can surface model disagreement rather than hiding it through averaged scores;
- all heavy computation remains local and bounded to explicit research/final shortlist work.

## 29. Quant 3.0 End-State

After all five Quant 3.0 plans land, the product architecture is:

```text
Persistent session-aware market data
            ↓
Full-universe fast discovery
            ↓
Deep deterministic signal research
            ↓
Optional QRM/Kronos heavy research
            ↓
Today attention queue
            ↕
Personal portfolio risk/exposure
            ↕
Modern event + signal annotated chart workspace
            ↓
Research Lab / measured model improvement
```

The product goal is not to produce more BUY labels. The goal is to make Quant a personal desktop research terminal that can discover information changes, explain them against events and signals, relate them to what the user owns, and continuously measure whether its quantitative models actually improve.