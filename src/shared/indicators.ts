// Wilder-smoothed indicator math, ported from the Quantactic iOS engine
// (`TechnicalIndicatorMath.swift`). Series-returning by design: the unified
// signal model reads the latest value, while the historical replay needs the
// value as it stood at an arbitrary bar, and recomputing a whole window per
// bar is what makes a replay quadratic.
//
// Wilder smoothing is not interchangeable with a simple average of the same
// length. The legacy `atr()` in quant.ts is an SMA of true ranges, which
// reacts a full period faster after a volatility spike; every threshold
// expressed in ATR units therefore means something slightly different
// depending on which one produced it. New code should use `wilderAtr`.

import type { Candle } from './types';

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** True range of `candle` against the previous close. 0 when either bar is unusable. */
export function trueRange(candle: Candle, previousClose: number): number {
  if (!isFiniteNumber(candle.high) || !isFiniteNumber(candle.low) || !isFiniteNumber(previousClose)) {
    return 0;
  }
  const value = Math.max(
    candle.high - candle.low,
    Math.abs(candle.high - previousClose),
    Math.abs(candle.low - previousClose),
  );
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Wilder-smoothed Average True Range, aligned to `candles`.
 *
 * `result[i]` is the ATR as of bar `i`, or null while the series is still
 * warming up. The first defined value sits at index `period` and is the simple
 * mean of the first `period` true ranges; bar 0 has no true range because it
 * has no previous close.
 */
export function wilderAtr(candles: Candle[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(candles.length).fill(null);
  if (candles.length < period + 1 || period < 1) return result;

  const tr: number[] = [0];
  for (let i = 1; i < candles.length; i++) {
    tr.push(trueRange(candles[i], candles[i - 1].close));
  }

  let current = 0;
  for (let i = 1; i <= period; i++) current += tr[i];
  current /= period;
  result[period] = current;

  for (let i = period + 1; i < candles.length; i++) {
    current = (current * (period - 1) + tr[i]) / period;
    result[i] = current;
  }
  return result;
}

/** Wilder-smoothed Relative Strength Index, aligned to `closes`. */
export function wilderRsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length < period + 1 || period < 1) return result;

  const gains: number[] = [0];
  const losses: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    if (!isFiniteNumber(closes[i]) || !isFiniteNumber(closes[i - 1])) {
      gains.push(0);
      losses.push(0);
      continue;
    }
    const diff = closes[i] - closes[i - 1];
    gains.push(Math.max(0, diff));
    losses.push(Math.max(0, -diff));
  }

  // An all-up warmup has no loss to divide by. 100 claims a maximal reading
  // from a single direction; 50 for a flat series says "no information", which
  // is what a series of unchanged closes actually carries.
  const rsi = (gain: number, loss: number): number => {
    if (loss === 0) return gain > 0 ? 100 : 50;
    return 100 - 100 / (1 + gain / loss);
  };

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    avgGain += gains[i];
    avgLoss += losses[i];
  }
  avgGain /= period;
  avgLoss /= period;
  result[period] = rsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    result[i] = rsi(avgGain, avgLoss);
  }
  return result;
}

/** Simple moving average of the `period` values ending at `end` (exclusive). */
export function sma(values: number[], period: number, end = values.length): number | null {
  if (period <= 0 || end < period || end > values.length) return null;
  let sum = 0;
  for (let i = end - period; i < end; i++) sum += values[i];
  const avg = sum / period;
  return Number.isFinite(avg) ? avg : null;
}

/** EMA series seeded with the first value, matching the iOS engine and signals.ts. */
export function ema(values: number[], period: number): number[] {
  if (period <= 0 || !values.length) return [];
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  /** macd − signal, the value the evidence model reports. */
  histogram: number[];
}

export function macd(
  closes: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9,
): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = fastEma.map((value, i) => value - (slowEma[i] ?? value));
  const signalLine = ema(macdLine, signalPeriod);
  return {
    macd: macdLine,
    signal: signalLine,
    histogram: macdLine.map((value, i) => value - (signalLine[i] ?? value)),
  };
}

/** Percent change from `from` to `to`, or null when it cannot be expressed. */
export function percentChange(from: number | null | undefined, to: number | null | undefined): number | null {
  if (!isFiniteNumber(from) || !isFiniteNumber(to) || from === 0) return null;
  return ((to - from) / from) * 100;
}

/** Last defined entry of an indicator series. */
export function latest(series: (number | null)[]): number | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const value = series[i];
    if (isFiniteNumber(value)) return value;
  }
  return null;
}
