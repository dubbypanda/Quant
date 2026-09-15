// The two-stage discovery scan.
//
// Stage A is cheap and wide: features from cached candles for the whole
// eligible universe, with no Signal Engine replay. Stage B is expensive and
// narrow: the deterministic signal core on the preliminary shortlist, and the
// setup-specific historical replay on only the top slice of that.
//
// That split is the point. Running the replay across the universe would take
// minutes; running it on 50 symbols takes seconds and is where it actually
// changes a ranking. Kronos and QRM are deliberately NOT run here at any stage
// — Plan 05 may run them on a final shortlist or on explicit request.

import crypto from 'node:crypto';
import type { Candle } from '../../shared/types';
import type {
  DiscoveryCandidate,
  DiscoveryEligibilitySettings,
  DiscoveryRunResult,
  DiscoveryUniverseMember,
  UniverseCoverage,
} from '../../shared/discovery';
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  DISCOVERY_FUNNEL,
  attentionScore,
  evaluateDiscoveryEligibility,
} from '../../shared/discovery';
import { computeDiscoveryFeatures } from '../../shared/discoveryFeatures';
import {
  assignRelativeStrengthPercentiles,
  buildAttentionComponents,
  isCurrentSession,
  type RankingRow,
} from '../../shared/discoveryRanking';
import { calculateNovelty, toSnapshotEntry, type DiscoverySnapshot } from '../../shared/discoveryNovelty';
import { evaluateSignalCore, DEFAULT_RISK_SETTINGS } from '../../shared/quant';
import { findPivots } from '../../shared/priceStructure';
import { validateHistoricalStrategy } from '../../shared/signalValidation';
import { getDailyHistory } from './dailyHistory';
import { getSymbolDirectory } from './dataFiles';
import { hydratedSymbols, hydrationFailureCount } from './universeHydrator';
import { getLatestDiscoverySnapshot, saveDiscoverySnapshot } from './discoveryHistoryStore';
import { pLimit } from './util';

const BENCHMARK_SYMBOL = 'SPY';
const HISTORY_CONCURRENCY = 6;

/** Sector ETF proxies for residual computation, where metadata exists. */
const SECTOR_PROXIES: Record<string, string> = {
  Technology: 'XLK',
  'Information Technology': 'XLK',
  Healthcare: 'XLV',
  'Health Care': 'XLV',
  Financials: 'XLF',
  'Financial Services': 'XLF',
  Energy: 'XLE',
  Industrials: 'XLI',
  'Consumer Discretionary': 'XLY',
  'Consumer Staples': 'XLP',
  Utilities: 'XLU',
  'Real Estate': 'XLRE',
  Materials: 'XLB',
  'Communication Services': 'XLC',
};

export interface DiscoveryRunOptions {
  settings?: DiscoveryEligibilitySettings;
  /** Ceiling on symbols scanned in Stage A. Present so a test can bound the
   *  run, not to quietly narrow the universe in production. */
  maxSymbols?: number;
  preliminaryCeiling?: number;
  deepCeiling?: number;
  /** Injected in tests so no run depends on the network. */
  historyLoader?: (symbol: string) => Promise<{ candles: Candle[]; source: 'live' | 'sample' }>;
  universeLoader?: () => DiscoveryUniverseMember[];
  hydratedLoader?: () => string[];
  snapshotLoader?: () => DiscoverySnapshot | null;
  snapshotWriter?: (snapshot: DiscoverySnapshot) => void;
  now?: number;
}

interface ActiveRun {
  id: string;
  startedAt: string;
  promise: Promise<DiscoveryRunResult>;
}

let activeRun: ActiveRun | null = null;
let lastResult: DiscoveryRunResult | null = null;

export function getLatestDiscoveryRun(): DiscoveryRunResult | null {
  return lastResult;
}

export function getActiveDiscoveryRun(): { id: string; startedAt: string } | null {
  return activeRun ? { id: activeRun.id, startedAt: activeRun.startedAt } : null;
}

/** Universe from the bundled directory plus metadata. */
function defaultUniverse(): DiscoveryUniverseMember[] {
  return getSymbolDirectory()
    .filter(
      (entry) =>
        entry.exchange === 'NASDAQ' || entry.exchange === 'NYSE' || entry.exchange === 'NYSEArca',
    )
    .map((entry) => {
      const extra = entry as typeof entry & {
        sector?: string | null;
        industry?: string | null;
        leveraged?: boolean;
        inverse?: boolean;
        singleStockEtf?: boolean;
      };
      return {
        symbol: entry.symbol.toUpperCase(),
        name: entry.name,
        assetType: entry.type === 'etf' ? 'etf' : 'stock',
        exchange: entry.exchange ?? 'US',
        active: true,
        sector: extra.sector ?? undefined,
        industry: extra.industry ?? undefined,
        // Absent metadata means "not known to be leveraged", never inferred
        // from the ticker string.
        leveraged: extra.leveraged === true,
        inverse: extra.inverse === true,
        singleStockEtf: extra.singleStockEtf === true,
      } satisfies DiscoveryUniverseMember;
    });
}

function medianOf(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function runDiscovery(
  options: DiscoveryRunOptions = {},
): Promise<DiscoveryRunResult> {
  // A second request while a run is active returns the in-flight promise rather
  // than launching duplicate computation over the whole universe.
  if (activeRun) return activeRun.promise;

  const id = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const promise = executeDiscovery(id, startedAt, options).finally(() => {
    activeRun = null;
  });
  activeRun = { id, startedAt, promise };
  return promise;
}

async function executeDiscovery(
  id: string,
  startedAt: string,
  options: DiscoveryRunOptions,
): Promise<DiscoveryRunResult> {
  const settings = options.settings ?? DEFAULT_ELIGIBILITY_SETTINGS;
  const now = options.now ?? Date.now();
  const preliminaryCeiling = options.preliminaryCeiling ?? DISCOVERY_FUNNEL.preliminaryCeiling;
  const deepCeiling = options.deepCeiling ?? DISCOVERY_FUNNEL.deepCeiling;

  const loadHistory =
    options.historyLoader ??
    (async (symbol: string) => {
      const result = await getDailyHistory(symbol);
      return { candles: result.candles, source: result.source === 'live' ? 'live' : 'sample' };
    });

  const universe = (options.universeLoader ?? defaultUniverse)();
  const hydrated = new Set((options.hydratedLoader ?? hydratedSymbols)());
  const bySymbol = new Map(universe.map((member) => [member.symbol, member]));

  // Scan hydrated symbols only: an unhydrated symbol has no local history, and
  // fetching the whole universe on demand is what made 2.x cap at 120 rows.
  let scanSymbols = universe
    .filter((member) => hydrated.has(member.symbol))
    .map((member) => member.symbol);
  if (options.maxSymbols !== undefined) scanSymbols = scanSymbols.slice(0, options.maxSymbols);

  const benchmark = await loadHistory(BENCHMARK_SYMBOL)
    .then((result) => result.candles)
    .catch(() => [] as Candle[]);

  // Sector proxies are loaded once and shared, not per symbol.
  const sectorSymbols = [
    ...new Set(
      scanSymbols
        .map((symbol) => bySymbol.get(symbol)?.sector)
        .filter((sector): sector is string => Boolean(sector))
        .map((sector) => SECTOR_PROXIES[sector])
        .filter((proxy): proxy is string => Boolean(proxy)),
    ),
  ];
  const sectorHistories = new Map<string, Candle[]>();
  await Promise.all(
    sectorSymbols.map(async (proxy) => {
      try {
        sectorHistories.set(proxy, (await loadHistory(proxy)).candles);
      } catch {
        /* a missing sector proxy only costs the sector residual */
      }
    }),
  );

  const priorSnapshot = (options.snapshotLoader ?? getLatestDiscoverySnapshot)();

  // ---- Stage A -------------------------------------------------------
  const limit = pLimit(HISTORY_CONCURRENCY);
  interface StageARow {
    symbol: string;
    member: DiscoveryUniverseMember;
    row: RankingRow;
    lowLiquidity: boolean;
    historyBars: number;
    candles: Candle[];
    warnings: string[];
  }

  const stageAResults = await Promise.all(
    scanSymbols.map((symbol) =>
      limit(async (): Promise<StageARow | null> => {
        const member = bySymbol.get(symbol);
        if (!member) return null;
        let candles: Candle[];
        let source: 'live' | 'sample';
        try {
          const loaded = await loadHistory(symbol);
          candles = loaded.candles;
          source = loaded.source;
        } catch {
          return null;
        }
        // Sample history can never be ranked as if it were the market.
        if (source !== 'live' || candles.length === 0) return null;

        const lastCandle = candles[candles.length - 1];
        const dollarVolumes = candles
          .slice(-20)
          .map((candle) => candle.close * (Number.isFinite(candle.volume) ? candle.volume : 0));

        const eligibility = evaluateDiscoveryEligibility({
          member,
          lastClose: lastCandle?.close ?? null,
          medianDollarVolume20: medianOf(dollarVolumes),
          historyBars: candles.length,
          settings,
        });
        if (!eligibility.eligible) return null;

        const priorRegime = priorSnapshot?.entries[symbol]?.regime ?? null;
        const features = computeDiscoveryFeatures({
          symbol,
          candles,
          benchmark,
          sector: member.sector ? sectorHistories.get(SECTOR_PROXIES[member.sector] ?? '') : undefined,
          priorRegime,
        });
        if (!features) return null;

        const dataAgeSeconds = Math.max(0, Math.floor(now / 1000) - features.asOf);
        const warnings: string[] = [];
        if (eligibility.lowLiquidity) {
          warnings.push('Median dollar volume is below the default liquidity threshold.');
        }
        if (dataAgeSeconds > 36 * 60 * 60) {
          warnings.push('Data is not from the current session.');
        }

        return {
          symbol,
          member,
          row: { symbol, features, dataAgeSeconds },
          lowLiquidity: eligibility.lowLiquidity,
          historyBars: candles.length,
          candles,
          warnings,
        };
      }),
    ),
  );

  const stageA = stageAResults.filter((item): item is StageARow => item !== null);

  // Cross-sectional percentiles over the current-session rows only.
  const rankedRows = assignRelativeStrengthPercentiles(stageA.map((item) => item.row));
  const rowBySymbol = new Map(rankedRows.map((row) => [row.symbol, row]));

  const preliminary = stageA
    .map((item) => {
      const row = rowBySymbol.get(item.symbol) ?? item.row;
      const components = buildAttentionComponents({
        features: row.features,
        dataAgeSeconds: row.dataAgeSeconds,
        lowLiquidity: item.lowLiquidity,
        historyBars: item.historyBars,
        minimumHistoryBars: settings.minimumHistoryBars,
      });
      return { ...item, row, components, preliminaryScore: attentionScore(components) };
    })
    .sort((a, b) => b.preliminaryScore - a.preliminaryScore)
    .slice(0, preliminaryCeiling);

  // ---- Stage B -------------------------------------------------------
  const deepInputs = preliminary.slice(0, Math.max(deepCeiling, 0) * 3);
  const withSignal = deepInputs.map((item) => {
    // Deterministic signal core only; no historical replay at this width.
    const recent = item.candles.slice(-252);
    const pivots = findPivots(recent);
    const evaluation = evaluateSignalCore(item.symbol, recent, pivots, DEFAULT_RISK_SETTINGS, {
      timeframe: '1d',
    });
    const components = buildAttentionComponents({
      features: item.row.features,
      dataAgeSeconds: item.row.dataAgeSeconds,
      lowLiquidity: item.lowLiquidity,
      historyBars: item.historyBars,
      minimumHistoryBars: settings.minimumHistoryBars,
      decision: evaluation.decision,
    });
    return { ...item, evaluation, components, revisedScore: attentionScore(components) };
  });

  const deep = [...withSignal]
    .sort((a, b) => b.revisedScore - a.revisedScore)
    .slice(0, deepCeiling);
  const deepSymbols = new Set(deep.map((item) => item.symbol));

  // The expensive replay runs only on the deep slice.
  const historicalBySymbol = new Map<string, ReturnType<typeof validateHistoricalStrategy>>();
  for (const item of deep) {
    if (item.evaluation.direction !== 'long' && item.evaluation.direction !== 'short') continue;
    try {
      historicalBySymbol.set(
        item.symbol,
        validateHistoricalStrategy({
          symbol: item.symbol,
          candles: item.candles,
          targetSetup: item.evaluation.setupType,
          targetDirection: item.evaluation.direction,
          currentRegime: item.evaluation.regime,
          riskSettings: DEFAULT_RISK_SETTINGS,
        }),
      );
    } catch {
      /* a failed replay leaves model evidence at its pre-replay value */
    }
  }

  // ---- Assemble ------------------------------------------------------
  const ranksBeforeNovelty = [...withSignal]
    .sort((a, b) => b.revisedScore - a.revisedScore)
    .map((item, index) => [item.symbol, index + 1] as const);
  const rankBySymbol = new Map(ranksBeforeNovelty);

  const candidates: DiscoveryCandidate[] = withSignal.map((item) => {
    const historical = historicalBySymbol.get(item.symbol) ?? undefined;
    const novelty = calculateNovelty({
      features: item.row.features,
      decision: item.evaluation.decision,
      attentionRank: rankBySymbol.get(item.symbol) ?? null,
      prior: priorSnapshot?.entries[item.symbol] ?? null,
      firstScan: priorSnapshot === null,
    });
    const components = buildAttentionComponents({
      features: item.row.features,
      dataAgeSeconds: item.row.dataAgeSeconds,
      lowLiquidity: item.lowLiquidity,
      historyBars: item.historyBars,
      minimumHistoryBars: settings.minimumHistoryBars,
      decision: item.evaluation.decision,
      historical: deepSymbols.has(item.symbol) ? historical : null,
      novelty,
    });

    return {
      symbol: item.symbol,
      name: item.member.name,
      assetType: item.member.assetType,
      asOf: new Date(item.row.features.asOf * 1000).toISOString(),
      attentionScore: attentionScore(components),
      components,
      features: item.row.features,
      decision: item.evaluation.decision,
      setupType: item.evaluation.setupType,
      setupQuality: item.evaluation.setupQuality,
      historicalEvidence: historical,
      novelty,
      dataAgeSeconds: item.row.dataAgeSeconds,
      warnings: item.warnings,
    };
  });

  candidates.sort((a, b) => b.attentionScore - a.attentionScore || a.symbol.localeCompare(b.symbol));

  const coverage: UniverseCoverage = {
    universeCount: universe.length,
    hydratedCount: hydrated.size,
    eligibleCount: stageA.length,
    scannedCount: scanSymbols.length,
    currentSessionCount: rankedRows.filter(isCurrentSession).length,
    staleCount: rankedRows.filter((row) => !isCurrentSession(row)).length,
    failedCount: (() => {
      try {
        return hydrationFailureCount();
      } catch {
        return 0;
      }
    })(),
    asOf: new Date(now).toISOString(),
  };

  const completedAt = new Date().toISOString();
  const result: DiscoveryRunResult = {
    id,
    startedAt,
    completedAt,
    coverage,
    settings,
    preliminaryCount: preliminary.length,
    deepCount: deep.length,
    candidates,
  };

  // Persist the snapshot for the next run's novelty comparison.
  const entries: Record<string, ReturnType<typeof toSnapshotEntry>> = {};
  candidates.forEach((candidate, index) => {
    entries[candidate.symbol] = toSnapshotEntry({
      features: candidate.features,
      decision: candidate.decision,
      attentionRank: index + 1,
    });
  });
  (options.snapshotWriter ?? saveDiscoverySnapshot)({ id, completedAt, entries });

  lastResult = result;
  return result;
}

/** Test seam. */
export function resetDiscoveryStateForTests(): void {
  activeRun = null;
  lastResult = null;
}
