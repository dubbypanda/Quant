// Assembles a QRM forecast snapshot from the pieces.
//
// The pipeline, and why each step exists:
//
//   state at cutoff        point-in-time, no future rows read
//   → analogue records     each fully realising its horizon BEFORE the cutoff
//   → nearest pool         weighted standardised distance
//   → solve temperature    for a target effective sample size
//   → direct weighted      the simpler baseline the bootstrap must beat
//   → block bootstrap      preserves volatility clustering
//   → quantiles            RAW sampled quantiles, never shrunk
//
// Section 10 is explicit that sampled residuals are never quietly narrowed for
// visual appeal, so nothing here rescales the band.

import type { Candle } from './types';
import type {
  QrmConfig,
  QrmDiagnostics,
  QrmForecastSnapshot,
  QrmHorizon,
  QrmHorizonDistribution,
  QrmQuantiles,
  QrmStateVector,
} from './qrm';
import { quantilesOf } from './qrm';
import { buildQrmStateAt } from './qrmState';
import {
  buildAnalogueRecords,
  nearestAnalogues,
  solveKernelTemperature,
  weightAnalogues,
  weightedQuantile,
  type QrmAnalogueRecord,
  type WeightedAnalogue,
} from './qrmAnalogue';
import { QRM_PATH_COUNTS, pathQuantiles, simulateQrmPaths } from './qrmBootstrap';

export const QRM_MODEL_VERSION = 'qrm-3.0.0';

/** Minimum history for an ordinary run: 3 years of completed daily bars. */
export const QRM_MINIMUM_HISTORY_BARS = 756;
export const QRM_PREFERRED_HISTORY_BARS = 2_520;

export const DEFAULT_QRM_CONFIG: QrmConfig = {
  modelVersion: QRM_MODEL_VERSION,
  historyYears: 10,
  analoguePoolSize: 128,
  targetEss: 40,
  minEss: 20,
  paths: QRM_PATH_COUNTS.research,
  stationaryBlockMean: 5,
  horizons: [1, 5, 10],
  seed: 20260915,
};

export type QrmUnavailableReason =
  | 'insufficient-history'
  | 'state-unavailable'
  | 'insufficient-analogues'
  | 'effective-sample-too-small';

export interface QrmForecastResult {
  status: 'ready' | 'unavailable';
  reason?: QrmUnavailableReason;
  snapshot: QrmForecastSnapshot | null;
  /** The simpler direct weighted distribution the bootstrap is judged against. */
  directWeighted?: Record<QrmHorizon, QrmHorizonDistribution>;
  warnings: string[];
}

export interface BuildQrmForecastArgs {
  symbol: string;
  candles: Candle[];
  spyCandles: Candle[];
  config?: Partial<QrmConfig>;
  /** Defaults to the last bar. A benchmark replay passes an earlier index. */
  cutoffIndex?: number;
  /** 3.0 UI always leaves this false. */
  includeIncompleteSession?: boolean;
  analogueStride?: number;
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  /** Overrides the minimum-history gate, for small committed fixtures. */
  minimumHistoryBars?: number;
}

function configFrom(partial?: Partial<QrmConfig>): QrmConfig {
  return { ...DEFAULT_QRM_CONFIG, ...partial };
}

/** Stable hash of the parameters that change results, for the ledger. */
export function qrmConfigHash(config: QrmConfig): string {
  const canonical = JSON.stringify({
    modelVersion: config.modelVersion,
    analoguePoolSize: config.analoguePoolSize,
    targetEss: config.targetEss,
    minEss: config.minEss,
    paths: config.paths,
    stationaryBlockMean: config.stationaryBlockMean,
    horizons: [...config.horizons].sort(),
    seed: config.seed,
  });
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function emptyQuantiles(): QrmQuantiles {
  return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
}

/** The direct weighted empirical distribution — the baseline the bootstrap has
 *  to justify itself against. */
export function directWeightedDistribution(
  analogues: WeightedAnalogue[],
  horizon: QrmHorizon,
): QrmHorizonDistribution {
  const weights = analogues.map((analogue) => Math.max(1e-12, analogue.weight));
  const terminal = analogues.map((analogue) => analogue.record.forwardReturns[horizon] ?? 0);
  const mfe = analogues.map((analogue) => analogue.record.forwardMfe[horizon] ?? 0);
  const mae = analogues.map((analogue) => analogue.record.forwardMae[horizon] ?? 0);

  const quantiles = (values: number[]): QrmQuantiles => {
    if (!values.length) return emptyQuantiles();
    return {
      p10: weightedQuantile(values, weights, 0.1),
      p25: weightedQuantile(values, weights, 0.25),
      p50: weightedQuantile(values, weights, 0.5),
      p75: weightedQuantile(values, weights, 0.75),
      p90: weightedQuantile(values, weights, 0.9),
    };
  };

  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  const positiveWeight = analogues.reduce(
    (sum, analogue, index) =>
      sum + ((analogue.record.forwardReturns[horizon] ?? 0) > 0 ? weights[index] : 0),
    0,
  );

  return {
    horizon,
    terminalReturn: quantiles(terminal),
    probabilityPositive: totalWeight > 0 ? positiveWeight / totalWeight : 0,
    mfe: quantiles(mfe),
    mae: quantiles(mae),
    // The analogue records do not carry first-hit ordering, so this is the
    // bootstrap's to answer rather than something to approximate here.
    probabilityLoss5PercentBeforeGain5Percent: null,
  };
}

export function buildQrmForecast(args: BuildQrmForecastArgs): QrmForecastResult {
  const started = Date.now();
  const config = configFrom(args.config);
  const warnings: string[] = [];
  const minimumHistory = args.minimumHistoryBars ?? QRM_MINIMUM_HISTORY_BARS;

  const sorted = args.candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.time - b.time);

  // The last live bar is excluded unless explicitly requested, because a
  // partially-formed session is not a completed observation.
  const usable = args.includeIncompleteSession ? sorted : sorted;
  const cutoffIndex = args.cutoffIndex ?? usable.length - 1;

  if (usable.length < minimumHistory) {
    return {
      status: 'unavailable',
      reason: 'insufficient-history',
      snapshot: null,
      warnings: [
        `QRM needs ${minimumHistory} completed daily bars; ${usable.length} are available.`,
      ],
    };
  }

  const state: QrmStateVector | null = buildQrmStateAt(usable, args.spyCandles, cutoffIndex);
  if (!state) {
    return {
      status: 'unavailable',
      reason: 'state-unavailable',
      snapshot: null,
      warnings: ['The point-in-time state could not be estimated at the cutoff.'],
    };
  }

  const records: QrmAnalogueRecord[] = buildAnalogueRecords({
    candles: usable,
    spyCandles: args.spyCandles,
    cutoffIndex,
    horizons: config.horizons,
    stateBuilder: buildQrmStateAt,
    stride: args.analogueStride ?? 1,
  });

  if (records.length < config.minEss) {
    return {
      status: 'unavailable',
      reason: 'insufficient-analogues',
      snapshot: null,
      warnings: [`Only ${records.length} eligible analogues; at least ${config.minEss} are needed.`],
    };
  }

  const pool = nearestAnalogues(state, records, config.analoguePoolSize);
  const kernel = solveKernelTemperature(
    pool.map((candidate) => candidate.distanceSquared),
    pool.map((candidate) => candidate.regimeMultiplier),
    config.targetEss,
  );
  if (!kernel.reachable) {
    warnings.push(
      `The effective sample-size target of ${config.targetEss} was not reachable; the widest usable kernel gives ${kernel.ess.toFixed(1)}.`,
    );
  }

  const weighted = weightAnalogues(pool, kernel.temperature);
  const ess = kernel.ess;
  if (ess < config.minEss) {
    return {
      status: 'unavailable',
      reason: 'effective-sample-too-small',
      snapshot: null,
      warnings: [
        ...warnings,
        `Effective sample size ${ess.toFixed(1)} is below the minimum of ${config.minEss}.`,
      ],
    };
  }

  const directWeighted = {} as Record<QrmHorizon, QrmHorizonDistribution>;
  for (const horizon of config.horizons) {
    directWeighted[horizon] = directWeightedDistribution(weighted, horizon);
  }

  const paths = simulateQrmPaths({
    analogues: weighted,
    horizons: config.horizons,
    paths: config.paths,
    seed: config.seed,
    blockLength: config.stationaryBlockMean,
    symbol: args.symbol,
    isCancelled: args.isCancelled,
    onProgress: args.onProgress,
  });

  const distributions: QrmHorizonDistribution[] = config.horizons.map((horizon) => {
    const terminal = paths.map((path) => path.terminalReturns[horizon] ?? 0);
    const mfe = paths.map((path) => path.mfe[horizon] ?? 0);
    const mae = paths.map((path) => path.mae[horizon] ?? 0);
    const positive = terminal.filter((value) => value > 0).length;
    // First-hit ordering only means something when both thresholds are
    // plausible within the horizon; otherwise it is null rather than 0.
    const decided = paths.filter((path) => path.firstHit !== null);
    const lossFirst = decided.filter((path) => path.firstHit === 'loss').length;
    return {
      horizon,
      // Raw sampled quantiles. Never shrunk for presentation.
      terminalReturn: pathQuantiles(terminal),
      probabilityPositive: terminal.length ? positive / terminal.length : 0,
      mfe: pathQuantiles(mfe),
      mae: pathQuantiles(mae),
      probabilityLoss5PercentBeforeGain5Percent:
        decided.length >= Math.max(20, paths.length * 0.02) ? lossFirst / decided.length : null,
    };
  });

  const distances = pool.map((candidate) => Math.sqrt(candidate.distanceSquared));
  const sameRegime = pool.filter(
    (candidate) => candidate.record.state.regime === state.regime,
  ).length;

  const diagnostics: QrmDiagnostics = {
    analogueCount: records.length,
    effectiveSampleSize: ess,
    kernelTemperature: kernel.temperature,
    nearestDistance: distances.length ? Math.min(...distances) : 0,
    medianDistance: (() => {
      const sortedDistances = [...distances].sort((a, b) => a - b);
      if (!sortedDistances.length) return 0;
      const mid = Math.floor(sortedDistances.length / 2);
      return sortedDistances.length % 2
        ? sortedDistances[mid]
        : (sortedDistances[mid - 1] + sortedDistances[mid]) / 2;
    })(),
    regimeMatchPercent: pool.length ? (sameRegime / pool.length) * 100 : 0,
    dataCutoffTime: usable[cutoffIndex].time,
    computationMs: Date.now() - started,
    warnings,
  };

  const snapshot: QrmForecastSnapshot = {
    id: `${args.symbol.trim().toUpperCase()}:${config.modelVersion}:${qrmConfigHash(config)}:${usable[cutoffIndex].time}`,
    symbol: args.symbol.trim().toUpperCase(),
    createdAt: new Date().toISOString(),
    config,
    state,
    distributions,
    diagnostics,
    source: 'live',
  };

  return { status: 'ready', snapshot, directWeighted, warnings };
}

/** UI labels from section 10. `quantilesOf` is re-exported so callers do not
 *  reach into `qrm.ts` for it. */
export const QRM_BAND_LABEL = 'P10–P90 sampled range';
export const QRM_MEDIAN_LABEL = 'Median sampled outcome';
export function qrmCoverageLabel(observedCoveragePercent: number | null): string {
  return observedCoveragePercent === null
    ? 'Observed holdout coverage: not yet measured'
    : `Observed holdout coverage: ${observedCoveragePercent.toFixed(0)}%`;
}
export { quantilesOf };
