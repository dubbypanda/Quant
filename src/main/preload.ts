// Preload: exposes the QuantApi bridge on window.quant via contextBridge.
// Every method maps 1:1 to an ipcMain.handle registration in main.ts.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type {
  ForecastApi,
  ForecastProgressEvent,
} from '../shared/forecast';
import type {
  AddWatchlistResult,
  ChartData,
  ChartRange,
  ChartEventQuery,
  ChartEventRecord,
  ChartRequest,
  HistoricalSignalSnapshot,
  DiscoveryRunResponse,
  MarketCacheStats,
  PortfolioWriteResult,
  EarningsEvent,
  HoldingsResult,
  LlmSettings,
  LlmSettingsInput,
  LlmConnectionResult,
  MacroOverlayKey,
  MacroOverlaySeries,
  NewsItem,
  PivotNewsResult,
  PivotPoint,
  QuantApi,
  QuantInsightRecord,
  QuantInsightRequest,
  QuantInsightResponse,
  QuantJournalEntry,
  QuantJournalEntryInput,
  Quote,
  SignalScanRequest,
  SignalScanResult,
  SymbolSuggestion,
  ValuationSnapshot,
  WatchlistItem,
} from '../shared/types';
import type {
  PortfolioAccountType,
  PortfolioActionContext,
  PortfolioDocumentV3,
  PortfolioSnapshot,
  SymbolPortfolioContext,
} from '../shared/portfolio';
import type { PortfolioRiskReport } from '../shared/portfolioRisk';
import type { PortfolioExposureReport } from '../shared/portfolioExposure';
import type { PortfolioCsvPreview } from './services/portfolioImport';
import type {
  DiscoveryEligibilitySettings,
  DiscoveryRunResult,
  UniverseHydrationStatus,
} from '../shared/discovery';

type ForecastEventChannel =
  | typeof IPC.forecastProgress
  | typeof IPC.forecastCompleted
  | typeof IPC.forecastFailed;

function subscribeToForecast(
  channel: ForecastEventChannel,
  callback: (event: ForecastProgressEvent) => void,
): () => void {
  const listener = (_event: IpcRendererEvent, payload: ForecastProgressEvent) => {
    callback(payload);
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const forecast: ForecastApi = {
  run: (request) => ipcRenderer.invoke(IPC.forecastRun, request),
  cancel: (jobId) => ipcRenderer.invoke(IPC.forecastCancel, jobId),
  getJob: (symbol) => ipcRenderer.invoke(IPC.forecastGetJob, symbol),
  listSaved: (symbol) => ipcRenderer.invoke(IPC.forecastListSaved, symbol),
  getSaved: (forecastId) => ipcRenderer.invoke(IPC.forecastGetSaved, forecastId),
  getHistoricalComparison: (forecastId) =>
    ipcRenderer.invoke(IPC.forecastGetHistoricalComparison, forecastId),
  setOverlayEnabled: (symbol, enabled) =>
    ipcRenderer.invoke(IPC.forecastSetOverlayEnabled, symbol, enabled),
  getOverlayEnabled: (symbol) =>
    ipcRenderer.invoke(IPC.forecastGetOverlayEnabled, symbol),
  onProgress: (callback) => subscribeToForecast(IPC.forecastProgress, callback),
  onCompleted: (callback) => subscribeToForecast(IPC.forecastCompleted, callback),
  onFailed: (callback) => subscribeToForecast(IPC.forecastFailed, callback),
};

const api: QuantApi = {
  forecast,
  getWatchlist: (): Promise<WatchlistItem[]> => ipcRenderer.invoke(IPC.watchlistGet),
  addToWatchlist: (symbol: string): Promise<AddWatchlistResult> =>
    ipcRenderer.invoke(IPC.watchlistAdd, symbol),
  removeFromWatchlist: (symbol: string): Promise<WatchlistItem[]> =>
    ipcRenderer.invoke(IPC.watchlistRemove, symbol),
  reorderWatchlist: (symbols: string[]): Promise<WatchlistItem[]> =>
    ipcRenderer.invoke(IPC.watchlistReorder, symbols),
  searchSymbols: (query: string): Promise<SymbolSuggestion[]> =>
    ipcRenderer.invoke(IPC.symbolsSearch, query),
  getQuotes: (symbols: string[]): Promise<Quote[]> =>
    ipcRenderer.invoke(IPC.quotesGet, symbols),
  getHoldings: (etfSymbol: string): Promise<HoldingsResult> =>
    ipcRenderer.invoke(IPC.holdingsGet, etfSymbol),
  getNews: (symbols: string[], limitPerSymbol?: number): Promise<NewsItem[]> =>
    ipcRenderer.invoke(IPC.newsGet, symbols, limitPerSymbol),
  getEarnings: (symbols: string[]): Promise<EarningsEvent[]> =>
    ipcRenderer.invoke(IPC.earningsGet, symbols),
  getChart: (symbol: string, range: ChartRange): Promise<ChartData> =>
    ipcRenderer.invoke(IPC.chartGet, symbol, range),
  getChartV3: (request: ChartRequest): Promise<ChartData> =>
    ipcRenderer.invoke(IPC.chartGetV3, request),
  getChartEvents: (query: ChartEventQuery): Promise<ChartEventRecord[]> =>
    ipcRenderer.invoke(IPC.chartEventsGet, query),
  getPortfolio: (): Promise<PortfolioDocumentV3> => ipcRenderer.invoke(IPC.portfolioGet),
  getPortfolioSnapshot: (): Promise<PortfolioSnapshot> =>
    ipcRenderer.invoke(IPC.portfolioSnapshotGet),
  getPortfolioRisk: (): Promise<PortfolioRiskReport> => ipcRenderer.invoke(IPC.portfolioRiskGet),
  getPortfolioExposure: (): Promise<PortfolioExposureReport> =>
    ipcRenderer.invoke(IPC.portfolioExposureGet),
  getSymbolPortfolioContext: (
    symbol: string,
  ): Promise<{ context: SymbolPortfolioContext; action: PortfolioActionContext }> =>
    ipcRenderer.invoke(IPC.portfolioSymbolContextGet, symbol),
  addPortfolioAccount: (input: {
    name: string;
    type: PortfolioAccountType;
  }): Promise<PortfolioWriteResult> => ipcRenderer.invoke(IPC.portfolioAccountAdd, input),
  addPortfolioLot: (input: {
    symbol: string;
    quantity: number;
    costPerShare: number;
    accountId: string;
    acquiredAt?: string | null;
    note?: string;
  }): Promise<PortfolioWriteResult> => ipcRenderer.invoke(IPC.portfolioLotAdd, input),
  updatePortfolioLot: (
    id: string,
    patch: Partial<{
      quantity: number;
      costPerShare: number;
      acquiredAt: string | null;
      accountId: string;
      note: string;
    }>,
  ): Promise<PortfolioWriteResult> => ipcRenderer.invoke(IPC.portfolioLotUpdate, id, patch),
  removePortfolioLot: (id: string): Promise<PortfolioWriteResult> =>
    ipcRenderer.invoke(IPC.portfolioLotRemove, id),
  setPortfolioCash: (accountId: string, amount: number): Promise<PortfolioWriteResult> =>
    ipcRenderer.invoke(IPC.portfolioCashSet, accountId, amount),
  previewPortfolioCsv: (text: string): Promise<PortfolioCsvPreview> =>
    ipcRenderer.invoke(IPC.portfolioCsvPreview, text),
  importPortfolioCsv: (text: string, accountId: string): Promise<PortfolioWriteResult> =>
    ipcRenderer.invoke(IPC.portfolioCsvImport, text, accountId),
  getDiscoveryHydrationStatus: (): Promise<UniverseHydrationStatus> =>
    ipcRenderer.invoke(IPC.discoveryHydrationStatus),
  startDiscoveryHydration: (): Promise<UniverseHydrationStatus> =>
    ipcRenderer.invoke(IPC.discoveryHydrationStart),
  stopDiscoveryHydration: (): Promise<UniverseHydrationStatus> =>
    ipcRenderer.invoke(IPC.discoveryHydrationStop),
  runDiscovery: (
    settings?: Partial<DiscoveryEligibilitySettings>,
  ): Promise<DiscoveryRunResponse> => ipcRenderer.invoke(IPC.discoveryRun, settings),
  getLatestDiscovery: (): Promise<DiscoveryRunResult | null> =>
    ipcRenderer.invoke(IPC.discoveryLatest),
  getSignalHistory: (
    symbol: string,
    from?: number,
    to?: number,
  ): Promise<HistoricalSignalSnapshot[]> =>
    ipcRenderer.invoke(IPC.signalHistoryGet, symbol, from, to),
  prefetchChartV3: (symbol: string, range: ChartRange): Promise<void> =>
    ipcRenderer.invoke(IPC.chartPrefetchV3, symbol, range),
  getMarketCacheStats: (): Promise<MarketCacheStats> =>
    ipcRenderer.invoke(IPC.marketCacheStats),
  pruneMarketCache: (maxBytes?: number): Promise<MarketCacheStats> =>
    ipcRenderer.invoke(IPC.marketCachePrune, maxBytes),
  getPivotNews: (symbol: string, pivots: PivotPoint[]): Promise<PivotNewsResult[]> =>
    ipcRenderer.invoke(IPC.pivotNewsGet, symbol, pivots),
  getMacroOverlay: (key: MacroOverlayKey, range: ChartRange): Promise<MacroOverlaySeries> =>
    ipcRenderer.invoke(IPC.macroOverlayGet, key, range),
  captureChartSnapshot: (symbol: string): Promise<{ dataUrl: string; capturedAt: string } | null> =>
    ipcRenderer.invoke(IPC.chartSnapshotCapture, symbol),
  analyzeQuant: (request: QuantInsightRequest): Promise<QuantInsightResponse> =>
    ipcRenderer.invoke(IPC.quantAnalyze, request),
  getQuantInsights: (symbol: string, range?: ChartRange): Promise<QuantInsightRecord[]> =>
    ipcRenderer.invoke(IPC.quantInsightsGet, symbol, range),
  getQuantJournal: (symbol: string): Promise<QuantJournalEntry[]> =>
    ipcRenderer.invoke(IPC.quantJournalGet, symbol),
  saveQuantJournal: (entry: QuantJournalEntryInput): Promise<QuantJournalEntry> =>
    ipcRenderer.invoke(IPC.quantJournalSave, entry),
  getLlmSettings: (): Promise<LlmSettings> =>
    ipcRenderer.invoke(IPC.llmSettingsGet),
  saveLlmSettings: (settings: LlmSettingsInput): Promise<LlmSettings> =>
    ipcRenderer.invoke(IPC.llmSettingsSave, settings),
  testLlmConnection: (settings: LlmSettingsInput): Promise<LlmConnectionResult> =>
    ipcRenderer.invoke(IPC.llmConnectionTest, settings),
  getValuation: (symbol: string): Promise<ValuationSnapshot> =>
    ipcRenderer.invoke(IPC.valuationGet, symbol),
  scanSignals: (request?: SignalScanRequest): Promise<SignalScanResult> =>
    ipcRenderer.invoke(IPC.signalsScan, request),
  getSignalDesk: (symbol: string): Promise<import('../shared/signalV2').SignalDeskResult> =>
    ipcRenderer.invoke(IPC.signalDeskGet, symbol),
  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.openExternal, url),
};

contextBridge.exposeInMainWorld('quant', api);
