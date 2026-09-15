// Stage A feature computation. Pure, no network, no Signal Engine replay.
//
// Two choices worth stating:
//
//   * **Robust z-scores, not raw percent moves.** A single percent number
//     cannot say whether +6% is remarkable: for a utility it is enormous and
//     for a small-cap biotech it is Tuesday. Median/MAD standardisation answers
//     the question the percent cannot, and MAD is used instead of standard
//     deviation because the outliers we are hunting would otherwise inflate the
//     very denominator meant to detect them.
//   * **Residual against a fitted beta, not a raw difference.** On a day the
//     market falls 3%, a high-beta name falling 4% is unremarkable. Subtracting
//     `beta * benchmarkReturn` says so; subtracting the raw benchmark return
//     does not.
//
// Raw z-scores are stored uncapped. Capping happens only where a score feeds a
// display contribution, so the underlying measurement stays available.

import type { Candle } from './types';
import type { MarketRegime } from './quant';
import { classifyRegime } from './quant';
import type { DiscoveryFeatures } from './discovery';
import { wilderAtr, latest as latestOf } from './indicators';

const MINIMUM_BETA_OBSERVATIONS = 40;
const BETA_WINDOW = 60;

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentChangeOver(closes: number[], bars: number): number | null {
  if (closes.length <= bars) return null;
  const from = closes[closes.length - 1 - bars];
  const to = closes[closes.length - 1];
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

function simpleMovingAverage(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const slice = values.slice(-period);
  const total = slice.reduce((sum, value) => sum + value, 0);
  return Number.isFinite(total) ? total / period : null;
}

/** Bar-over-bar percent returns. */
function dailyReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    const previous = closes[i - 1];
    if (!Number.isFinite(previous) || previous <= 0) continue;
    out.push(((closes[i] - previous) / previous) * 100);
  }
  return out;
}

/**
 * Median/MAD z-score.
 *
 * `1.4826` scales MAD to be a consistent estimator of the standard deviation
 * for normally distributed data, so the result is comparable to a conventional
 * z-score while staying robust to the outliers being detected.
 */
export function robustZScore(value: number | null, baseline: number[]): number | null {
  if (value === null || !Number.isFinite(value) || baseline.length < 8) return null;
  const centre = median(baseline);
  if (centre === null) return null;
  const deviations = baseline.map((item) => Math.abs(item - centre));
  const mad = median(deviations);
  if (mad === null) return null;
  const robustSigma = Math.max(1e-8, 1.4826 * mad);
  const z = (value - centre) / robustSigma;
  return Number.isFinite(z) ? z : null;
}

/** Returns keyed by UTC day so two series can be intersected by date. */
function returnsByDay(candles: Candle[]): Map<number, number> {
  const usable = candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.time - b.time);
  const out = new Map<number, number>();
  for (let i = 1; i < usable.length; i++) {
    const previous = usable[i - 1].close;
    if (previous <= 0) continue;
    out.set(Math.floor(usable[i].time / 86_400), (usable[i].close / previous - 1) * 100);
  }
  return out;
}

export interface BetaResult {
  beta: number;
  observations: number;
}

/**
 * OLS beta of asset returns on benchmark returns, over intersected dates.
 *
 * Returns null below `MINIMUM_BETA_OBSERVATIONS`: a beta from a handful of
 * overlapping days is noise that would then be multiplied into every residual.
 */
export function estimateBeta(
  asset: Candle[],
  benchmark: Candle[],
  window = BETA_WINDOW,
): BetaResult | null {
  const assetReturns = returnsByDay(asset);
  const benchmarkReturns = returnsByDay(benchmark);
  const days = [...assetReturns.keys()]
    .filter((day) => benchmarkReturns.has(day))
    .sort((a, b) => a - b)
    .slice(-window);
  if (days.length < MINIMUM_BETA_OBSERVATIONS) return null;

  const x = days.map((day) => benchmarkReturns.get(day) as number);
  const y = days.map((day) => assetReturns.get(day) as number);
  const meanX = mean(x) as number;
  const meanY = mean(y) as number;
  let covariance = 0;
  let variance = 0;
  for (let i = 0; i < days.length; i++) {
    covariance += (x[i] - meanX) * (y[i] - meanY);
    variance += (x[i] - meanX) ** 2;
  }
  if (!(variance > 0)) return null;
  const beta = covariance / variance;
  return Number.isFinite(beta) ? { beta, observations: days.length } : null;
}

/**
 * Residual move: asset return less beta-scaled benchmark return over the same
 * intersected dates. Null when beta could not be estimated — no regression
 * result is produced from inadequate overlap.
 */
export function residualReturn(
  asset: Candle[],
  benchmark: Candle[],
  bars: number,
): number | null {
  const betaResult = estimateBeta(asset, benchmark);
  if (!betaResult) return null;

  const assetReturns = returnsByDay(asset);
  const benchmarkReturns = returnsByDay(benchmark);
  const days = [...assetReturns.keys()]
    .filter((day) => benchmarkReturns.has(day))
    .sort((a, b) => a - b)
    .slice(-bars);
  if (days.length < bars) return null;

  // Compounded over the window, so a 20-day residual is a 20-day figure rather
  // than a sum of daily approximations.
  let assetGrowth = 1;
  let benchmarkGrowth = 1;
  for (const day of days) {
    assetGrowth *= 1 + (assetReturns.get(day) as number) / 100;
    benchmarkGrowth *= 1 + (benchmarkReturns.get(day) as number) / 100;
  }
  const assetPercent = (assetGrowth - 1) * 100;
  const benchmarkPercent = (benchmarkGrowth - 1) * 100;
  const residual = assetPercent - betaResult.beta * benchmarkPercent;
  return Number.isFinite(residual) ? residual : null;
}

export interface DiscoveryFeatureInput {
  symbol: string;
  candles: Candle[];
  benchmark?: Candle[];
  sector?: Candle[];
  /** Regime from the previous completed scan, for structural-change detection. */
  priorRegime?: MarketRegime | null;
}

export function computeDiscoveryFeatures(input: DiscoveryFeatureInput): DiscoveryFeatures | null {
  const candles = input.candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0)
    .sort((a, b) => a.time - b.time);
  if (candles.length < 30) return null;

  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => (Number.isFinite(candle.volume) ? candle.volume : 0));
  const lastClose = closes[closes.length - 1];
  const lastCandle = candles[candles.length - 1];

  const atrSeries = wilderAtr(candles, 14);
  const atr14 = latestOf(atrSeries);
  const atrPercent14 = atr14 !== null && lastClose > 0 ? (atr14 / lastClose) * 100 : null;

  const returns = dailyReturns(closes);
  const realizedVol20 = (() => {
    const window = returns.slice(-20);
    if (window.length < 10) return null;
    const average = mean(window) as number;
    const variance =
      window.reduce((sum, value) => sum + (value - average) ** 2, 0) / (window.length - 1);
    const stdev = Math.sqrt(variance);
    // Annualised so it is comparable with the volatility figures elsewhere.
    return Number.isFinite(stdev) ? stdev * Math.sqrt(252) : null;
  })();

  const volatilityRatio20To60 = (() => {
    const short = returns.slice(-20);
    const long = returns.slice(-60);
    if (short.length < 10 || long.length < 30) return null;
    const stdev = (values: number[]) => {
      const average = mean(values) as number;
      return Math.sqrt(
        values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1),
      );
    };
    const shortVol = stdev(short);
    const longVol = stdev(long);
    return longVol > 0 && Number.isFinite(shortVol / longVol) ? shortVol / longVol : null;
  })();

  // The 20-bar average excludes the bar being measured, otherwise a volume
  // spike partly raises its own baseline.
  const priorVolumes = volumes.slice(-21, -1);
  const averageVolume20 = priorVolumes.length ? (mean(priorVolumes) as number) : null;
  const volumeRatio20 =
    averageVolume20 !== null && averageVolume20 > 0
      ? volumes[volumes.length - 1] / averageVolume20
      : null;

  const dollarVolumes20 = candles
    .slice(-20)
    .map((candle) => candle.close * (Number.isFinite(candle.volume) ? candle.volume : 0));
  const dollarVolumeMedian20 = median(dollarVolumes20);

  const ma20 = simpleMovingAverage(closes, 20);
  const ma50 = simpleMovingAverage(closes, 50);
  const ma200 = simpleMovingAverage(closes, 200);

  // Distance in ATR rather than percent: 2% from the mean means something
  // different for a quiet name than a volatile one.
  const distanceMa20Atr =
    ma20 !== null && atr14 !== null && atr14 > 0 ? (lastClose - ma20) / atr14 : null;
  const distanceMa50Atr =
    ma50 !== null && atr14 !== null && atr14 > 0 ? (lastClose - ma50) / atr14 : null;
  const distanceMa200Percent =
    ma200 !== null && ma200 > 0 ? ((lastClose - ma200) / ma200) * 100 : null;

  const high252 = candles.slice(-252).reduce((high, candle) => Math.max(high, candle.high), 0);
  const distance52wHighPercent =
    high252 > 0 ? ((high252 - lastClose) / high252) * 100 : null;

  const return20 = percentChangeOver(closes, 20);
  // Baseline of historical 20-day returns, sampled every 5 bars so the windows
  // overlap less and the baseline is not dominated by one episode.
  const return20Baseline: number[] = [];
  for (let end = closes.length - 1; end - 20 >= 0 && return20Baseline.length < 60; end -= 5) {
    const from = closes[end - 20];
    if (Number.isFinite(from) && from > 0) {
      return20Baseline.push(((closes[end] - from) / from) * 100);
    }
  }
  const returnZ20 = robustZScore(return20, return20Baseline);

  const volumeBaseline60 = volumes.slice(-61, -1);
  const volumeZ60 = robustZScore(volumes[volumes.length - 1], volumeBaseline60);

  const benchmark = input.benchmark ?? [];
  const sector = input.sector ?? [];

  return {
    symbol: input.symbol.trim().toUpperCase(),
    asOf: lastCandle.time,
    return1: percentChangeOver(closes, 1),
    return5: percentChangeOver(closes, 5),
    return20,
    return63: percentChangeOver(closes, 63),
    return126: percentChangeOver(closes, 126),
    realizedVol20,
    atrPercent14,
    volumeRatio20: finite(volumeRatio20),
    dollarVolumeMedian20,
    distanceMa20Atr: finite(distanceMa20Atr),
    distanceMa50Atr: finite(distanceMa50Atr),
    distanceMa200Percent: finite(distanceMa200Percent),
    distance52wHighPercent: finite(distance52wHighPercent),
    returnZ20,
    volumeZ60,
    volatilityRatio20To60: finite(volatilityRatio20To60),
    spyResidual5: benchmark.length ? residualReturn(candles, benchmark, 5) : null,
    spyResidual20: benchmark.length ? residualReturn(candles, benchmark, 20) : null,
    sectorResidual5: sector.length ? residualReturn(candles, sector, 5) : null,
    sectorResidual20: sector.length ? residualReturn(candles, sector, 20) : null,
    // Cross-sectional, so it is filled in by the ranking pass.
    relativeStrengthPercentile126: null,
    regime: classifyRegime(candles),
    priorRegime: input.priorRegime ?? null,
  };
}
