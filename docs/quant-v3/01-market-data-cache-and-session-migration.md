# Quant 3.0 — Market Data Cache & Session-Aware Chart Migration

> **For agentic workers:** Implement this document task-by-task. Use test-first changes, keep every migration reversible until the final cleanup task, and do not introduce GitHub Actions.

**Target release:** `3.0.0`

**Migration:** Quant `2.1.x` → Quant `3.0.0`

**Goal:** Replace modal-lifetime chart caching with a persistent, session-aware market-data layer that supports regular, pre-market, and after-hours bars, fast reopen, full-market scanning, and deterministic provenance.

**Architecture:** Keep Yahoo/public-data adapters at the edge, but stop letting renderer components own durable market state. The Electron main process becomes the authoritative market-data service. It stores normalized payloads under `app.getPath('userData')/market-cache-v3`, writes atomically, exposes cache metadata through IPC, and returns stale-but-usable data immediately while background refresh occurs. No new native database dependency is required for 3.0.

**Tech stack:** Electron 31+, Node built-ins (`fs`, `path`, `zlib`, `crypto`), TypeScript, React, lightweight-charts.

## Global Constraints

- Quant 3.0 remains macOS ARM64 + Windows x64.
- No GitHub Actions.
- Default experience requires no paid API and no cloud LLM.
- Sample/offline fallback must remain visibly labeled; never blend sample rows into live rows without provenance.
- All timestamps remain Unix seconds UTC at the IPC boundary.
- Session classification uses `America/New_York` exchange time for U.S. equities/ETFs.
- Cache corruption must degrade to refetch/sample fallback, never crash app startup.
- Existing `getChart(symbol, range)` behavior remains callable during migration.

---

## 1. Current-State Findings

Quant 2.1 currently:

- maps ranges in `src/main/services/chart.ts` and fetches Yahoo chart data;
- keeps a renderer-local `Map<ChartRange, ChartData>` inside `useChartData`;
- prefetches the next larger range after 700 ms;
- refreshes `1d`, `1w`, and `1m` every 15 seconds;
- merges candles by timestamp;
- loses that cache when the chart workspace unmounts or the app exits;
- has no explicit candle session field, so regular/pre/post-market rendering cannot be trustworthy;
- uses 1-minute service TTL logic but does not provide persistent stale-while-revalidate behavior.

Quant 3.0 must preserve the good parts — range prefetch, monotonic generation guards, merge-by-time — while moving persistence and session semantics to the main process.

---

## 2. Canonical 3.0 Contracts

### 2.1 Extend `Candle`

Modify `src/shared/types.ts`:

```ts
export type MarketSession = 'pre' | 'regular' | 'post' | 'closed' | 'unknown';

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  session?: MarketSession;
}
```

`session` is optional only for backward compatibility with 2.x sample fixtures. All live intraday 3.0 payloads must populate it.

### 2.2 Extend `ChartData`

```ts
export interface ChartCacheMeta {
  cacheKey: string;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
  persistent: boolean;
}

export interface ExtendedHoursQuote {
  price: number | null;
  change: number | null;
  changePercent: number | null;
  updatedAt: string | null;
}

export interface ChartData {
  symbol: string;
  range: ChartRange;
  interval: string;
  candles: Candle[];
  currency: string;
  exchangeName?: string;
  regularMarketPrice?: number | null;
  previousClose?: number | null;
  preMarket?: ExtendedHoursQuote | null;
  postMarket?: ExtendedHoursQuote | null;
  marketState?: string;
  source: DataSource;
  cache?: ChartCacheMeta;
}
```

Do not fabricate extended-hours values. Missing upstream values are `null`.

### 2.3 New request contract

```ts
export interface ChartRequest {
  symbol: string;
  range: ChartRange;
  includeExtendedHours?: boolean;
  refresh?: 'cache-first' | 'network-first' | 'force-network';
}
```

Default is `includeExtendedHours: true`, `refresh: 'cache-first'`.

---

## 3. Persistent Cache Layout

Create:

```text
<userData>/market-cache-v3/
  manifest.json
  charts/
    NVDA/
      1d-5m-ext.json.gz
      1w-15m-ext.json.gz
      1m-60m-ext.json.gz
      1y-1d.json.gz
  universe/
    latest-eod-features.json.gz
```

`manifest.json` schema:

```ts
interface MarketCacheManifestV3 {
  schemaVersion: 3;
  updatedAt: string;
  entries: Record<string, {
    relativePath: string;
    fetchedAt: string;
    expiresAt: string;
    source: DataSource;
    byteLength: number;
    sha256: string;
  }>;
}
```

Rules:

1. Write payload to `*.tmp`.
2. `fsync`/close.
3. Rename atomically to final path.
4. Update manifest through the same temp-and-rename sequence.
5. Hash compressed bytes; a hash mismatch invalidates only that entry.
6. Never delete the previous valid cache before a new payload has been committed.

### TTL policy

- `1d/5m`: 20 seconds while market state is PRE/REGULAR/POST; 10 minutes when closed.
- `1w/15m`: 60 seconds while market active; 15 minutes closed.
- `1m/60m`: 5 minutes active; 30 minutes closed.
- daily/weekly/monthly ranges: 4 hours during the trading week; 12 hours on weekends.

A stale persistent entry is still returned immediately with `cache.stale = true` when network retrieval fails.

---

## 4. Session Classification

Create `src/shared/marketSession.ts` as a pure module.

Required interface:

```ts
export interface SessionClassificationInput {
  unixSeconds: number;
  exchangeTimezone?: string;
}

export function classifyUsEquitySession(
  input: SessionClassificationInput,
): MarketSession;
```

For ordinary U.S. equity weekdays:

- `04:00 <= t < 09:30` → `pre`
- `09:30 <= t < 16:00` → `regular`
- `16:00 <= t < 20:00` → `post`
- otherwise → `closed`

The classifier is deliberately a display/session classifier, not an exchange-calendar authority. Existing forecast exchange-calendar logic remains the authority for holidays/early closes. In 3.0, chart session classification must accept a calendar override when that helper is available; until then, a holiday with no bars naturally renders nothing.

Tests must include DST dates in January and July and prove that UTC timestamps map to the same New York wall-clock rules.

---

## 5. Main-Process Services

Create:

```text
src/main/services/marketCache.ts
src/main/services/chartRepository.ts
src/shared/marketSession.ts
```

### `marketCache.ts`

Responsibilities only:

- derive cache paths;
- read/write gzip JSON;
- validate manifest/hash/schema;
- prune entries by age and max disk budget;
- expose stats.

Required API:

```ts
export interface PersistentCacheRead<T> {
  value: T;
  fetchedAt: string;
  expiresAt: string;
  stale: boolean;
}

export function readMarketCache<T>(key: string): PersistentCacheRead<T> | null;
export function writeMarketCache<T>(key: string, value: T, ttlMs: number, source: DataSource): void;
export function deleteMarketCache(key: string): void;
export function getMarketCacheStats(): {
  entries: number;
  compressedBytes: number;
};
export function pruneMarketCache(maxBytes?: number): void;
```

Default disk budget: `512 MiB`.

### `chartRepository.ts`

Responsibilities:

- normalize request;
- retrieve persistent cache;
- refresh from Yahoo;
- classify sessions;
- attach extended-hours metadata;
- return stale cache on transient failures;
- use sample data only when neither network nor persistent live cache exists.

Required API:

```ts
export async function getChartV3(request: ChartRequest): Promise<ChartData>;
export async function prefetchChartV3(symbol: string, range: ChartRange): Promise<void>;
```

Do not put UI timing or React concerns in this file.

---

## 6. Yahoo Adapter Changes

Modify `src/main/services/yahoo.ts` so chart requests can set Yahoo's extended-hours flag when supported by the endpoint. Keep all upstream-specific query names inside this adapter.

`chartRepository.ts` must not know whether the provider uses `includePrePost`, `events`, or another provider-specific field.

Normalize provider metadata into:

- `marketState`
- `regularMarketPrice`
- `preMarket`
- `postMarket`

If quote metadata and last candle disagree, preserve both rather than overwriting the candle series.

---

## 7. IPC Migration

Add channels to `src/shared/ipc.ts`:

```ts
chartGetV3: 'chart:get-v3',
chartPrefetchV3: 'chart:prefetch-v3',
marketCacheStats: 'market-cache:stats',
marketCachePrune: 'market-cache:prune',
```

Add matching preload methods and `QuantApi` signatures.

Migration rule:

- Keep `chart:get` through the entire 3.0 development cycle.
- `chart:get` delegates to `getChartV3({ includeExtendedHours: false })` after parity tests pass.
- renderer 3.0 code uses `chart:get-v3`.
- remove old `getChart()` internals only after every call site has migrated.

---

## 8. Renderer Cache Simplification

Modify `src/renderer/components/chart/useChartData.ts`.

Renderer cache becomes L1 only:

```text
L1 renderer memory cache
       ↓ miss
L2 main-process persistent cache
       ↓ stale/miss
Network provider
```

Keep:

- monotonic generation guard;
- current-canvas retention while another range loads;
- merge-by-timestamp;
- next-range prefetch.

Change:

- call `api.getChartV3()`;
- do not assume a renderer miss implies network I/O;
- refresh active intraday charts every 10 seconds only while `marketState` is PRE/REGULAR/POST;
- use 60-second refresh when CLOSED;
- request prefetch through main process instead of directly fetching into React cache.

---

## 9. Migration Tasks

### Task 1 — Lock current behavior

**Files:**
- Test: `scripts/test-chart-v3.mjs`
- Existing: `src/main/services/chart.ts`

Tests must assert:

- Yahoo null close rows are removed;
- duplicate timestamp last-write-wins behavior survives;
- OHLC sanity clamping survives;
- sample fallback remains visibly `source: 'sample'`.

Run:

```bash
npm run build
node scripts/test-chart-v3.mjs
```

### Task 2 — Add session contracts and pure classifier

Modify `src/shared/types.ts`; create `src/shared/marketSession.ts` and tests.

Acceptance:

- 08:00 ET = pre;
- 10:00 ET = regular;
- 17:15 ET = post;
- 21:00 ET = closed;
- January and July test fixtures both pass.

### Task 3 — Add persistent cache

Create `marketCache.ts` with deterministic temp-write/rename behavior.

Tests must simulate:

- valid round trip;
- corrupted gzip;
- corrupted SHA;
- stale entry;
- manifest missing;
- max-size pruning.

A corrupt entry must be removed or ignored without deleting unrelated entries.

### Task 4 — Introduce `chartRepository.ts`

Implement cache-first retrieval and stale fallback.

Test with injected fetch function; do not make tests depend on live Yahoo.

Expected precedence:

```text
fresh L2 → return immediately
stale L2 + network success → fresh network
stale L2 + network fail → stale live cache
no L2 + network fail → sample
```

### Task 5 — Add v3 IPC/preload contracts

Compile-time test the main/preload/shared contract. Every channel must map 1:1.

### Task 6 — Migrate `useChartData`

Verify switching `1m → 1y → 1m` does not tear down or refetch the already resident L1 payload, while a fresh app session receives the L2 payload without network dependence.

### Task 7 — Packaging and cache lifecycle

Update packaging scripts only as needed to include no extra native runtime. Verify both platform smoke runs.

Cache pruning runs:

- once after app ready;
- at most once per 24 hours thereafter;
- never on the renderer thread.

---

## 10. Verification Commands

Add a package script:

```json
"test:market-data-v3": "node scripts/test-chart-v3.mjs && node scripts/test-market-cache-v3.mjs"
```

Required final verification:

```bash
npm run typecheck
npm run test:quant
npm run test:signal-v2
npm run test:market-data-v3
npm run build
npm run smoke
npm run smoke:modal
```

No GitHub Actions workflow is to be added.

---

## 11. Definition of Done

Quant 3.0 market data migration is complete only when:

- opening a recently viewed ticker after app restart can render from persistent cache before network completion;
- pre/regular/post candles are explicitly classified for live intraday data;
- extended-hours quote metadata is independently available to the UI;
- sample data cannot masquerade as cached live data;
- corrupt cache files cannot crash startup;
- chart switching retains current canvas during refresh;
- the old `chart:get` path is either a compatibility delegate or has zero renderer callers;
- macOS ARM64 and Windows x64 package smoke tests pass.

## 12. Dependency on Other Quant 3.0 Documents

This plan is **Phase 1** and should land before the other four 3.0 plans. The Chart Workspace, Portfolio, Discovery, and Research Model plans may consume `ChartData`, session metadata, and persistent cache services defined here, but this plan must not depend on any of them.