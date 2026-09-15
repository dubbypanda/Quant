// Raw scored factors and indicator readings, ported from the Quantactic iOS
// engine (`SignalEngine.swift` detection rules + `SignalReadings`).
//
// This is the layer Quant was missing. Its existing `SignalComponent[]` is a
// scoring ledger for one decision — it answers "did this check pass", already
// phrased relative to a direction the engine had picked. The evidence model
// needs the other reading: what price is doing, independent of any conclusion.
// Factors carry that, which is why they have a `kind` with a fixed polarity
// rather than a pass/fail status.

import type { Candle } from './types';
import { ema, latest, macd, percentChange, sma, wilderAtr, wilderRsi } from './indicators';

/**
 * The raw factor vocabulary. Adding a member forces a decision in
 * `signalEvidenceAggregator.ts` about which evidence category absorbs it — a
 * scored factor that reaches no category is worse than no factor, because it
 * can drive the conclusion while being invisible in the evidence list the user
 * is told is complete.
 */
export type SignalFactorKind =
  | 'trend-alignment'
  | 'yearly-high'
  | 'average-reclaim'
  | 'average-loss'
  | 'above-average'
  | 'below-average'
  | 'range'
  | 'macd'
  | 'rsi'
  | 'momentum'
  | 'price-move'
  | 'volume';

export interface SignalFactor {
  kind: SignalFactorKind;
  /** One plain sentence describing the observation. */
  text: string;
  /** Contribution weight, 0..1. */
  weight: number;
  /**
   * "This condition was detected and scored" — NOT "this is bullish". A lost
   * moving average is recorded with `positive: true`. Only `rsi` and
   * `price-move` set it to mean direction; see `factorPriceLean`.
   */
  positive: boolean;
}

export interface SignalReadings {
  rsi14: number | null;
  macdHistogram: number | null;
  movingAverage20: number | null;
  movingAverage50: number | null;
  movingAverage120: number | null;
  relativeVolume: number | null;
  atr14: number | null;
  distanceToYearHighPercent: number | null;
}

export interface SignalFactorSet {
  factors: SignalFactor[];
  readings: SignalReadings;
  /** The price the factors were measured against. */
  mark: number;
  /** True when the series is long enough for a "52-week" claim to mean it. */
  hasYearOfHistory: boolean;
  atOrNearYearHigh: boolean;
  /** Prior 20-bar high, excluding the bar being evaluated. */
  priorHigh: number | null;
  breakoutConfirmed: boolean;
  nearBreakout: boolean;
  reclaimedMovingAverage20: boolean;
}

export const EMPTY_READINGS: SignalReadings = {
  rsi14: null,
  macdHistogram: null,
  movingAverage20: null,
  movingAverage50: null,
  movingAverage120: null,
  relativeVolume: null,
  atr14: null,
  distanceToYearHighPercent: null,
};

/**
 * Sessions a series needs before a price may be called a *52-week* high.
 *
 * The engine takes the trailing 252 bars but runs on 50, and live paths fall
 * back to shorter ranges when a long request fails — so a three-month high
 * could be announced as "at the 52-week high". 200 sessions is roughly ten
 * months: short of a full year, because a series merely missing some holidays
 * should not lose the reading, and far enough from 63 that the claim means
 * what it says.
 */
export const MINIMUM_YEAR_HIGH_SESSIONS = 200;

const MAX_FACTORS = 6;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function fmt(value: number, digits = 2): string {
  return value.toFixed(digits);
}

/**
 * Whether an occurrence of this factor is constructive for price.
 *
 * Polarity comes from the kind, not from `positive`, because `positive` in the
 * detection rules means "detected and scored". The flag is consulted only for
 * the two kinds where the rules do set it to mean direction.
 */
export function factorPriceLean(kind: SignalFactorKind, positive: boolean): -1 | 0 | 1 {
  switch (kind) {
    case 'trend-alignment':
    case 'yearly-high':
    case 'average-reclaim':
    case 'momentum':
    case 'macd':
    case 'volume':
    case 'above-average':
      return 1;
    case 'average-loss':
    case 'below-average':
      return -1;
    case 'rsi':
    case 'price-move':
      return positive ? 1 : -1;
    case 'range':
      // A tight range is a setup condition, not a direction.
      return 0;
  }
}

/**
 * Detects the raw factors and indicator readings for one symbol.
 *
 * `livePrice` lets a same-session move be seen while the last bar is still
 * forming: it replaces the close (and widens the high/low) of the final bar
 * only, so volume and prior lows still come from history. Pass null to read
 * the series exactly as given, which is what the historical replay must do.
 */
export function detectSignalFactors(
  candles: Candle[],
  livePrice: number | null = null,
): SignalFactorSet | null {
  const clean = candles.filter((c) => c.close > 0).slice(-252);
  if (clean.length < 50) return null;

  const bars = [...clean];
  const lastBar = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const mark = isFiniteNumber(livePrice) && livePrice > 0 ? livePrice : lastBar.close;
  if (isFiniteNumber(livePrice) && livePrice > 0 && Math.abs(livePrice / lastBar.close - 1) > 0.0005) {
    bars[bars.length - 1] = {
      time: lastBar.time,
      open: lastBar.open,
      high: Math.max(lastBar.high, livePrice),
      low: Math.min(lastBar.low, livePrice),
      close: livePrice,
      volume: lastBar.volume,
    };
  }
  const latestBar = bars[bars.length - 1];
  const closes = bars.map((c) => c.close);

  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const ma120 = sma(closes, Math.min(120, Math.max(50, Math.floor(closes.length * 0.55))));

  const factors: SignalFactor[] = [];

  // Trend alignment — compared against the live mark, not a lagged bar alone.
  if (ma20 !== null && ma50 !== null && ma120 !== null && mark > ma20 && ma20 > ma50 && ma50 > ma120) {
    factors.push({
      kind: 'trend-alignment',
      text: 'Price is above a rising stack of 20, 50 and long moving averages.',
      weight: 0.2,
      positive: true,
    });
  }

  // 52-week high proximity — only when the series is long enough to describe a year.
  const hasYearOfHistory = bars.length >= MINIMUM_YEAR_HIGH_SESSIONS;
  let high252 = mark;
  for (const c of bars) if (c.high > high252) high252 = c.high;
  const distanceToHigh = high252 > 0 ? ((high252 - mark) / high252) * 100 : 100;
  const atOrNearYearHigh = hasYearOfHistory && mark >= high252 * 0.995;
  if (atOrNearYearHigh) {
    factors.push({
      kind: 'yearly-high',
      text: 'Price is at its 52-week high.',
      weight: 0.17,
      positive: true,
    });
  } else if (hasYearOfHistory && distanceToHigh <= 4) {
    factors.push({
      kind: 'yearly-high',
      text: `Price is within ${fmt(distanceToHigh, 1)}% of its 52-week high.`,
      weight: 0.12,
      positive: true,
    });
  }

  // Volume surge — the average excludes the bar being measured.
  const volumeWindow = bars.slice(-21, -1);
  const averageVolume = volumeWindow.length
    ? volumeWindow.reduce((sum, c) => sum + c.volume, 0) / volumeWindow.length
    : 0;
  const relativeVolume = averageVolume > 0 ? latestBar.volume / averageVolume : null;
  if (relativeVolume !== null && relativeVolume >= 1.75 && mark > prev.close) {
    factors.push({
      kind: 'volume',
      text: `Volume is ${fmt(relativeVolume)}x the 20-bar average on an up close.`,
      weight: 0.13,
      positive: true,
    });
  }

  // MACD
  const macdResult = macd(closes);
  const macdNow = macdResult.macd[macdResult.macd.length - 1];
  const macdSignalNow = macdResult.signal[macdResult.signal.length - 1];
  const macdHistogram =
    isFiniteNumber(macdNow) && isFiniteNumber(macdSignalNow) ? macdNow - macdSignalNow : null;
  if (isFiniteNumber(macdNow) && isFiniteNumber(macdSignalNow) && macdNow > macdSignalNow) {
    factors.push({
      kind: 'macd',
      text: 'MACD is above its signal line.',
      weight: 0.08,
      positive: true,
    });
  }

  // Moving-average reclaim. Kept as its own trigger so the resolver can tell a
  // confirmed pullback entry from a merely constructive trend with no entry.
  const reclaimedMovingAverage20 =
    ma20 !== null &&
    prev.low <= ma20 * 1.01 &&
    mark > ma20 &&
    mark > prev.close &&
    latestBar.close >= latestBar.open;
  if (reclaimedMovingAverage20) {
    factors.push({
      kind: 'average-reclaim',
      text: 'Price reclaimed the 20-bar average after testing it.',
      weight: 0.09,
      positive: true,
    });
  }

  // Momentum
  const return63 = closes.length > 63 ? percentChange(closes[closes.length - 64], mark) : null;
  const return126 = closes.length > 126 ? percentChange(closes[closes.length - 127], mark) : null;
  if (return63 !== null && return126 !== null && return63 >= 12 && return126 >= 18) {
    factors.push({
      kind: 'momentum',
      text: 'Three- and six-month returns are both strong.',
      weight: 0.1,
      positive: true,
    });
  }

  // Cooling / caution
  if (ma20 !== null && mark < ma20 && (return63 ?? 0) < 0) {
    factors.push({
      kind: 'average-loss',
      text: 'Price has lost the 20-bar average with a negative three-month return.',
      weight: 0.12,
      positive: true,
    });
  }

  // Range detection
  const recent = bars.slice(-20);
  let recentHigh = -Infinity;
  let recentLow = Infinity;
  for (const c of recent) {
    if (c.high > recentHigh) recentHigh = c.high;
    if (c.low < recentLow) recentLow = c.low;
  }
  if (recentLow > 0 && mark > 0) {
    const band = ((recentHigh - recentLow) / mark) * 100;
    if (band <= 8 && factors.length < 2) {
      factors.push({
        kind: 'range',
        text: `Price is inside a ${fmt(band, 1)}% band between ${fmt(recentLow)} and ${fmt(recentHigh)}.`,
        weight: 0.14,
        positive: true,
      });
    }
  }

  // RSI
  const rsi14 = latest(wilderRsi(closes, 14));
  if (rsi14 !== null) {
    const constructive = rsi14 >= 45 && rsi14 <= 68;
    const state = rsi14 > 70 ? 'overbought' : rsi14 < 35 ? 'oversold' : 'constructive';
    factors.push({
      kind: 'rsi',
      text: `RSI is ${fmt(rsi14, 1)} (${state}).`,
      weight: 0.1,
      positive: constructive,
    });
  }

  // Never emit an empty factor set for a symbol that has usable history: an
  // empty evidence list is indistinguishable from a broken one.
  if (!factors.length) {
    const changePercent = percentChange(prev.close, mark) ?? 0;
    factors.push({
      kind: 'price-move',
      text: `Last close ${fmt(mark)} (${changePercent >= 0 ? '+' : ''}${fmt(changePercent)}%).`,
      weight: 0.05,
      positive: changePercent >= 0,
    });
    if (ma20 !== null) {
      factors.push({
        kind: mark >= ma20 ? 'above-average' : 'below-average',
        text: mark >= ma20 ? 'Price is above its 20-bar average.' : 'Price is below its 20-bar average.',
        weight: 0.08,
        positive: mark >= ma20,
      });
    }
    if (ma50 !== null) {
      factors.push({
        kind: mark >= ma50 ? 'above-average' : 'below-average',
        text: mark >= ma50 ? 'Price is above its 50-bar average.' : 'Price is below its 50-bar average.',
        weight: 0.07,
        positive: mark >= ma50,
      });
    }
  } else if (factors.length < 3 && ma20 !== null) {
    factors.push({
      kind: mark >= ma20 ? 'above-average' : 'below-average',
      text: mark >= ma20 ? 'Price is holding above its 20-bar average.' : 'Price is under its 20-bar average.',
      weight: 0.08,
      positive: mark >= ma20,
    });
  }

  const atr14 = latest(wilderAtr(bars, 14));

  // Breakout geometry, measured against closed bars only.
  const priorWindow = bars.slice(-21, -1);
  let priorHigh: number | null = null;
  for (const c of priorWindow) if (priorHigh === null || c.high > priorHigh) priorHigh = c.high;
  const breakoutLevel = priorHigh === null ? null : priorHigh * 1.002;
  const nearBreakout = (priorHigh !== null && mark >= priorHigh * 0.985) || atOrNearYearHigh;
  const breakoutConfirmed =
    breakoutLevel !== null && mark >= breakoutLevel && (relativeVolume ?? 0) >= 1.2;

  return {
    factors: factors.slice(0, MAX_FACTORS),
    readings: {
      rsi14,
      macdHistogram,
      movingAverage20: ma20,
      movingAverage50: ma50,
      movingAverage120: ma120,
      relativeVolume,
      atr14,
      distanceToYearHighPercent: hasYearOfHistory ? Math.max(0, distanceToHigh) : null,
    },
    mark,
    hasYearOfHistory,
    atOrNearYearHigh,
    priorHigh,
    breakoutConfirmed,
    nearBreakout,
    reclaimedMovingAverage20,
  };
}

/** Kept exported so the EMA seeding convention has one owner in tests. */
export { ema };
