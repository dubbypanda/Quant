// Electron main process: window lifecycle, security policy, IPC wiring for
// every channel in src/shared/ipc.ts, and the automated smoke-screenshot
// mode. Data handlers never reject — they validate inputs and fall back to
// deterministic sample payloads so the renderer never sees a rejected
// promise (addToWatchlist signals failure via { ok: false } instead).

import { app, BrowserWindow, ipcMain, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { IPC } from '../shared/ipc';
import { FORECAST_V1 } from '../shared/forecast';
import type {
  AddWatchlistResult,
  ChartEventKind,
  ChartRange,
  HoldingsResult,
  LlmSettingsInput,
  MacroOverlayKey,
  PivotPoint,
  QuantJournalEntryInput,
  QuantInsightRequest,
  SignalScanRequest,
} from '../shared/types';
import { CHART_RANGES } from '../shared/types';
import { getChart } from './services/chart';
import {
  getChartV3,
  normalizeChartRequest,
  prefetchChartV3,
} from './services/chartRepository';
import {
  DEFAULT_MARKET_CACHE_BUDGET_BYTES,
  getMarketCacheStats,
  pruneMarketCache,
  pruneMarketCacheIfDue,
} from './services/marketCache';
import { getChartEvents, setEarningsProvider } from './services/economicEvents';
import {
  addPortfolioAccount,
  addPortfolioLot,
  addPortfolioLots,
  consumePortfolioRecoveryWarning,
  getPortfolioDocument,
  PortfolioValidationError,
  removePortfolioLot,
  setAccountCash,
  updatePortfolioLot,
} from './services/portfolioStore';
import {
  clearPortfolioCache,
  getPortfolioExposure,
  getPortfolioRisk,
  getPortfolioSnapshot,
  getSymbolPortfolioView,
} from './services/portfolioService';
import { buildCsvPreview, csvPreviewToLots } from './services/portfolioImport';
import {
  getUniverseHydrationStatus,
  startUniverseHydration,
  stopUniverseHydration,
} from './services/universeHydrator';
import {
  getActiveDiscoveryRun,
  getLatestDiscoveryRun,
  runDiscovery,
} from './services/discoveryDeepScan';
import { pruneDiscoveryHistory } from './services/discoveryHistoryStore';
import { DEFAULT_ELIGIBILITY_SETTINGS } from '../shared/discovery';
import {
  getSignalHistory,
  migrateV2SignalOutcomes,
} from './services/signalHistoryStore';
import { getEarnings } from './services/earnings';
import { getForecastHistory } from './services/forecastData';
import {
  evaluateForecast,
  hasCompatibleAdjustmentBasis,
  unavailableForecastComparison,
} from './services/forecastEvaluator';
import { ForecastJobRegistry } from './services/forecastJobRegistry';
import { createKronosForecastRunner } from './services/forecastOrchestrator';
import { ForecastStore } from './services/forecastStore';
import {
  bundledForecastWorkerAvailable,
  bundledForecastWorkerExecutable,
} from './services/forecastRuntime';
import { KronosWorker } from './services/kronosWorker';
import { getHoldings } from './services/holdings';
import { getLlmSettings, resolveTransientLlmSettings, saveLlmSettings } from './services/llmSettings';
import { testLlmConnection } from './services/llmProvider';
import { isLlmProvider } from '../shared/llm';
import { getMacroOverlay } from './services/macro';
import { getQuantInsights, saveQuantInsight } from './services/insightStore';
import { getQuantJournal, saveQuantJournal } from './services/journalStore';
import { getNews } from './services/news';
import { getPivotNews } from './services/pivotNews';
import { analyzeQuant } from './services/quantAi';
import { getQuotes } from './services/quotes';
import { getValuation } from './services/valuation';
import { sampleChart, sampleEarnings, sampleNews, sampleQuote } from './services/sample';
import { cleanSignalScanRequest, scanSignals } from './services/signalScanner';
import { getSignalDesk, unavailableSignalDesk } from './services/signalDesk';
import { searchSymbols } from './services/symbols';
import { clampInt, cleanSymbolList, normalizeSymbol, todayYmd } from './services/util';
import {
  addToWatchlist,
  getWatchlist,
  removeFromWatchlist,
  reorderWatchlist,
} from './services/watchlistStore';

const MAX_QUOTE_SYMBOLS = 60;
const MAX_NEWS_SYMBOLS = 40;
const MAX_EARNINGS_SYMBOLS = 60;
const MAX_PIVOTS = 12;
const configuredForecastPython = process.env.QUANT_FORECAST_PYTHON?.trim();
const forecastVenvPython = path.resolve(
  __dirname,
  '..',
  '..',
  '.forecast-venv',
  process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python',
);
const bundledForecastExecutable = bundledForecastWorkerExecutable(
  process.resourcesPath,
);
const useBundledForecastWorker = bundledForecastWorkerAvailable(
  process.resourcesPath,
);
const forecastWorker = new KronosWorker({
  scriptPath: useBundledForecastWorker
    ? undefined
    : path.join(__dirname, 'forecast-engine', 'worker.py'),
  workerExecutable: useBundledForecastWorker
    ? bundledForecastExecutable
    : undefined,
  pythonExecutable: useBundledForecastWorker
    ? undefined
    : configuredForecastPython ||
      (fs.existsSync(forecastVenvPython) ? forecastVenvPython : undefined),
  onStderr: (message) => console.error(`[forecast-worker] ${message}`),
});
const forecastJobs = new ForecastJobRegistry({
  loadHistory: getForecastHistory,
  onDiagnostic: (message) =>
    console.error(`[forecast-jobs] ${message}`),
  runner: createKronosForecastRunner(forecastWorker, {
    onDiagnostic: (message) =>
      console.error(`[forecast-orchestrator] ${message}`),
  }),
});
let forecastStore: ForecastStore | null = null;

// ---------------------------------------------------------------------------
// CLI flags (smoke mode)
// ---------------------------------------------------------------------------

const isSmoke = process.argv.includes('--smoke');
const forceOnboarding =
  process.argv.includes('--onboarding') || process.argv.includes('--smoke-onboarding');
const smokeOnboardingStepArg = process.argv.find((arg) => arg.startsWith('--smoke-onboarding-step='));
const smokeOnboardingStep = smokeOnboardingStepArg?.slice('--smoke-onboarding-step='.length);
const smokeModalArg = process.argv.find((arg) => arg.startsWith('--smoke-modal='));
const smokeModalSymbol = smokeModalArg
  ? normalizeSymbol(smokeModalArg.slice('--smoke-modal='.length))
  : null;
const smokeRailArg = process.argv.find((arg) => arg.startsWith('--smoke-rail='));
const smokeRail = smokeRailArg?.slice('--smoke-rail='.length);
const smokeOverlaysArg = process.argv.find((arg) => arg.startsWith('--smoke-overlays='));
const smokeOverlays = smokeOverlaysArg?.slice('--smoke-overlays='.length);
const smokeTabArg = process.argv.find((arg) => arg.startsWith('--smoke-tab='));
const smokeTab = smokeTabArg?.slice('--smoke-tab='.length);
const smokeChartModeArg = process.argv.find((arg) => arg.startsWith('--smoke-chart-mode='));
const smokeChartMode = smokeChartModeArg?.slice('--smoke-chart-mode='.length);
const smokeChartRangeArg = process.argv.find((arg) => arg.startsWith('--smoke-chart-range='));
const smokeChartRange = smokeChartRangeArg?.slice('--smoke-chart-range='.length);

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function cleanPivots(raw: unknown): PivotPoint[] {
  if (!Array.isArray(raw)) return [];
  const out: PivotPoint[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Partial<PivotPoint>;
    if (typeof p.time !== 'number' || !Number.isFinite(p.time)) continue;
    if (typeof p.price !== 'number' || !Number.isFinite(p.price)) continue;
    if (p.kind !== 'high' && p.kind !== 'low') continue;
    out.push({ time: p.time, price: p.price, kind: p.kind });
    if (out.length >= MAX_PIVOTS) break;
  }
  return out;
}

function cleanRange(raw: unknown): ChartRange {
  return CHART_RANGES.includes(raw as ChartRange) ? (raw as ChartRange) : '6m';
}

function cleanMacroOverlayKey(raw: unknown): MacroOverlayKey {
  return raw === 'jobs' ||
    raw === 'unemployment' ||
    raw === 'inflation' ||
    raw === 'treasury10y' ||
    raw === 'oil' ||
    raw === 'vix'
    ? raw
    : 'jobs';
}

function cleanQuantInsightRequest(raw: unknown): QuantInsightRequest | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<QuantInsightRequest>;
  const symbol = normalizeSymbol(r.symbol);
  if (!symbol) return null;
  if (!r.evaluation || typeof r.evaluation !== 'object') return null;
  return {
    symbol,
    range: cleanRange(r.range),
    evaluation: r.evaluation as QuantInsightRequest['evaluation'],
    news: Array.isArray(r.news) ? r.news.slice(0, 12) : [],
    earnings: r.earnings && typeof r.earnings === 'object' ? r.earnings : null,
    valuation: r.valuation && typeof r.valuation === 'object' ? r.valuation : null,
    macroOverlays: Array.isArray(r.macroOverlays)
      ? r.macroOverlays.slice(0, 8).map((series) => ({
          ...series,
          points: Array.isArray(series.points) ? series.points.slice(-60) : [],
        }))
      : [],
    snapshotDataUrl: typeof r.snapshotDataUrl === 'string' ? r.snapshotDataUrl.slice(0, 1_000_000) : undefined,
    question: typeof r.question === 'string' ? r.question.slice(0, 1200) : undefined,
    thinkingMode: r.thinkingMode === true,
  };
}

function cleanQuantJournalInput(raw: unknown): QuantJournalEntryInput | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<QuantJournalEntryInput>;
  const symbol = normalizeSymbol(value.symbol);
  if (!symbol || !value.evaluation || typeof value.evaluation !== 'object') return null;
  if (!value.evaluation.risk || typeof value.evaluation.risk !== 'object') return null;
  const status =
    value.status === 'active' || value.status === 'invalidated' || value.status === 'closed'
      ? value.status
      : 'planned';
  return {
    id: typeof value.id === 'string' ? value.id.slice(0, 200) : undefined,
    symbol,
    range: cleanRange(value.range),
    status,
    thesis: typeof value.thesis === 'string' ? value.thesis : '',
    catalyst: typeof value.catalyst === 'string' ? value.catalyst : '',
    invalidation: typeof value.invalidation === 'string' ? value.invalidation : '',
    notes: typeof value.notes === 'string' ? value.notes : undefined,
    evaluation: value.evaluation,
  };
}

// ---------------------------------------------------------------------------
// IPC handlers — one per channel, signatures matching QuantApi
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  ipcMain.handle(IPC.watchlistGet, () => {
    try {
      return getWatchlist();
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.watchlistAdd, async (_e, rawSymbol: unknown): Promise<AddWatchlistResult> => {
    try {
      if (typeof rawSymbol !== 'string') return { ok: false, error: 'Invalid symbol' };
      return await addToWatchlist(rawSymbol);
    } catch {
      return { ok: false, error: 'Could not add symbol' };
    }
  });

  ipcMain.handle(IPC.watchlistRemove, (_e, rawSymbol: unknown) => {
    try {
      const symbol = normalizeSymbol(rawSymbol);
      return symbol ? removeFromWatchlist(symbol) : getWatchlist();
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.watchlistReorder, (_e, rawOrder: unknown) => {
    try {
      return reorderWatchlist(rawOrder);
    } catch {
      return getWatchlist();
    }
  });

  ipcMain.handle(IPC.symbolsSearch, async (_e, rawQuery: unknown) => {
    try {
      if (typeof rawQuery !== 'string') return [];
      return await searchSymbols(rawQuery);
    } catch {
      return [];
    }
  });

  ipcMain.handle(IPC.quotesGet, async (_e, rawSymbols: unknown) => {
    const symbols = cleanSymbolList(rawSymbols, MAX_QUOTE_SYMBOLS);
    try {
      return await getQuotes(symbols);
    } catch {
      return symbols.map((s) => sampleQuote(s));
    }
  });

  ipcMain.handle(IPC.holdingsGet, async (_e, rawSymbol: unknown): Promise<HoldingsResult> => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
      return { etfSymbol: '', asOf: todayYmd(), holdings: [], source: 'sample' };
    }
    try {
      return await getHoldings(symbol);
    } catch {
      return { etfSymbol: symbol, asOf: todayYmd(), holdings: [], source: 'sample' };
    }
  });

  ipcMain.handle(IPC.newsGet, async (_e, rawSymbols: unknown, rawLimit: unknown) => {
    const symbols = cleanSymbolList(rawSymbols, MAX_NEWS_SYMBOLS);
    const limitPerSymbol = clampInt(rawLimit, 1, 20, 6);
    try {
      return await getNews(symbols, limitPerSymbol);
    } catch {
      return sampleNews(symbols);
    }
  });

  ipcMain.handle(IPC.earningsGet, async (_e, rawSymbols: unknown) => {
    const symbols = cleanSymbolList(rawSymbols, MAX_EARNINGS_SYMBOLS);
    try {
      return await getEarnings(symbols);
    } catch {
      return symbols.map((s) => sampleEarnings(s));
    }
  });

  ipcMain.handle(IPC.chartGet, async (_e, rawSymbol: unknown, rawRange: unknown) => {
    const symbol = normalizeSymbol(rawSymbol) ?? 'SPY';
    const range = cleanRange(rawRange);
    try {
      return await getChart(symbol, range);
    } catch {
      return sampleChart(symbol, range);
    }
  });

  ipcMain.handle(IPC.chartGetV3, async (_e, rawRequest: unknown) => {
    // The renderer is untrusted input: symbol, range and the enum fields are
    // all re-derived here rather than spread from the payload.
    const raw = rawRequest && typeof rawRequest === 'object' ? (rawRequest as Record<string, unknown>) : {};
    const symbol = normalizeSymbol(raw.symbol) ?? 'SPY';
    const range = cleanRange(raw.range);
    const refresh =
      raw.refresh === 'network-first' || raw.refresh === 'force-network'
        ? raw.refresh
        : 'cache-first';
    const request = normalizeChartRequest({
      symbol,
      range,
      includeExtendedHours: raw.includeExtendedHours !== false,
      refresh,
    });
    try {
      return await getChartV3(request);
    } catch {
      return sampleChart(request.symbol, request.range);
    }
  });

  ipcMain.handle(IPC.chartPrefetchV3, async (_e, rawSymbol: unknown, rawRange: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return;
    await prefetchChartV3(symbol, cleanRange(rawRange));
  });

  ipcMain.handle(IPC.marketCacheStats, async () => {
    try {
      return getMarketCacheStats();
    } catch {
      return { entries: 0, compressedBytes: 0 };
    }
  });

  ipcMain.handle(IPC.marketCachePrune, async (_e, rawMaxBytes: unknown) => {
    const maxBytes =
      typeof rawMaxBytes === 'number' && Number.isFinite(rawMaxBytes) && rawMaxBytes > 0
        ? rawMaxBytes
        : DEFAULT_MARKET_CACHE_BUDGET_BYTES;
    try {
      pruneMarketCache(maxBytes);
    } catch {
      /* a failed prune is reported through the returned stats, not by throwing */
    }
    try {
      return getMarketCacheStats();
    } catch {
      return { entries: 0, compressedBytes: 0 };
    }
  });

  ipcMain.handle(IPC.chartEventsGet, async (_e, rawQuery: unknown) => {
    const raw = rawQuery && typeof rawQuery === 'object' ? (rawQuery as Record<string, unknown>) : {};
    const symbol = normalizeSymbol(raw.symbol) ?? '';
    const from = typeof raw.from === 'string' ? raw.from : '';
    const to = typeof raw.to === 'string' ? raw.to : '';
    if (!from || !to) return [];
    const kinds = Array.isArray(raw.kinds)
      ? (raw.kinds.filter((kind) => typeof kind === 'string') as ChartEventKind[])
      : undefined;
    try {
      return await getChartEvents({ symbol, from, to, kinds });
    } catch {
      // An empty calendar is a usable chart; a rejected promise is not.
      return [];
    }
  });

  ipcMain.handle(
    IPC.signalHistoryGet,
    async (_e, rawSymbol: unknown, rawFrom: unknown, rawTo: unknown) => {
      const symbol = normalizeSymbol(rawSymbol);
      if (!symbol) return [];
      const from = typeof rawFrom === 'number' && Number.isFinite(rawFrom) ? rawFrom : undefined;
      const to = typeof rawTo === 'number' && Number.isFinite(rawTo) ? rawTo : undefined;
      try {
        return getSignalHistory(symbol, from, to);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle(IPC.signalHistoryMigrate, async () => {
    try {
      return migrateV2SignalOutcomes();
    } catch (error) {
      return {
        ran: false,
        imported: 0,
        skipped: 0,
        reason: error instanceof Error ? error.message : 'Migration failed.',
      };
    }
  });

  // ---- Portfolio -----------------------------------------------------
  //
  // Every write re-validates here. Renderer validation is usability only: the
  // renderer is untrusted input, so nothing below trusts a payload's shape.
  const portfolioWrite = (
    run: () => import('../shared/portfolio').PortfolioDocumentV3,
  ): import('../shared/types').PortfolioWriteResult => {
    try {
      const document = run();
      clearPortfolioCache();
      return { ok: true, document };
    } catch (error) {
      if (error instanceof PortfolioValidationError) {
        return { ok: false, errors: error.errors };
      }
      return {
        ok: false,
        errors: [error instanceof Error ? error.message : 'The portfolio update failed.'],
      };
    }
  };

  const positiveNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  const nonNegativeNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length ? value.trim() : null;

  ipcMain.handle(IPC.portfolioGet, async () => {
    const document = getPortfolioDocument();
    const warning = consumePortfolioRecoveryWarning();
    if (warning) console.warn(`[portfolio] ${warning}`);
    return document;
  });

  ipcMain.handle(IPC.portfolioSnapshotGet, async () => getPortfolioSnapshot());
  ipcMain.handle(IPC.portfolioRiskGet, async () => getPortfolioRisk());
  ipcMain.handle(IPC.portfolioExposureGet, async () => getPortfolioExposure());

  ipcMain.handle(IPC.portfolioSymbolContextGet, async (_e, rawSymbol: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) {
      return {
        context: {
          owned: false,
          quantity: 0,
          averageCost: null,
          marketValue: null,
          unrealizedPnl: null,
          weightPercent: null,
          componentRiskPercent: null,
          indirectExposurePercent: null,
        },
        action: 'not-owned',
      };
    }
    return getSymbolPortfolioView(symbol);
  });

  ipcMain.handle(IPC.portfolioAccountAdd, async (_e, rawInput: unknown) => {
    const raw = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
    const name = text(raw.name);
    const type = raw.type;
    if (!name) return { ok: false, errors: ['An account needs a name.'] };
    if (!['taxable', 'ira', 'roth-ira', '401k', 'other'].includes(type as string)) {
      return { ok: false, errors: ['Unknown account type.'] };
    }
    return portfolioWrite(() =>
      addPortfolioAccount({
        name,
        type: type as import('../shared/portfolio').PortfolioAccountType,
        currency: 'USD',
      }),
    );
  });

  ipcMain.handle(IPC.portfolioLotAdd, async (_e, rawInput: unknown) => {
    const raw = rawInput && typeof rawInput === 'object' ? (rawInput as Record<string, unknown>) : {};
    const symbol = normalizeSymbol(raw.symbol);
    const quantity = positiveNumber(raw.quantity);
    const costPerShare = nonNegativeNumber(raw.costPerShare);
    const accountId = text(raw.accountId);
    const errors: string[] = [];
    if (!symbol) errors.push('A valid symbol is required.');
    if (quantity === null) errors.push('Quantity must be greater than zero.');
    if (costPerShare === null) errors.push('Cost per share must be zero or greater.');
    if (!accountId) errors.push('An account is required.');
    if (errors.length) return { ok: false, errors };
    return portfolioWrite(() =>
      addPortfolioLot({
        symbol: symbol as string,
        quantity: quantity as number,
        costPerShare: costPerShare as number,
        accountId: accountId as string,
        acquiredAt: typeof raw.acquiredAt === 'string' ? raw.acquiredAt : null,
        ...(text(raw.note) ? { note: text(raw.note) as string } : {}),
      }),
    );
  });

  ipcMain.handle(IPC.portfolioLotUpdate, async (_e, rawId: unknown, rawPatch: unknown) => {
    const id = text(rawId);
    if (!id) return { ok: false, errors: ['A lot id is required.'] };
    const raw = rawPatch && typeof rawPatch === 'object' ? (rawPatch as Record<string, unknown>) : {};
    const patch: Record<string, unknown> = {};
    // Only known fields are copied across; a patch is never spread wholesale.
    if (raw.quantity !== undefined) {
      const quantity = positiveNumber(raw.quantity);
      if (quantity === null) return { ok: false, errors: ['Quantity must be greater than zero.'] };
      patch.quantity = quantity;
    }
    if (raw.costPerShare !== undefined) {
      const costPerShare = nonNegativeNumber(raw.costPerShare);
      if (costPerShare === null) {
        return { ok: false, errors: ['Cost per share must be zero or greater.'] };
      }
      patch.costPerShare = costPerShare;
    }
    if (raw.acquiredAt !== undefined) {
      patch.acquiredAt = typeof raw.acquiredAt === 'string' ? raw.acquiredAt : null;
    }
    if (raw.accountId !== undefined) {
      const accountId = text(raw.accountId);
      if (!accountId) return { ok: false, errors: ['An account is required.'] };
      patch.accountId = accountId;
    }
    if (raw.note !== undefined) patch.note = typeof raw.note === 'string' ? raw.note : '';
    return portfolioWrite(() => updatePortfolioLot(id, patch));
  });

  ipcMain.handle(IPC.portfolioLotRemove, async (_e, rawId: unknown) => {
    const id = text(rawId);
    if (!id) return { ok: false, errors: ['A lot id is required.'] };
    return portfolioWrite(() => removePortfolioLot(id));
  });

  ipcMain.handle(IPC.portfolioCashSet, async (_e, rawAccountId: unknown, rawAmount: unknown) => {
    const accountId = text(rawAccountId);
    const amount = nonNegativeNumber(rawAmount);
    if (!accountId) return { ok: false, errors: ['An account is required.'] };
    if (amount === null) return { ok: false, errors: ['Cash must be zero or greater.'] };
    return portfolioWrite(() => setAccountCash(accountId, amount));
  });

  ipcMain.handle(IPC.portfolioCsvPreview, async (_e, rawText: unknown) => {
    const csv = typeof rawText === 'string' ? rawText : '';
    return buildCsvPreview({ text: csv });
  });

  ipcMain.handle(IPC.portfolioCsvImport, async (_e, rawText: unknown, rawAccountId: unknown) => {
    const csv = typeof rawText === 'string' ? rawText : '';
    const accountId = text(rawAccountId);
    if (!accountId) return { ok: false, errors: ['An account is required.'] };
    const document = getPortfolioDocument();
    if (!document.accounts.some((account) => account.id === accountId)) {
      return { ok: false, errors: ['The selected account no longer exists.'] };
    }
    const preview = buildCsvPreview({ text: csv });
    if (!preview.validRowCount) {
      return { ok: false, errors: ['No valid rows were found in the file.'] };
    }
    const lots = csvPreviewToLots(preview, accountId, document);
    return portfolioWrite(() => addPortfolioLots(lots));
  });

  // ---- Discovery -----------------------------------------------------
  ipcMain.handle(IPC.discoveryHydrationStatus, async () => getUniverseHydrationStatus());

  ipcMain.handle(IPC.discoveryHydrationStart, async () => {
    // Fire and forget: hydration is a long background walk and the renderer
    // polls status rather than awaiting the whole universe.
    void startUniverseHydration().catch((error) => {
      console.warn('[discovery] hydration failed:', error);
    });
    return getUniverseHydrationStatus();
  });

  ipcMain.handle(IPC.discoveryHydrationStop, async () => {
    stopUniverseHydration();
    return getUniverseHydrationStatus();
  });

  ipcMain.handle(IPC.discoveryRun, async (_e, rawSettings: unknown) => {
    const active = getActiveDiscoveryRun();
    if (active) {
      // A duplicate request reports the in-flight run instead of starting a
      // second full-universe computation.
      return { status: 'running', id: active.id, startedAt: active.startedAt };
    }
    const raw = rawSettings && typeof rawSettings === 'object'
      ? (rawSettings as Record<string, unknown>)
      : {};
    const numberOr = (value: unknown, fallback: number): number =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
    const booleanOr = (value: unknown, fallback: boolean): boolean =>
      typeof value === 'boolean' ? value : fallback;
    const settings = {
      minimumPrice: numberOr(raw.minimumPrice, DEFAULT_ELIGIBILITY_SETTINGS.minimumPrice),
      minimumMedianDollarVolume20: numberOr(
        raw.minimumMedianDollarVolume20,
        DEFAULT_ELIGIBILITY_SETTINGS.minimumMedianDollarVolume20,
      ),
      minimumHistoryBars: numberOr(
        raw.minimumHistoryBars,
        DEFAULT_ELIGIBILITY_SETTINGS.minimumHistoryBars,
      ),
      includeEtfs: booleanOr(raw.includeEtfs, DEFAULT_ELIGIBILITY_SETTINGS.includeEtfs),
      includeLeveragedEtfs: booleanOr(
        raw.includeLeveragedEtfs,
        DEFAULT_ELIGIBILITY_SETTINGS.includeLeveragedEtfs,
      ),
      includeInverseEtfs: booleanOr(
        raw.includeInverseEtfs,
        DEFAULT_ELIGIBILITY_SETTINGS.includeInverseEtfs,
      ),
      includeSingleStockEtfs: booleanOr(
        raw.includeSingleStockEtfs,
        DEFAULT_ELIGIBILITY_SETTINGS.includeSingleStockEtfs,
      ),
    };
    try {
      return { status: 'completed', result: await runDiscovery({ settings }) };
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof Error ? error.message : 'The discovery run failed.',
      };
    }
  });

  ipcMain.handle(IPC.discoveryLatest, async () => getLatestDiscoveryRun());

  ipcMain.handle(IPC.pivotNewsGet, async (_e, rawSymbol: unknown, rawPivots: unknown) => {
    const pivots = cleanPivots(rawPivots);
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return pivots.map((pivot) => ({ pivot, items: [] }));
    try {
      return await getPivotNews(symbol, pivots);
    } catch {
      return pivots.map((pivot) => ({ pivot, items: [] }));
    }
  });

  ipcMain.handle(IPC.macroOverlayGet, async (_e, rawKey: unknown, rawRange: unknown) => {
    const key = cleanMacroOverlayKey(rawKey);
    const range = cleanRange(rawRange);
    return getMacroOverlay(key, range);
  });

  ipcMain.handle(IPC.chartSnapshotCapture, async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return null;
    try {
      const image = await mainWindow.webContents.capturePage();
      return {
        dataUrl: image.toDataURL(),
        capturedAt: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.quantAnalyze, async (_e, rawRequest: unknown) => {
    const request = cleanQuantInsightRequest(rawRequest);
    if (!request) {
      return {
        ok: false,
        source: 'deterministic-fallback',
        answer: 'Quant analysis could not run because the request payload was invalid.',
        generatedAt: new Date().toISOString(),
        error: 'Invalid request',
      };
    }
    const response = await analyzeQuant(request);
    try {
      saveQuantInsight(request, response);
    } catch (err) {
      console.error('[quant] save insight failed:', err);
    }
    return response;
  });

  ipcMain.handle(IPC.quantInsightsGet, async (_e, rawSymbol: unknown, rawRange: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return [];
    return getQuantInsights(symbol, CHART_RANGES.includes(rawRange as ChartRange) ? (rawRange as ChartRange) : undefined);
  });

  ipcMain.handle(IPC.quantJournalGet, (_e, rawSymbol: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    return symbol ? getQuantJournal(symbol) : [];
  });

  ipcMain.handle(IPC.quantJournalSave, (_e, rawEntry: unknown) => {
    const entry = cleanQuantJournalInput(rawEntry);
    if (!entry) throw new Error('Invalid decision journal entry');
    return saveQuantJournal(entry);
  });

  ipcMain.handle(IPC.llmSettingsGet, () => getLlmSettings());

  ipcMain.handle(IPC.llmSettingsSave, (_e, rawSettings: unknown) => {
    const s =
      rawSettings && typeof rawSettings === 'object'
        ? (rawSettings as Partial<LlmSettingsInput>)
        : {};
    return saveLlmSettings({
      enabled: s.enabled === true,
      provider: isLlmProvider(s.provider) ? s.provider : 'local',
      baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
      model: typeof s.model === 'string' ? s.model : '',
      apiKey: typeof s.apiKey === 'string' ? s.apiKey.slice(0, 1000) : undefined,
      clearApiKey: s.clearApiKey === true,
    });
  });

  ipcMain.handle(IPC.llmConnectionTest, async (_e, rawSettings: unknown) => {
    const s = rawSettings && typeof rawSettings === 'object'
      ? (rawSettings as Partial<LlmSettingsInput>)
      : {};
    const input: LlmSettingsInput = {
      enabled: s.enabled === true,
      provider: isLlmProvider(s.provider) ? s.provider : 'local',
      baseUrl: typeof s.baseUrl === 'string' ? s.baseUrl : '',
      model: typeof s.model === 'string' ? s.model : '',
      apiKey: typeof s.apiKey === 'string' ? s.apiKey.slice(0, 1000) : undefined,
    };
    return testLlmConnection(resolveTransientLlmSettings(input));
  });

  ipcMain.handle(IPC.valuationGet, async (_e, rawSymbol: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    return getValuation(symbol ?? 'SPY');
  });

  ipcMain.handle(IPC.signalsScan, async (_e, rawRequest: unknown) => {
    const request: SignalScanRequest = cleanSignalScanRequest(rawRequest);
    try {
      return await scanSignals(request);
    } catch (err) {
      console.error('[signals] scan failed:', err);
      return scanSignals({ ...request, symbols: request.symbols?.slice(0, 20), limit: 20 });
    }
  });

  ipcMain.handle(IPC.signalDeskGet, async (_e, rawSymbol: unknown) => {
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return unavailableSignalDesk('', 'Invalid symbol');
    try {
      return await getSignalDesk(symbol);
    } catch (error) {
      console.error('[signal-desk] failed:', error);
      return unavailableSignalDesk(symbol, 'Signal Desk could not load.');
    }
  });

  ipcMain.handle(IPC.forecastRun, (_e, rawRequest: unknown) => {
    return forecastJobs.start(rawRequest);
  });

  ipcMain.handle(IPC.forecastCancel, (_e, rawJobId: unknown) => {
    return forecastJobs.cancel(rawJobId);
  });

  ipcMain.handle(IPC.forecastGetJob, (_e, rawSymbol: unknown) => {
    return forecastJobs.getJob(rawSymbol);
  });

  ipcMain.handle(IPC.forecastListSaved, (_e, rawSymbol: unknown) => {
    return forecastStore?.list(rawSymbol) ?? [];
  });

  ipcMain.handle(IPC.forecastGetSaved, (_e, rawForecastId: unknown) => {
    return forecastStore?.get(rawForecastId) ?? null;
  });

  ipcMain.handle(
    IPC.forecastGetHistoricalComparison,
    async (_e, rawForecastId: unknown) => {
      const record = forecastStore?.get(rawForecastId);
      if (!record) return null;
      const evaluatedAt = new Date().toISOString();
      try {
        const history = await getForecastHistory({
          symbol: record.symbol,
          assetType: record.assetType,
          requestedAt: evaluatedAt,
          paths: FORECAST_V1.pathCount,
          horizonBars: FORECAST_V1.predictionBars,
          interval: FORECAST_V1.interval,
        });
        if (
          !hasCompatibleAdjustmentBasis(record.provenance, history, {
            timestamp: record.provenance.latestCompletedCandleAt,
            close: record.lastHistoricalClose,
          })
        ) {
          console.warn(
            `[forecast-evaluator] Adjustment basis changed for ${record.symbol}; historical comparison was skipped.`,
          );
          return unavailableForecastComparison(evaluatedAt);
        }
        const comparison = evaluateForecast(
          record,
          history.candles,
          evaluatedAt,
        );
        if (comparison.evaluation.status !== 'unavailable') {
          const updated = forecastStore?.updateEvaluation(
            record.id,
            comparison.evaluation,
          );
          if (updated) {
            comparison.evaluation = updated.evaluation;
          }
        }
        return comparison;
      } catch (error) {
        console.warn(
          `[forecast-evaluator] Historical comparison unavailable for ${record.symbol}: ${String(error)}`,
        );
        return unavailableForecastComparison(evaluatedAt);
      }
    },
  );

  ipcMain.handle(
    IPC.forecastSetOverlayEnabled,
    (_e, rawSymbol: unknown, rawEnabled: unknown) => {
      return forecastStore?.setOverlayEnabled(rawSymbol, rawEnabled) ?? false;
    },
  );

  ipcMain.handle(IPC.forecastGetOverlayEnabled, (_e, rawSymbol: unknown) => {
    return forecastStore?.getOverlayEnabled(rawSymbol) ?? false;
  });

  ipcMain.handle(IPC.openExternal, async (_e, rawUrl: unknown) => {
    if (typeof rawUrl !== 'string') return;
    let parsed: URL;
    try {
      parsed = new URL(rawUrl);
    } catch {
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
    try {
      await shell.openExternal(parsed.toString());
    } catch (err) {
      console.error('[shell] openExternal failed:', err);
    }
  });
}

// ---------------------------------------------------------------------------
// Smoke mode: screenshot after load, then quit. Hard timeout at 45s.
// ---------------------------------------------------------------------------

function armSmokeMode(win: BrowserWindow): void {
  // Smoke runs execute on a live desktop: shield the window from stray user
  // clicks/keystrokes so accidental input can't mutate UI state (e.g. opening
  // or closing the chart modal) before the screenshot is captured.
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);

  win.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer] ' + message);
  });
  // Surface renderer crashes/reloads in smoke logs — a mid-run reload resets
  // renderer state and can invalidate the screenshot.
  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] process gone: ' + details.reason);
  });
  win.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) console.log('[smoke] main-frame navigation: ' + url);
  });

  const killer = setTimeout(() => {
    console.error('SMOKE_FAIL hard timeout after 45s');
    app.exit(1);
  }, 45_000);
  killer.unref();

  win.webContents.once('did-finish-load', () => {
    const envDelay = Number(process.env.QUANT_SMOKE_DELAY_MS);
    const delayMs =
      Number.isFinite(envDelay) && envDelay > 0
        ? Math.min(envDelay, 40_000)
        : smokeModalSymbol
          ? 16_000
          : 13_000;
    setTimeout(async () => {
      try {
        const image = await win.webContents.capturePage();
        const outPath =
          process.env.QUANT_SMOKE_OUT ||
          path.join(
            app.getAppPath(),
            smokeModalSymbol ? 'dist/smoke-modal.png' : 'dist/smoke.png',
          );
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        fs.writeFileSync(outPath, image.toPNG());
        clearTimeout(killer);
        console.log('SMOKE_OK ' + outPath);
        app.quit();
      } catch (err) {
        console.error('SMOKE_FAIL', err);
        process.exitCode = 1;
        app.quit();
      }
    }, delayMs);
  });
}

// ---------------------------------------------------------------------------
// Window + app lifecycle
// ---------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;

forecastJobs.subscribe((event) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(IPC.forecastProgress, event);
  if (event.stage === 'completed') {
    mainWindow.webContents.send(IPC.forecastCompleted, event);
  } else if (event.stage === 'failed') {
    mainWindow.webContents.send(IPC.forecastFailed, event);
  }
});

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1560,
    height: 940,
    minWidth: 1200,
    minHeight: 760,
    backgroundColor: '#0a0e16',
    autoHideMenuBar: true,
    title: 'Quant',
    icon: path.join(__dirname, 'assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  // Security: never open child windows, never navigate away.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  if (isSmoke) armSmokeMode(win);

  const indexPath = path.join(__dirname, '../renderer/index.html');
  const query: Record<string, string> = {};
  if (smokeModalSymbol) query.smokeModal = smokeModalSymbol;
  if (smokeRail) query.smokeRail = smokeRail;
  if (smokeOverlays) query.smokeOverlays = smokeOverlays;
  if (smokeTab === 'pulse' || smokeTab === 'analysis' || smokeTab === 'news' || smokeTab === 'signals' || smokeTab === 'settings') query.smokeTab = smokeTab;
  if (smokeChartMode === 'grid' || smokeChartMode === 'single') {
    query.smokeChartMode = smokeChartMode;
  }
  if (smokeChartRange === '1m' || smokeChartRange === '3m' || smokeChartRange === '1y') {
    query.smokeChartRange = smokeChartRange;
  }
  if (forceOnboarding) query.onboarding = '1';
  if (smokeOnboardingStep === 'llm' || smokeOnboardingStep === 'tips') {
    query.onboardingStep = smokeOnboardingStep;
  }
  if (Object.keys(query).length) {
    void win.loadFile(indexPath, { query });
  } else {
    void win.loadFile(indexPath);
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[main] unhandled rejection:', reason);
  });

  app.on('before-quit', () => {
    forecastWorker.terminate();
  });

  app.whenReady().then(() => {
    try {
      forecastStore = new ForecastStore(
        path.join(app.getPath('userData'), 'forecasts', 'v1'),
        {
          onWarning: (message) => console.warn(`[forecast-store] ${message}`),
        },
      );
      forecastJobs.configureRecordSaver((record) => {
        if (!forecastStore) throw new Error('Forecast storage is unavailable');
        return forecastStore.save(record);
      });
    } catch (error) {
      forecastStore = null;
      console.error('[forecast-store] initialization failed:', error);
    }
    registerIpcHandlers();
    createWindow();

    // Chart events read earnings through the existing service rather than a
    // second source of truth for the same fact.
    setEarningsProvider(async (symbol) => {
      try {
        return await getEarnings([symbol]);
      } catch {
        return [];
      }
    });

    // Signal history import runs once, guarded by its own marker.
    try {
      const migration = migrateV2SignalOutcomes();
      if (migration.ran && migration.imported > 0) {
        console.log(`[signal-history] imported ${migration.imported} v2 records`);
      }
    } catch (error) {
      console.warn('[signal-history] migration skipped:', error);
    }

    // Universe hydration is a background walk that must not delay startup, so
    // it begins well after first paint and can be stopped from the UI.
    setTimeout(() => {
      void startUniverseHydration().catch((error) => {
        console.warn('[discovery] hydration could not start:', error);
      });
      try {
        pruneDiscoveryHistory();
      } catch (error) {
        console.warn('[discovery] history prune skipped:', error);
      }
    }, 15_000);

    // Cache pruning runs once after ready and at most once per 24 hours after
    // that, always on the main thread. Deferred past window creation so a large
    // sweep cannot delay first paint, and fully guarded: a corrupt cache
    // directory must never keep the app from starting.
    setTimeout(() => {
      try {
        pruneMarketCacheIfDue();
      } catch (error) {
        console.warn('[market-cache] prune skipped:', error);
      }
    }, 5_000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
