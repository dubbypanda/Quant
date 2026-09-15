// Walk-forward benchmark, baselines and promotion gates.
//
// The point of this module is falsification. A forecast model that is never
// scored against a trivial baseline will always look impressive, so every
// experiment reports CRPS and direction Brier alongside three deliberately
// simple competitors. Section 14 is blunt about it: a complicated QRM that
// cannot beat simple baselines has not earned its complexity.
//
// Forecast quality and decision quality are scored separately, because a model
// can be well calibrated and still make badly-located entries — which is
// exactly what the entry-location metric exists to catch.

import type { Candle } from './types';
import type { ConfidenceInterval } from './signalV2';
import type { QrmConfig, QrmHorizon, QrmHorizonDistribution } from './qrm';
import { buildQrmForecast, qrmConfigHash, type BuildQrmForecastArgs } from './qrmForecast';
import { decideQrm, measureEntryQuality, summarizeEntryQuality, type QrmDecisionThresholds } from './qrmDecision';
import { calculateBootstrapExpectancyCi, median } from './signalStatistics';

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

export interface BaselineSummary {
  name: 'zero-return' | 'historical-unconditional' | 'momentum-sign';
  crps: number | null;
  directionBrier: number | null;
}

export interface QrmBenchmarkResult {
  qrm: QrmBenchmarkSummary;
  baselines: BaselineSummary[];
  /** Development / holdout split, chronological. */
  split: { developmentOrigins: number; holdoutOrigins: number; developmentFraction: number };
}

/**
 * Continuous Ranked Probability Score from a quantile representation.
 *
 * CRPS is the integral of the squared difference between the forecast CDF and
 * the step function at the observation. With only five quantiles it is
 * approximated by the pinball loss averaged over them — which is a proper
 * scoring rule in its own right and converges to CRPS as quantiles are added.
 * Lower is better, and it is reported in return units.
 */
export function quantileCrps(
  distribution: QrmHorizonDistribution,
  observed: number,
): number | null {
  const levels: Array<[number, number]> = [
    [0.1, distribution.terminalReturn.p10],
    [0.25, distribution.terminalReturn.p25],
    [0.5, distribution.terminalReturn.p50],
    [0.75, distribution.terminalReturn.p75],
    [0.9, distribution.terminalReturn.p90],
  ];
  if (!Number.isFinite(observed)) return null;
  let total = 0;
  for (const [tau, forecast] of levels) {
    if (!Number.isFinite(forecast)) return null;
    const difference = observed - forecast;
    // Pinball loss: asymmetric, penalising the side the quantile is meant to
    // bound.
    total += difference >= 0 ? tau * difference : (tau - 1) * difference;
  }
  return (2 * total) / levels.length;
}

/** Brier score for the directional claim. Lower is better; 0.25 is a coin. */
export function directionBrier(probabilityPositive: number, observed: number): number | null {
  if (!Number.isFinite(probabilityPositive) || !Number.isFinite(observed)) return null;
  const outcome = observed > 0 ? 1 : 0;
  return (probabilityPositive - outcome) ** 2;
}

interface OriginRecord {
  symbol: string;
  cutoffIndex: number;
  observed: number;
  distribution: QrmHorizonDistribution;
  covered: boolean;
  bandWidth: number;
  runtimeMs: number;
  decision: ReturnType<typeof decideQrm>;
  entry: number;
  forwardMin: number;
  forwardMax: number;
  /** Trailing 20-day return at the origin, for the momentum baseline. */
  trailingReturn20: number | null;
  /** The symbol's unconditional forward distribution at this horizon. */
  unconditional: number[];
}

export interface BenchmarkInput {
  symbol: string;
  candles: Candle[];
  spyCandles: Candle[];
}

export interface RunBenchmarkArgs {
  inputs: BenchmarkInput[];
  horizon: QrmHorizon;
  config?: Partial<QrmConfig>;
  /** Bars between replay origins. */
  originStride?: number;
  /** Bars to leave before the first origin so history exists. */
  warmupBars?: number;
  thresholds?: QrmDecisionThresholds;
  developmentFraction?: number;
  minimumHistoryBars?: number;
  analogueStride?: number;
  maximumOriginsPerSymbol?: number;
}

function percentile(values: number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[index];
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Replays historical origins strictly point-in-time.
 *
 * At each origin the forecast is built with `cutoffIndex` set to that bar, so
 * the model sees exactly what it would have seen then. The realised outcome is
 * read only afterwards, for scoring.
 */
export function runQrmBenchmark(args: RunBenchmarkArgs): QrmBenchmarkResult {
  const horizon = args.horizon;
  const stride = Math.max(1, args.originStride ?? 5);
  const developmentFraction = args.developmentFraction ?? 0.7;
  const warnings: string[] = [];
  const origins: OriginRecord[] = [];

  for (const input of args.inputs) {
    const candles = input.candles
      .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
      .sort((a, b) => a.time - b.time);
    const warmup = args.warmupBars ?? (args.minimumHistoryBars ?? 756);
    let produced = 0;

    for (let cutoff = warmup; cutoff < candles.length - horizon; cutoff += stride) {
      if (
        args.maximumOriginsPerSymbol !== undefined &&
        produced >= args.maximumOriginsPerSymbol
      ) {
        break;
      }
      const started = Date.now();
      const forecastArgs: BuildQrmForecastArgs = {
        symbol: input.symbol,
        candles,
        spyCandles: input.spyCandles,
        config: args.config,
        cutoffIndex: cutoff,
        minimumHistoryBars: args.minimumHistoryBars,
        analogueStride: args.analogueStride,
      };
      const forecast = buildQrmForecast(forecastArgs);
      const runtimeMs = Date.now() - started;
      if (forecast.status !== 'ready' || !forecast.snapshot) continue;

      const distribution = forecast.snapshot.distributions.find(
        (item) => item.horizon === horizon,
      );
      if (!distribution) continue;

      // Realised outcome, read only now that the forecast is fixed.
      const entry = candles[cutoff].close;
      const exitIndex = cutoff + horizon;
      const observed = candles[exitIndex].close / entry - 1;
      let forwardMin = Infinity;
      let forwardMax = -Infinity;
      for (let i = cutoff + 1; i <= exitIndex; i++) {
        forwardMin = Math.min(forwardMin, candles[i].low);
        forwardMax = Math.max(forwardMax, candles[i].high);
      }

      const trailing = cutoff - 20 >= 0 ? candles[cutoff].close / candles[cutoff - 20].close - 1 : null;

      // The symbol's unconditional forward distribution, from bars strictly
      // before the origin.
      const unconditional: number[] = [];
      for (let i = 20; i + horizon <= cutoff; i += 5) {
        const from = candles[i].close;
        if (from > 0) unconditional.push(candles[i + horizon].close / from - 1);
      }

      origins.push({
        symbol: input.symbol,
        cutoffIndex: cutoff,
        observed,
        distribution,
        covered:
          observed >= distribution.terminalReturn.p10 && observed <= distribution.terminalReturn.p90,
        bandWidth: distribution.terminalReturn.p90 - distribution.terminalReturn.p10,
        runtimeMs,
        decision: decideQrm(distribution, args.thresholds),
        entry,
        forwardMin,
        forwardMax,
        trailingReturn20: trailing,
        unconditional,
      });
      produced += 1;
    }
  }

  if (!origins.length) {
    warnings.push('No forecast origins produced a usable forecast.');
  }

  const crpsValues = origins
    .map((origin) => quantileCrps(origin.distribution, origin.observed))
    .filter((value): value is number => value !== null);
  const brierValues = origins
    .map((origin) => directionBrier(origin.distribution.probabilityPositive, origin.observed))
    .filter((value): value is number => value !== null);

  const decisionOrigins = origins.filter(
    (origin) =>
      origin.decision.decision === 'long-candidate' ||
      origin.decision.decision === 'short-candidate',
  );
  const entryQualities = decisionOrigins.map((origin) =>
    measureEntryQuality({
      entry: origin.entry,
      forwardMin: origin.forwardMin,
      forwardMax: origin.forwardMax,
      direction: origin.decision.decision === 'long-candidate' ? 'long' : 'short',
    }),
  );
  const entrySummary = summarizeEntryQuality(entryQualities);

  const longOrigins = decisionOrigins.filter(
    (origin) => origin.decision.decision === 'long-candidate',
  );
  const longLocations = longOrigins
    .map((origin) =>
      measureEntryQuality({
        entry: origin.entry,
        forwardMin: origin.forwardMin,
        forwardMax: origin.forwardMax,
        direction: 'long',
      }),
    )
    .filter((quality) => !quality.degenerate)
    .map((quality) => quality.entryLocation);

  // Decision returns are direction-adjusted so a short that fell is a win.
  const decisionReturns = decisionOrigins.map((origin) =>
    origin.decision.decision === 'long-candidate' ? origin.observed : -origin.observed,
  );
  const wins = decisionReturns.filter((value) => value > 0).length;

  const runtimes = origins.map((origin) => origin.runtimeMs);
  const config = { ...args.config };

  const qrm: QrmBenchmarkSummary = {
    modelVersion: config.modelVersion ?? 'qrm-3.0.0',
    configHash: qrmConfigHash({
      modelVersion: config.modelVersion ?? 'qrm-3.0.0',
      historyYears: config.historyYears ?? 10,
      analoguePoolSize: config.analoguePoolSize ?? 128,
      targetEss: config.targetEss ?? 40,
      minEss: config.minEss ?? 20,
      paths: config.paths ?? 1_000,
      stationaryBlockMean: config.stationaryBlockMean ?? 5,
      horizons: config.horizons ?? [1, 5, 10],
      seed: config.seed ?? 20260915,
    }),
    forecastOrigins: origins.length,
    symbols: new Set(origins.map((origin) => origin.symbol)).size,
    crps: mean(crpsValues),
    directionBrier: mean(brierValues),
    p10p90CoveragePercent: origins.length
      ? (origins.filter((origin) => origin.covered).length / origins.length) * 100
      : null,
    medianBandWidthPercent: origins.length
      ? median(origins.map((origin) => origin.bandWidth)) * 100
      : null,
    decisions: decisionOrigins.length,
    longDecisions: longOrigins.length,
    shortDecisions: decisionOrigins.length - longOrigins.length,
    medianEntryLocationLong: longLocations.length ? median(longLocations) : null,
    medianEntryPenalty: entrySummary.meanEntryPenalty,
    meanForwardReturnOfDecisions: mean(decisionReturns),
    winRatePercent: decisionReturns.length ? (wins / decisionReturns.length) * 100 : null,
    expectancyR: mean(decisionReturns),
    expectancyCi95:
      decisionReturns.length >= 10
        ? calculateBootstrapExpectancyCi(decisionReturns, 'qrm-benchmark')
        : null,
    p50RuntimeMs: percentile(runtimes, 0.5),
    p95RuntimeMs: percentile(runtimes, 0.95),
    warnings,
  };

  // ---- Baselines ------------------------------------------------------
  const zeroReturn: BaselineSummary = {
    name: 'zero-return',
    // A point forecast of 0 scored with the same pinball loss: every quantile
    // sits at zero.
    crps: mean(
      origins.map(
        (origin) =>
          quantileCrps(
            {
              ...origin.distribution,
              terminalReturn: { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 },
            },
            origin.observed,
          ) ?? 0,
      ),
    ),
    directionBrier: mean(origins.map((origin) => directionBrier(0.5, origin.observed) ?? 0.25)),
  };

  const unconditional: BaselineSummary = {
    name: 'historical-unconditional',
    crps: mean(
      origins
        .map((origin) => {
          if (origin.unconditional.length < 10) return null;
          const sorted = [...origin.unconditional].sort((a, b) => a - b);
          const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
          return quantileCrps(
            {
              ...origin.distribution,
              terminalReturn: {
                p10: at(0.1),
                p25: at(0.25),
                p50: at(0.5),
                p75: at(0.75),
                p90: at(0.9),
              },
            },
            origin.observed,
          );
        })
        .filter((value): value is number => value !== null),
    ),
    directionBrier: mean(
      origins
        .map((origin) => {
          if (origin.unconditional.length < 10) return null;
          const positive = origin.unconditional.filter((value) => value > 0).length;
          return directionBrier(positive / origin.unconditional.length, origin.observed);
        })
        .filter((value): value is number => value !== null),
    ),
  };

  const momentum: BaselineSummary = {
    name: 'momentum-sign',
    // Directional only: a sign baseline has no distribution to score with CRPS.
    crps: null,
    directionBrier: mean(
      origins
        .map((origin) => {
          if (origin.trailingReturn20 === null) return null;
          return directionBrier(origin.trailingReturn20 > 0 ? 0.6 : 0.4, origin.observed);
        })
        .filter((value): value is number => value !== null),
    ),
  };

  // Chronological split: the development set is the earlier origins.
  const sortedOrigins = [...origins].sort((a, b) => a.cutoffIndex - b.cutoffIndex);
  const developmentCount = Math.floor(sortedOrigins.length * developmentFraction);

  return {
    qrm,
    baselines: [zeroReturn, unconditional, momentum],
    split: {
      developmentOrigins: developmentCount,
      holdoutOrigins: sortedOrigins.length - developmentCount,
      developmentFraction,
    },
  };
}

// ---------------------------------------------------------------------------
// Promotion gates (section 15)
// ---------------------------------------------------------------------------

export interface PromotionGateResult {
  gate: string;
  passed: boolean;
  detail: string;
}

export interface PromotionVerdict {
  /** `false` keeps QRM experimental, which is also the 3.0 default. */
  promotable: boolean;
  gates: PromotionGateResult[];
}

/**
 * Evaluates the promotion gates.
 *
 * Runtime is treated as a product gate: if the statistical gates pass and
 * runtime does not, the conclusion is to keep QRM in manual Lab mode — never to
 * weaken a statistical gate to compensate.
 */
export function evaluatePromotionGates(args: {
  holdout: QrmBenchmarkSummary;
  baselines: BaselineSummary[];
  leakageTestsPassed: boolean;
  reproducibilityTestsPassed: boolean;
  regimesRepresented: number;
  runtimeP95MsPerSymbol: number;
}): PromotionVerdict {
  const { holdout } = args;
  const unconditional = args.baselines.find((item) => item.name === 'historical-unconditional');
  const gates: PromotionGateResult[] = [];

  const gate = (name: string, passed: boolean, detail: string) =>
    gates.push({ gate: name, passed, detail });

  gate(
    'out-of-sample origins >= 1000',
    holdout.forecastOrigins >= 1_000,
    `${holdout.forecastOrigins} origins`,
  );
  gate('symbols >= 25', holdout.symbols >= 25, `${holdout.symbols} symbols`);
  gate(
    'multiple regimes represented',
    args.regimesRepresented >= 3,
    `${args.regimesRepresented} regimes`,
  );
  gate(
    'P10-P90 coverage within 75-85%',
    holdout.p10p90CoveragePercent !== null &&
      holdout.p10p90CoveragePercent >= 75 &&
      holdout.p10p90CoveragePercent <= 85,
    holdout.p10p90CoveragePercent === null
      ? 'not measured'
      : `${holdout.p10p90CoveragePercent.toFixed(1)}%`,
  );
  gate(
    'CRPS at least 2% better than unconditional',
    holdout.crps !== null &&
      unconditional?.crps !== null &&
      unconditional?.crps !== undefined &&
      holdout.crps <= unconditional.crps * 0.98,
    holdout.crps === null || unconditional?.crps == null
      ? 'not measured'
      : `${holdout.crps.toFixed(5)} vs ${unconditional.crps.toFixed(5)}`,
  );
  gate(
    'direction Brier no worse than unconditional',
    holdout.directionBrier !== null &&
      unconditional?.directionBrier !== null &&
      unconditional?.directionBrier !== undefined &&
      holdout.directionBrier <= unconditional.directionBrier,
    holdout.directionBrier === null || unconditional?.directionBrier == null
      ? 'not measured'
      : `${holdout.directionBrier.toFixed(5)} vs ${unconditional.directionBrier.toFixed(5)}`,
  );
  gate('decisions >= 100', holdout.decisions >= 100, `${holdout.decisions} decisions`);
  gate(
    'median entry penalty <= 0.60',
    holdout.medianEntryPenalty !== null && holdout.medianEntryPenalty <= 0.6,
    holdout.medianEntryPenalty === null
      ? 'not measured'
      : holdout.medianEntryPenalty.toFixed(3),
  );
  gate(
    'positive decision expectancy',
    holdout.expectancyR !== null && holdout.expectancyR > 0,
    holdout.expectancyR === null ? 'not measured' : holdout.expectancyR.toFixed(5),
  );
  gate(
    '95% expectancy lower bound > 0',
    holdout.expectancyCi95 !== null && holdout.expectancyCi95.lower > 0,
    holdout.expectancyCi95 === null
      ? 'not measured'
      : `[${holdout.expectancyCi95.lower}, ${holdout.expectancyCi95.upper}]`,
  );
  gate('no point-in-time leakage failures', args.leakageTestsPassed, args.leakageTestsPassed ? 'passed' : 'failed');
  gate(
    'reproducibility tests pass',
    args.reproducibilityTestsPassed,
    args.reproducibilityTestsPassed ? 'passed' : 'failed',
  );
  gate(
    'runtime p95 <= 2500ms per symbol (product gate)',
    args.runtimeP95MsPerSymbol <= 2_500,
    `${args.runtimeP95MsPerSymbol}ms`,
  );

  return { promotable: gates.every((item) => item.passed), gates };
}
