# Quant 3.0 — Modern Chart Workspace, Events, Signals & Robinhood-Style Market Sessions

> **For agentic workers:** Implement after `01-market-data-cache-and-session-migration.md`. Use test-first changes. Do not add GitHub Actions.

**Target release:** `3.0.0`

**Goal:** Turn the current chart modal into Quant 3.0's primary research workspace: modern, fast, session-aware, event-annotated, signal-auditable, and visually restrained.

**Architecture:** Keep `lightweight-charts` as the rendering engine. Split data orchestration, annotations, header/session presentation, and inspector panels into focused components. All chart markers are derived from immutable typed records; no renderer component may synthesize a second trading decision.

**Design direction:** Robinhood-level clarity and density, not a clone. Use generous whitespace, thin dividers, compact typography, almost no card chrome, and explicit regular/pre/post-market state. Quant remains a research terminal rather than an order-entry interface.

## Global Constraints

- Depends on Quant 3.0 session-aware `ChartData` from Plan 01.
- Do not imply brokerage execution or live order capability.
- A chart event is informational context, not causal proof.
- Historical signal markers must preserve the decision emitted at that historical time; never recompute old markers from today's model and present them as original history.
- Signals shown on chart must include model/version provenance.
- Event markers must remain usable when event enrichment is incomplete.
- Rendering 500+ markers must not block pointer interaction; apply range filtering before rendering.

---

## 1. Target Workspace Structure

Replace the visually heavy modal composition with this hierarchy:

```text
ChartWorkspace
 ├─ SymbolHeader
 │   ├─ Symbol / company
 │   ├─ regular price + day move
 │   ├─ pre/post-market quote
 │   └─ current market session
 ├─ ChartToolbar
 │   ├─ ranges
 │   ├─ chart type
 │   ├─ indicators
 │   └─ annotation layer toggles
 ├─ ChartStage
 │   ├─ PriceSeries
 │   ├─ ExtendedHoursLayer
 │   ├─ SignalMarkersLayer
 │   ├─ EventMarkersLayer
 │   ├─ ForecastLayer
 │   └─ DrawingsLayer
 └─ ResearchInspector
     ├─ Overview
     ├─ Signal
     ├─ Events
     ├─ Forecast
     └─ Position
```

`ChartModal.tsx` becomes an orchestration shell. Do not continue adding domain logic directly to it.

---

## 2. File Decomposition

Create:

```text
src/renderer/components/chart-v3/
  ChartWorkspace.tsx
  SymbolHeader.tsx
  ChartToolbar.tsx
  ChartStage.tsx
  ResearchInspector.tsx
  layers/
    EventMarkersLayer.ts
    SignalMarkersLayer.ts
    ExtendedHoursLayer.ts
  hooks/
    useChartEvents.ts
    useSignalHistory.ts
    useChartWorkspaceState.ts
  model/
    chartAnnotations.ts
    annotationLayout.ts
```

Create main-process services:

```text
src/main/services/economicEvents.ts
src/main/services/chartEvents.ts
src/main/services/signalHistoryStore.ts
```

Existing `ChartCanvas.tsx`, `ChartModal.tsx`, `ForecastPanel.tsx`, macro overlay code, and drawing code remain available until parity is proven.

---

## 3. Session-Aware Price Header

`SymbolHeader` must show regular session and current extended-hours context without mixing bases.

Example presentation:

```text
NVDA
$184.26  +$3.86 (+2.14%)
After Hours  $185.03  +$0.77 (+0.42%)
```

Rules:

- During PRE: secondary line is `Pre-Market`.
- During REGULAR: secondary line may be omitted unless a prior pre-market quote is intentionally shown as historical context.
- During POST: secondary line is `After Hours`.
- CLOSED after post-market: retain most recent post-market value but label timestamp/date.
- Extended-hours percentage change is computed against regular close unless upstream provider gives an explicit authoritative percentage; document which basis is used in tooltip/accessibility copy.
- Never add pre/post change to regular change to create a fake combined percentage.

Create a pure formatter:

```ts
export interface SessionQuotePresentation {
  primaryLabel: string;
  primaryPrice: string;
  primaryChange: string | null;
  secondaryLabel: 'Pre-Market' | 'After Hours' | null;
  secondaryPrice: string | null;
  secondaryChange: string | null;
}

export function buildSessionQuotePresentation(
  data: ChartData,
  nowUnixSeconds: number,
): SessionQuotePresentation;
```

Test PRE, REGULAR, POST, CLOSED, and missing extended-hours quote cases.

---

## 4. Extended-Hours Chart Rendering

For intraday ranges only, visually distinguish session segments without creating a second y-axis.

Recommended v3 behavior:

- regular candles: full-opacity canonical candle rendering;
- pre/post candles: reduced visual emphasis and subtle background session bands;
- optional toolbar toggle: `Extended hours` on by default for `1D`, on for `1W`, off/irrelevant for daily ranges;
- session divider at 09:30 and 16:00 ET where bars exist;
- tooltip includes `Pre`, `Regular`, or `After Hours`.

Do not create artificial bars for session gaps.

Create `buildSessionBands(candles)` as a pure function returning contiguous ranges:

```ts
export interface SessionBand {
  session: 'pre' | 'regular' | 'post';
  from: number;
  to: number;
}
```

---

## 5. Unified Chart Event Contract

Add to `src/shared/types.ts`:

```ts
export type ChartEventKind =
  | 'fomc'
  | 'fed-press-conference'
  | 'fed-minutes'
  | 'fed-speech'
  | 'cpi'
  | 'ppi'
  | 'pce'
  | 'payrolls'
  | 'unemployment'
  | 'jolts'
  | 'jobless-claims'
  | 'gdp'
  | 'retail-sales'
  | 'ism'
  | 'treasury-auction'
  | 'earnings'
  | 'dividend'
  | 'split'
  | 'custom';

export interface ChartEventValue {
  label: string;
  actual: string | null;
  expected: string | null;
  previous: string | null;
}

export interface ChartEventReaction {
  assetReturnPercent: number | null;
  benchmarkReturnPercent: number | null;
  residualReturnPercent: number | null;
  normalizedShock: number | null;
  reactionWindow: '30m' | '1h' | 'session' | 'next-session';
}

export interface ChartEventRecord {
  id: string;
  kind: ChartEventKind;
  title: string;
  scheduledAt: string;
  occurredAt: string | null;
  sourceName: string;
  sourceUrl?: string;
  values: ChartEventValue[];
  reaction?: ChartEventReaction;
  provenance: DataSource;
}
```

`scheduledAt` is not silently replaced by `occurredAt`; both matter for event studies.

---

## 6. Economic Event Sources

`economicEvents.ts` must implement adapters behind one provider-neutral boundary. Prefer official/public sources already compatible with Quant's zero-paid-API principle. The implementation may combine official Federal Reserve/BLS/BEA/Treasury calendars and cached bundled fallback schedules.

Required API:

```ts
export interface ChartEventQuery {
  symbol: string;
  from: string;
  to: string;
  kinds?: ChartEventKind[];
}

export async function getChartEvents(query: ChartEventQuery): Promise<ChartEventRecord[]>;
```

Provider-specific parsers must live under:

```text
src/main/services/events/
  federalReserve.ts
  laborStatistics.ts
  economicAnalysis.ts
  treasury.ts
  earningsAdapter.ts
```

Every adapter must have fixture-based parser tests. Do not test by hitting live websites.

---

## 7. Event Reaction Engine

Create `src/shared/eventReaction.ts`.

Purpose: quantify what happened around an event without claiming the event caused the move.

Required pure interface:

```ts
export interface EventReactionInput {
  asset: Candle[];
  benchmark: Candle[];
  eventTime: number;
  window: '30m' | '1h' | 'session' | 'next-session';
  baselineVolatilityPercent?: number | null;
}

export function calculateEventReaction(
  input: EventReactionInput,
): ChartEventReaction;
```

Definitions:

```text
assetReturn = return over selected window
benchmarkReturn = same timestamp-aligned benchmark return
residualReturn = assetReturn - benchmarkReturn
normalizedShock = residualReturn / baselineVolatilityPercent
```

If bars are unavailable or timestamp alignment is invalid, return `null` metrics rather than interpolating across large gaps.

UI copy must use `Reaction`, `Residual move`, or `Observed move`; never `Impact caused by`.

---

## 8. Event Marker Rendering

Marker design is intentionally quiet:

- one small neutral marker on the time axis/price pane;
- short glyph or icon only when zoom level allows;
- grouped collision stack when multiple events occur in the same visible pixel bucket;
- hover = title + time;
- click = inspector opens Events tab and selects exact record.

Default visible categories:

- FOMC/rate decision;
- CPI/PCE;
- payrolls;
- ticker earnings.

Other categories are available under Events layer settings.

Do not render full event labels over candles by default.

---

## 9. Immutable Signal History Contract

Add:

```ts
export interface HistoricalSignalSnapshot {
  id: string;
  symbol: string;
  signalBarTime: number;
  observedAt: string;
  modelName: string;
  strategyVersion: string;
  decision: TradeDecision;
  setupType: SetupType;
  direction: TradeDirection;
  setupQuality: number;
  entry: number | null;
  stop: number | null;
  target1: number | null;
  target2: number | null;
  noTradeReasons: string[];
  dataCutoffTime: number;
  source: 'forward-observed' | 'imported-v2';
  outcome?: {
    status: 'open' | 'target' | 'stop' | 'timeout' | 'invalidated';
    netR: number | null;
    resolvedAt: string | null;
  };
}
```

Create `signalHistoryStore.ts` using a versioned local JSON file:

```text
<userData>/quant-signal-history-v3.json
```

Migration source: existing `quant-signal-outcomes-v1.json` records. Imported records must be marked `source: 'imported-v2'` and must not invent fields not present in v2.

---

## 10. Signal Markers on Chart

Marker semantics:

- BUY candidate: upward marker below signal bar;
- SHORT candidate: downward marker above signal bar;
- WAIT/NO TRADE: not shown by default; optional `All decisions` toggle;
- INVALIDATED: small crossed marker when a previously active thesis becomes invalidated;
- resolved outcome does not move the original signal marker.

Clicking marker opens Signal inspector with snapshot values, not freshly recomputed values.

Inspector shows:

```text
Decision
Setup Quality
Setup Type
Regime if captured
Entry / Stop / Target
Historical validation known at signal time
Forward outcome, if now resolved
Model / strategy version
Observed timestamp
Data cutoff
```

If historical validation was not captured at signal time, display `Not captured` rather than calculating today's backtest and implying it was known then.

---

## 11. Chart Workspace State

Create a versioned state object stored in renderer local storage:

```ts
export interface ChartWorkspacePreferencesV3 {
  version: 3;
  showExtendedHours: boolean;
  showSignals: boolean;
  showAllSignalDecisions: boolean;
  showEvents: boolean;
  eventKinds: ChartEventKind[];
  showForecast: boolean;
  movingAverages: Array<20 | 50 | 200>;
  logScale: boolean;
  inspectorTab: 'overview' | 'signal' | 'events' | 'forecast' | 'position';
}
```

Migrate existing overlay preferences when obvious; otherwise retain 3.0 defaults. Never silently map unrelated old controls.

---

## 12. UI Modernization Rules

### Layout

- Remove unnecessary nested cards and borders.
- Main chart gets visual priority; inspector should be collapsible.
- Toolbar controls use compact segmented/text controls instead of oversized buttons.
- Price typography should dominate the header, not app chrome.
- Use existing Quant color tokens; no gradient-heavy "AI dashboard" aesthetic.

### Interaction

- Range changes must preserve current canvas until replacement data arrives.
- Crosshair tooltip must include session name on intraday charts.
- Escape closes workspace as today.
- Keyboard navigation and reduced-motion support remain mandatory.
- Loading state should be a subtle stale-content state, not a blocking full-panel spinner when cached data exists.

### Accessibility

- event and signal markers expose accessible labels;
- color is never the only decision indicator;
- pre/post distinction has text in tooltip/legend;
- minimum interactive target remains usable with mouse and keyboard.

---

## 13. IPC Additions

Add:

```ts
chartEventsGet: 'chart:events-get',
signalHistoryGet: 'signal-history:get',
signalHistoryMigrate: 'signal-history:migrate',
```

Preload API:

```ts
getChartEvents(query: ChartEventQuery): Promise<ChartEventRecord[]>;
getSignalHistory(symbol: string, from?: number, to?: number): Promise<HistoricalSignalSnapshot[]>;
```

Signal history writes remain main-process internal; renderer cannot forge historical signal records.

---

## 14. Implementation Tasks

### Task 1 — Split chart shell without visual change

Move orchestration from `ChartModal.tsx` into `chart-v3/ChartWorkspace.tsx` while preserving current output. Run `smoke:modal` before and after.

### Task 2 — Session header and extended-hours layer

Consume Plan 01 metadata; add formatter tests and 1D/1W visual smoke fixtures.

### Task 3 — Chart event contracts + provider fixtures

Implement typed records and at least Federal Reserve + earnings paths first. Fixture parser tests must pass offline.

### Task 4 — Event reaction engine

Add deterministic synthetic candle tests covering positive, negative, benchmark-neutral, missing-bar, and zero-volatility cases.

### Task 5 — Event marker layer

Render only visible-range records. Stress test 1,000 events in fixture but ensure only viewport-relevant markers reach chart renderer.

### Task 6 — Signal history migration

Migrate v2 forward outcome records once, atomically, with migration marker/version. Running migration twice must not duplicate IDs.

### Task 7 — Signal marker layer

Use immutable snapshots and click-through inspector. Add a regression test proving changing current model output cannot alter a stored old snapshot.

### Task 8 — Modern styling

Refactor `chart-modal.css` into focused v3 styles only after functional parity. Do not combine styling refactor with event-domain logic commits.

---

## 15. Verification

Add scripts:

```json
"test:chart-v3": "node scripts/test-chart-v3-workspace.mjs",
"test:events-v3": "node scripts/test-event-reaction-v3.mjs && node scripts/test-event-adapters-v3.mjs",
"test:signal-history-v3": "node scripts/test-signal-history-v3.mjs"
```

Final commands:

```bash
npm run typecheck
npm run test:market-data-v3
npm run test:signal-v2
npm run test:chart-v3
npm run test:events-v3
npm run test:signal-history-v3
npm run build
npm run smoke:modal
npm run smoke:forecast
```

No GitHub Actions workflow is permitted.

---

## 16. Definition of Done

This phase is complete when:

- 1D/1W charts distinctly show pre/regular/post sessions without fake gap bars;
- current session quote presentation is numerically coherent;
- FOMC, CPI-class macro events, and earnings can be plotted and inspected;
- event reaction metrics are benchmark-relative and explicitly non-causal;
- historical BUY/SHORT markers reflect immutable original snapshots;
- model/version provenance is inspectable;
- event/signal overlays can be toggled independently;
- chart reopen is cache-first and non-blocking;
- UI is visibly cleaner and flatter while preserving keyboard/accessibility behavior;
- existing forecast and drawing features remain functional.

## 17. Dependency Order

Requires Plan 01. Plan 03 adds the `Position` inspector content. Plan 04 can deep-link Discovery candidates into this workspace. Plan 05 can add experimental research-model overlays only after the authoritative signal-history contract in this document is stable.