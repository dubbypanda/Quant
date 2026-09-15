// Estimated volume-at-price, ported from the Quantactic iOS engine
// (`VolumeProfileEngine.swift` / `PriceAcceptanceEngine.swift`).
//
// The rule this module exists to enforce: price being above a level is not a
// breakout. Price *holding* above it is. Quant's existing engine has no
// concept of acceptance at all, which is why a single bar poking through the
// prior high could set the whole conclusion.
//
// Every profile here is an approximation built from OHLCV bars, never from
// exchange tick data — `isApproximation` is carried through so no surface can
// describe it as true volume-at-price.

import type { Candle } from './types';

export interface VolumeProfileBin {
  low: number;
  high: number;
  mid: number;
  volume: number;
}

export interface VolumeProfile {
  bins: VolumeProfileBin[];
  pointOfControl: number;
  valueAreaHigh: number;
  valueAreaLow: number;
  totalVolume: number;
  valueAreaVolumeShare: number;
  /** Bars that contributed, after filtering unusable ones. */
  barCount: number;
  isApproximation: true;
}

export type PriceAcceptanceState =
  /** Holding above the value area on completed closes. */
  | 'accepted-above-value'
  /** Traded above the value area and fell back inside it. */
  | 'rejected-above-value'
  /** Trading inside the value area, near fair price. */
  | 'balanced-in-value'
  /** Reclaimed the point of control from below. */
  | 'reclaimed-control'
  /** Lost the point of control from above. */
  | 'lost-control'
  /** Traded below the value area and recovered back inside it. */
  | 'rejected-below-value'
  /** Holding below the value area on completed closes. */
  | 'accepted-below-value'
  | 'unavailable';

export function isConstructiveAcceptance(state: PriceAcceptanceState): boolean {
  return state === 'accepted-above-value' || state === 'reclaimed-control';
}

export function isDestructiveAcceptance(state: PriceAcceptanceState): boolean {
  return state === 'accepted-below-value' || state === 'lost-control';
}

/** Balance and both rejection states are genuinely two-sided: a high-volume
 *  area is a magnet, not a direction. */
export function isTwoSidedAcceptance(state: PriceAcceptanceState): boolean {
  return (
    state === 'balanced-in-value' ||
    state === 'rejected-above-value' ||
    state === 'rejected-below-value'
  );
}

export interface PriceAcceptanceEvidence {
  state: PriceAcceptanceState;
  currentPrice: number;
  valueAreaHigh: number | null;
  pointOfControl: number | null;
  valueAreaLow: number | null;
  /** Trailing consecutive completed closes beyond the nearer boundary. */
  closesBeyondBoundary: number;
  relativeVolume: number | null;
  barCount: number;
  isApproximation: boolean;
}

export function unavailableAcceptance(currentPrice: number): PriceAcceptanceEvidence {
  return {
    state: 'unavailable',
    currentPrice,
    valueAreaHigh: null,
    pointOfControl: null,
    valueAreaLow: null,
    closesBeyondBoundary: 0,
    relativeVolume: null,
    barCount: 0,
    isApproximation: true,
  };
}

export function isMeasuredAcceptance(evidence: PriceAcceptanceEvidence | null | undefined): boolean {
  return Boolean(evidence) && evidence!.state !== 'unavailable';
}

/** A breakout is confirmed by acceptance, never by price printing through a level. */
export function confirmsUpsideBreakout(evidence: PriceAcceptanceEvidence): boolean {
  return evidence.state === 'accepted-above-value';
}

/** The mirror case for a breakdown. */
export function confirmsDownsideBreakdown(evidence: PriceAcceptanceEvidence): boolean {
  return evidence.state === 'accepted-below-value';
}

export interface PriceAcceptanceConfig {
  /** Trailing bars included in the composite profile. */
  windowBars: number;
  /** Usable bars required before a profile is attempted at all. */
  minimumBars: number;
  /** Price bins across the profile range. */
  binCount: number;
  /** Share of total profile volume that defines the value area. */
  valueAreaShare: number;
  /** Completed closes required beyond a boundary. One tick through is not acceptance. */
  requiredCloses: number;
  /** Minimum distance beyond the boundary, in ATR, so a level price is merely
   *  resting on does not count. */
  minimumAtrDistance: number;
  /** Minimum participation behind the move. */
  minimumRelativeVolume: number;
  /** Inside this distance from the point of control, in ATR, the reading is
   *  balanced regardless of which side price is on. */
  balanceAtrDistance: number;
}

/** Daily bars. 60 sessions is a quarter — long enough for a value area to mean
 *  something, short enough that it still describes the current market. */
export const DAILY_ACCEPTANCE_CONFIG: PriceAcceptanceConfig = {
  windowBars: 60,
  minimumBars: 20,
  binCount: 48,
  valueAreaShare: 0.7,
  requiredCloses: 2,
  minimumAtrDistance: 0.15,
  minimumRelativeVolume: 1.1,
  balanceAtrDistance: 0.3,
};

/** Intraday bars: roughly five regular sessions of hourly candles. Callers with
 *  finer bars should pre-slice with `recentSessionBars`. */
export const INTRADAY_ACCEPTANCE_CONFIG: PriceAcceptanceConfig = {
  ...DAILY_ACCEPTANCE_CONFIG,
  windowBars: 5 * 7,
};

/** The bars belonging to the most recent `sessions` UTC-day groups present in
 *  the data. For intraday series, where "5 sessions" is the meaningful window
 *  rather than a fixed bar count. */
export function recentSessionBars(candles: Candle[], sessions: number): Candle[] {
  if (sessions <= 0 || !candles.length) return [];
  const byDay = new Map<number, Candle[]>();
  for (const candle of candles) {
    const day = Math.floor(candle.time / 86_400);
    const bucket = byDay.get(day);
    if (bucket) bucket.push(candle);
    else byDay.set(day, [candle]);
  }
  const days = [...byDay.keys()].sort((a, b) => a - b).slice(-sessions);
  return days
    .flatMap((day) => byDay.get(day) ?? [])
    .sort((a, b) => a.time - b.time);
}

function usableBars(candles: Candle[], config: PriceAcceptanceConfig): Candle[] {
  return candles
    .slice(-config.windowBars)
    .filter(
      (c) =>
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        c.high >= c.low &&
        Number.isFinite(c.volume) &&
        c.volume > 0,
    );
}

/**
 * Builds an estimated volume-at-price distribution.
 *
 * Each bar's volume is spread across the price range it actually traded
 * through, proportional to overlap, rather than being dumped on the close —
 * assigning a bar's whole volume to its closing price is what makes naive
 * profiles a picture of closes instead of a picture of participation.
 */
export function buildVolumeProfile(
  candles: Candle[],
  config: PriceAcceptanceConfig = DAILY_ACCEPTANCE_CONFIG,
): VolumeProfile | null {
  const usable = usableBars(candles, config);
  if (usable.length < config.minimumBars || config.binCount < 2) return null;

  let profileLow = Infinity;
  let profileHigh = -Infinity;
  for (const candle of usable) {
    if (candle.low < profileLow) profileLow = candle.low;
    if (candle.high > profileHigh) profileHigh = candle.high;
  }
  const span = profileHigh - profileLow;
  if (!(profileLow > 0) || !(span > 0)) return null;

  const binWidth = span / config.binCount;
  if (!(binWidth > 0)) return null;

  const binIndex = (price: number): number => {
    const raw = Math.floor((price - profileLow) / binWidth);
    return Math.min(config.binCount - 1, Math.max(0, raw));
  };

  const volumes = new Array<number>(config.binCount).fill(0);
  for (const candle of usable) {
    const range = candle.high - candle.low;
    if (!(range > 0)) {
      // A bar that never moved still traded: give it the bin it sat in.
      volumes[binIndex(candle.close)] += candle.volume;
      continue;
    }
    const firstBin = binIndex(candle.low);
    const lastBin = binIndex(candle.high);
    for (let bin = firstBin; bin <= lastBin; bin++) {
      const binLow = profileLow + bin * binWidth;
      const overlap = Math.min(candle.high, binLow + binWidth) - Math.max(candle.low, binLow);
      if (overlap > 0) volumes[bin] += candle.volume * (overlap / range);
    }
  }

  const totalVolume = volumes.reduce((sum, v) => sum + v, 0);
  if (!(totalVolume > 0)) return null;

  const bins: VolumeProfileBin[] = volumes.map((volume, index) => {
    const low = profileLow + index * binWidth;
    const high = low + binWidth;
    return { low, high, mid: (low + high) / 2, volume };
  });

  // Highest-volume bin. Ties resolve to the lower bin so the result is
  // deterministic rather than dependent on iteration order.
  let pocIndex = -1;
  let pocVolume = -1;
  for (let i = 0; i < volumes.length; i++) {
    if (volumes[i] > pocVolume) {
      pocVolume = volumes[i];
      pocIndex = i;
    }
  }
  if (pocIndex < 0 || !(pocVolume > 0)) return null;

  // Expand outward from the point of control, always taking the heavier
  // neighbour, until the configured share of volume is enclosed. Contiguous by
  // construction. Ties expand upward first, again for determinism.
  let lower = pocIndex;
  let upper = pocIndex;
  let enclosed = volumes[pocIndex];
  const target = totalVolume * config.valueAreaShare;
  while (enclosed < target && (lower > 0 || upper < volumes.length - 1)) {
    const below = lower > 0 ? volumes[lower - 1] : -1;
    const above = upper < volumes.length - 1 ? volumes[upper + 1] : -1;
    if (above >= below) {
      upper += 1;
      enclosed += volumes[upper];
    } else {
      lower -= 1;
      enclosed += volumes[lower];
    }
  }

  return {
    bins,
    pointOfControl: bins[pocIndex].mid,
    valueAreaHigh: bins[upper].high,
    valueAreaLow: bins[lower].low,
    totalVolume,
    valueAreaVolumeShare: enclosed / totalVolume,
    barCount: usable.length,
    isApproximation: true,
  };
}

/** Trailing consecutive completed closes beyond a boundary. */
export function closesBeyond(boundary: number, above: boolean, completed: Candle[]): number {
  let count = 0;
  for (let i = completed.length - 1; i >= 0; i--) {
    const beyond = above ? completed[i].close > boundary : completed[i].close < boundary;
    if (!beyond) break;
    count += 1;
  }
  return count;
}

/**
 * Drops a bar that has not closed yet, inferring the interval from the last two
 * timestamps. Acceptance is only ever judged on completed candles, which is
 * what stops a conclusion from flapping inside a single bar.
 */
export function completedCandles(candles: Candle[], nowSeconds = Math.floor(Date.now() / 1000)): Candle[] {
  const last = candles[candles.length - 1];
  if (!last) return [];
  let interval = 3600;
  if (candles.length >= 2) {
    const diff = last.time - candles[candles.length - 2].time;
    if (diff > 0 && diff <= 86_400) interval = diff;
  }
  return last.time + interval <= nowSeconds ? candles : candles.slice(0, -1);
}

/** All three conditions, deliberately: closes, distance, participation. */
function isAccepted(args: {
  boundary: number;
  above: boolean;
  price: number;
  completed: Candle[];
  atr: number | null;
  relativeVolume: number | null;
  config: PriceAcceptanceConfig;
}): boolean {
  const { boundary, above, price, completed, atr, relativeVolume, config } = args;
  if (closesBeyond(boundary, above, completed) < config.requiredCloses) return false;
  if (atr === null || !Number.isFinite(atr) || atr <= 0) return false;
  const distance = above ? price - boundary : boundary - price;
  if (distance < config.minimumAtrDistance * atr) return false;
  // Participation is required when it can be measured; a move nobody traded is
  // not acceptance.
  if (
    relativeVolume === null ||
    !Number.isFinite(relativeVolume) ||
    relativeVolume < config.minimumRelativeVolume
  ) {
    return false;
  }
  return true;
}

function insideValueState(args: {
  price: number;
  profile: VolumeProfile;
  completed: Candle[];
  atr: number | null;
  config: PriceAcceptanceConfig;
}): PriceAcceptanceState {
  const { price, profile, completed, atr, config } = args;
  const previousClose = completed[completed.length - 1]?.close;
  if (atr === null || !(atr > 0) || !Number.isFinite(previousClose)) return 'balanced-in-value';
  // Inside the value area the only directional reading worth making is a clean
  // move through the point of control. Anything closer than the balance
  // distance is a magnet, not a direction.
  const clearance = config.balanceAtrDistance * atr;
  if (price > profile.pointOfControl + clearance && previousClose! <= profile.pointOfControl) {
    return 'reclaimed-control';
  }
  if (price < profile.pointOfControl - clearance && previousClose! >= profile.pointOfControl) {
    return 'lost-control';
  }
  return 'balanced-in-value';
}

export interface PriceAcceptanceInput {
  candles: Candle[];
  currentPrice: number;
  atr: number | null;
  relativeVolume: number | null;
  config?: PriceAcceptanceConfig;
  nowSeconds?: number;
}

/** Measures where price sits relative to the area the market has been trading
 *  in, and whether that position has been accepted or rejected. */
export function measurePriceAcceptance(input: PriceAcceptanceInput): PriceAcceptanceEvidence {
  const config = input.config ?? DAILY_ACCEPTANCE_CONFIG;
  const { currentPrice } = input;
  if (!(currentPrice > 0)) return unavailableAcceptance(currentPrice);

  const profile = buildVolumeProfile(input.candles, config);
  if (!profile) return unavailableAcceptance(currentPrice);

  const completed = completedCandles(input.candles, input.nowSeconds);
  const above = currentPrice >= profile.valueAreaHigh;
  const boundary = above ? profile.valueAreaHigh : profile.valueAreaLow;

  let state: PriceAcceptanceState;
  if (currentPrice > profile.valueAreaHigh) {
    state = isAccepted({
      boundary: profile.valueAreaHigh,
      above: true,
      price: currentPrice,
      completed,
      atr: input.atr,
      relativeVolume: input.relativeVolume,
      config,
    })
      ? 'accepted-above-value'
      : // Probed above value without holding it. Not a breakout yet.
        'rejected-above-value';
  } else if (currentPrice < profile.valueAreaLow) {
    state = isAccepted({
      boundary: profile.valueAreaLow,
      above: false,
      price: currentPrice,
      completed,
      atr: input.atr,
      relativeVolume: input.relativeVolume,
      config,
    })
      ? 'accepted-below-value'
      : 'rejected-below-value';
  } else {
    state = insideValueState({
      price: currentPrice,
      profile,
      completed,
      atr: input.atr,
      config,
    });
  }

  return {
    state,
    currentPrice,
    valueAreaHigh: profile.valueAreaHigh,
    pointOfControl: profile.pointOfControl,
    valueAreaLow: profile.valueAreaLow,
    closesBeyondBoundary: closesBeyond(boundary, above, completed),
    relativeVolume: input.relativeVolume,
    barCount: profile.barCount,
    isApproximation: profile.isApproximation,
  };
}
