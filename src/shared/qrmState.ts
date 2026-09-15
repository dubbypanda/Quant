// Point-in-time QRM state estimation.
//
// The one invariant that matters: **every statistic reads only rows at or
// before `cutoffIndex`**. A single off-by-one here silently leaks the future
// into a model that is then benchmarked as if it were honest, so the cutoff is
// threaded through every helper explicitly rather than being applied by slicing
// once at the top and trusting later code.
//
// Standardisation is robust (median / MAD) and the model input is clamped to
// ±8. Clamping matters because one 40-sigma print would otherwise dominate
// every distance computation downstream; the unclamped value is available for
// diagnostics.

import type { Candle } from './types';
import type { QrmStateVector } from './qrm';
import { classifyRegime } from './quant';
import { wilderAtr } from './indicators';

export const QRM_Z_CLAMP = 8;
const EPSILON = 1e-8;
/** Rolling window used to standardise a raw feature against its own history. */
const STANDARDIZATION_WINDOW = 252;
const MINIMUM_STANDARDIZATION_SAMPLES = 60;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface RobustStandardization {
  center: number;
  scale: number;
  /** Model input, clamped to ±QRM_Z_CLAMP. */
  z: number;
  /** Unclamped, for diagnostics. */
  rawZ: number;
}

/**
 * Robust z of `value` against a training history.
 *
 * `1.4826 * MAD` is the consistent estimator of sigma under normality, so the
 * result is comparable to a conventional z-score while being unmoved by the
 * outliers it is meant to measure.
 */
export function robustStandardize(
  value: number,
  train: number[],
): RobustStandardization | null {
  if (!Number.isFinite(value) || train.length < MINIMUM_STANDARDIZATION_SAMPLES) return null;
  const center = median(train);
  if (center === null) return null;
  const mad = median(train.map((item) => Math.abs(item - center)));
  if (mad === null) return null;
  const scale = Math.max(EPSILON, 1.4826 * mad);
  const rawZ = (value - center) / scale;
  if (!Number.isFinite(rawZ)) return null;
  return {
    center,
    scale,
    z: Math.max(-QRM_Z_CLAMP, Math.min(QRM_Z_CLAMP, rawZ)),
    rawZ,
  };
}

/** Percent return over `bars`, ending at `end` inclusive. */
function returnAt(closes: number[], end: number, bars: number): number | null {
  const from = end - bars;
  if (from < 0 || end >= closes.length) return null;
  const start = closes[from];
  if (!Number.isFinite(start) || start <= 0) return null;
  return ((closes[end] - start) / start) * 100;
}

/** Daily returns for bars (start, end], both indices inclusive bounds. */
function dailyReturnsWindow(closes: number[], end: number, count: number): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, end - count + 1); i <= end; i++) {
    const previous = closes[i - 1];
    if (!Number.isFinite(previous) || previous <= 0) continue;
    out.push(((closes[i] - previous) / previous) * 100);
  }
  return out;
}

function standardDeviation(values: number[]): number | null {
  if (values.length < 3) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const stdev = Math.sqrt(variance);
  return Number.isFinite(stdev) ? stdev : null;
}

/** History of a scalar feature, evaluated at each bar up to `cutoffIndex`. */
function featureHistory(
  cutoffIndex: number,
  compute: (index: number) => number | null,
  window = STANDARDIZATION_WINDOW,
): number[] {
  const out: number[] = [];
  for (let i = Math.max(0, cutoffIndex - window + 1); i <= cutoffIndex; i++) {
    const value = compute(i);
    if (value !== null && Number.isFinite(value)) out.push(value);
  }
  return out;
}

/**
 * Builds the state vector at `cutoffIndex`.
 *
 * Returns null rather than a partially-filled vector when any required
 * component is unavailable: a state with silently-zeroed features would be
 * matched against analogues as though those features were measured.
 */
export function buildQrmStateAt(
  assetCandles: Candle[],
  spyCandles: Candle[],
  cutoffIndex: number,
): QrmStateVector | null {
  if (cutoffIndex < 0 || cutoffIndex >= assetCandles.length) return null;
  // Only bars at or before the cutoff may be read. This slice is the single
  // place the boundary is applied; everything below indexes within it.
  const bars = assetCandles.slice(0, cutoffIndex + 1);
  if (bars.length < MINIMUM_STANDARDIZATION_SAMPLES + 21) return null;

  const closes = bars.map((candle) => candle.close);
  const volumes = bars.map((candle) => (Number.isFinite(candle.volume) ? candle.volume : 0));
  const end = bars.length - 1;
  const asOf = bars[end].time;

  const atrSeries = wilderAtr(bars, 14);
  const atr = atrSeries[end];
  if (atr === null || !(atr > 0)) return null;

  // ---- Raw features at the cutoff ----------------------------------
  const return1 = returnAt(closes, end, 1);
  const return5 = returnAt(closes, end, 5);
  const return20 = returnAt(closes, end, 20);
  const realizedVol20 = standardDeviation(dailyReturnsWindow(closes, end, 20));
  const vol60 = standardDeviation(dailyReturnsWindow(closes, end, 60));
  if (return1 === null || return5 === null || return20 === null) return null;
  if (realizedVol20 === null || vol60 === null || !(vol60 > 0)) return null;

  const sma = (period: number, at: number): number | null => {
    if (at + 1 < period) return null;
    let total = 0;
    for (let i = at - period + 1; i <= at; i++) total += closes[i];
    return total / period;
  };
  const ma20 = sma(20, end);
  const ma50 = sma(50, end);
  if (ma20 === null || ma50 === null) return null;

  const high252 = (() => {
    let high = 0;
    for (let i = Math.max(0, end - 251); i <= end; i++) high = Math.max(high, bars[i].high);
    return high;
  })();
  if (!(high252 > 0)) return null;
  const distance52wHighPercent = ((high252 - closes[end]) / high252) * 100;

  // ---- SPY residuals, aligned by date -------------------------------
  const spyByDay = new Map<number, number>();
  for (const candle of spyCandles) {
    // The benchmark is also cut off: a benchmark bar after the cutoff is just
    // as much of a leak as an asset bar after it.
    if (candle.time > asOf) continue;
    if (Number.isFinite(candle.close) && candle.close > 0) {
      spyByDay.set(Math.floor(candle.time / 86_400), candle.close);
    }
  }
  const spyReturnOver = (bars_: number) => {
    const endDay = Math.floor(asOf / 86_400);
    const endClose = spyByDay.get(endDay);
    if (endClose === undefined) return null;
    // Walk back through available benchmark days.
    const days = [...spyByDay.keys()].sort((a, b) => a - b);
    const endPosition = days.indexOf(endDay);
    if (endPosition < bars_) return null;
    const startClose = spyByDay.get(days[endPosition - bars_]);
    if (startClose === undefined || !(startClose > 0)) return null;
    return ((endClose - startClose) / startClose) * 100;
  };
  const spy5 = spyReturnOver(5);
  const spy20 = spyReturnOver(20);
  const spyResidual5Raw = spy5 === null ? null : return5 - spy5;
  const spyResidual20Raw = spy20 === null ? null : return20 - spy20;

  // ---- Relative strength (trailing 126-day return) -------------------
  const relativeStrength126 = returnAt(closes, end, 126);

  // ---- Robust standardisation against each feature's own history -----
  const standardizeOrNull = (
    current: number | null,
    compute: (index: number) => number | null,
  ): number | null => {
    if (current === null) return null;
    const history = featureHistory(end, compute);
    const result = robustStandardize(current, history);
    return result === null ? null : result.z;
  };

  const return1Z = standardizeOrNull(return1, (i) => returnAt(closes, i, 1));
  const return5Z = standardizeOrNull(return5, (i) => returnAt(closes, i, 5));
  const return20Z = standardizeOrNull(return20, (i) => returnAt(closes, i, 20));
  const realizedVol20Z = standardizeOrNull(realizedVol20, (i) =>
    standardDeviation(dailyReturnsWindow(closes, i, 20)),
  );
  const volumeZ60 = standardizeOrNull(volumes[end], (i) => (i >= 1 ? volumes[i] : null));
  const distance52wHighZ = standardizeOrNull(distance52wHighPercent, (i) => {
    let high = 0;
    for (let j = Math.max(0, i - 251); j <= i; j++) high = Math.max(high, bars[j].high);
    return high > 0 ? ((high - closes[i]) / high) * 100 : null;
  });
  const spyResidual5Z =
    spyResidual5Raw === null
      ? null
      : standardizeOrNull(spyResidual5Raw, (i) => {
          const assetReturn = returnAt(closes, i, 5);
          return assetReturn === null ? null : assetReturn;
        });
  const spyResidual20Z =
    spyResidual20Raw === null
      ? null
      : standardizeOrNull(spyResidual20Raw, (i) => {
          const assetReturn = returnAt(closes, i, 20);
          return assetReturn === null ? null : assetReturn;
        });

  if (
    return1Z === null ||
    return5Z === null ||
    return20Z === null ||
    realizedVol20Z === null ||
    volumeZ60 === null ||
    distance52wHighZ === null ||
    spyResidual5Z === null ||
    spyResidual20Z === null ||
    relativeStrength126 === null
  ) {
    return null;
  }

  return {
    asOf,
    return1Z,
    return5Z,
    return20Z,
    realizedVol20Z,
    volatilityRatio20To60: realizedVol20 / vol60,
    volumeZ60,
    ma20DistanceAtr: (closes[end] - ma20) / atr,
    ma50DistanceAtr: (closes[end] - ma50) / atr,
    distance52wHighZ,
    spyResidual5Z,
    spyResidual20Z,
    relativeStrength126,
    // Categorical, never encoded as an ordinal number — regime affects
    // analogue weighting through an explicit compatibility matrix instead.
    regime: classifyRegime(bars),
  };
}
