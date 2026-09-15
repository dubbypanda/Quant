// Quantifies what the tape did around an event, without claiming the event
// caused the move.
//
// That distinction is the entire design constraint. The output is named
// `reaction`, the benchmark-relative term is `residualReturnPercent`, and UI
// copy is restricted to "Reaction", "Residual move" or "Observed move". A
// single macro print moves everything at once, so an asset return on its own
// says almost nothing about the symbol — which is why the residual, not the
// raw return, is the number worth reading.
//
// Every metric is independently nullable. When bars are missing or timestamps
// cannot be aligned, the answer is null rather than a value interpolated
// across a gap: a fabricated reaction is worse than an absent one, because it
// gets used.

import type { Candle, ChartEventReaction, ChartEventReactionWindow } from './types';

export interface EventReactionInput {
  asset: Candle[];
  benchmark: Candle[];
  /** Unix seconds. */
  eventTime: number;
  window: ChartEventReactionWindow;
  /** The symbol's own baseline volatility in percent, used to normalize the
   *  residual. Null when it could not be measured. */
  baselineVolatilityPercent?: number | null;
}

/** Window lengths in seconds. `session` and `next-session` are expressed as
 *  bar-count horizons instead — see `resolveWindow`. */
const WINDOW_SECONDS: Record<'30m' | '1h', number> = {
  '30m': 30 * 60,
  '1h': 60 * 60,
};

/**
 * The largest gap tolerated between the event and the anchor bar.
 *
 * Without a ceiling, an event with no nearby bars would anchor to whatever bar
 * happens to be closest — possibly days away — and the resulting "reaction"
 * would describe an unrelated move.
 */
const MAX_ANCHOR_GAP_SECONDS = 4 * 24 * 60 * 60;

function isUsable(candle: Candle | undefined): candle is Candle {
  return Boolean(
    candle &&
      Number.isFinite(candle.time) &&
      Number.isFinite(candle.close) &&
      candle.close > 0,
  );
}

/** Index of the last bar at or before `time`, or -1. Assumes ascending time. */
export function indexAtOrBefore(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time <= time) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

/** Index of the first bar at or after `time`, or -1. */
export function indexAtOrAfter(candles: Candle[], time: number): number {
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time >= time) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  return found;
}

function percentReturn(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return null;
  return ((to - from) / from) * 100;
}

interface ResolvedWindow {
  fromIndex: number;
  toIndex: number;
}

/**
 * Picks the anchor and exit bars for one series.
 *
 * The anchor is the last bar at or before the event — the state of the world
 * going in. For a clock window the exit is the last bar inside it; for
 * `session` it is the last bar of the anchor bar's own day; for
 * `next-session` the last bar of the following day with data.
 */
export function resolveWindow(
  candles: Candle[],
  eventTime: number,
  window: ChartEventReactionWindow,
): ResolvedWindow | null {
  if (candles.length < 2) return null;
  const anchor = indexAtOrBefore(candles, eventTime);
  if (anchor < 0) return null;
  if (eventTime - candles[anchor].time > MAX_ANCHOR_GAP_SECONDS) return null;

  if (window === '30m' || window === '1h') {
    const deadline = eventTime + WINDOW_SECONDS[window];
    let exit = anchor;
    for (let i = anchor + 1; i < candles.length && candles[i].time <= deadline; i++) {
      exit = i;
    }
    // No bar printed inside the window: a clock window cannot be answered from
    // the anchor alone.
    if (exit === anchor) return null;
    return { fromIndex: anchor, toIndex: exit };
  }

  const dayOf = (index: number) => Math.floor(candles[index].time / 86_400);
  const anchorDay = dayOf(anchor);

  if (window === 'session') {
    let exit = anchor;
    for (let i = anchor + 1; i < candles.length && dayOf(i) === anchorDay; i++) exit = i;
    if (exit === anchor) {
      // Daily bars: the anchor bar *is* the session, so measure it close over
      // close against the prior bar.
      if (anchor === 0) return null;
      return { fromIndex: anchor - 1, toIndex: anchor };
    }
    return { fromIndex: anchor, toIndex: exit };
  }

  // next-session: the first day strictly after the anchor day that has bars.
  let nextDayStart = -1;
  for (let i = anchor + 1; i < candles.length; i++) {
    if (dayOf(i) > anchorDay) {
      nextDayStart = i;
      break;
    }
  }
  if (nextDayStart < 0) return null;
  const nextDay = dayOf(nextDayStart);
  let exit = nextDayStart;
  for (let i = nextDayStart + 1; i < candles.length && dayOf(i) === nextDay; i++) exit = i;
  return { fromIndex: anchor, toIndex: exit };
}

const NULL_METRICS = {
  assetReturnPercent: null,
  benchmarkReturnPercent: null,
  residualReturnPercent: null,
  normalizedShock: null,
} as const;

/**
 * Computes the reaction.
 *
 * The benchmark is measured over the *same timestamps* as the asset, not over
 * its own independently resolved window — otherwise a benchmark with a
 * different bar grid would be compared across a different span, and the
 * residual would be an artefact of the grids rather than of the move.
 */
export function calculateEventReaction(input: EventReactionInput): ChartEventReaction {
  const { window } = input;
  const asset = (input.asset ?? []).filter(isUsable);
  const benchmark = (input.benchmark ?? []).filter(isUsable);

  const assetWindow = resolveWindow(asset, input.eventTime, window);
  if (!assetWindow) return { ...NULL_METRICS, reactionWindow: window };

  const assetFrom = asset[assetWindow.fromIndex];
  const assetTo = asset[assetWindow.toIndex];
  const assetReturnPercent = percentReturn(assetFrom.close, assetTo.close);
  if (assetReturnPercent === null) return { ...NULL_METRICS, reactionWindow: window };

  // Align the benchmark to the asset's own window timestamps.
  let benchmarkReturnPercent: number | null = null;
  if (benchmark.length >= 2) {
    const benchFrom = indexAtOrBefore(benchmark, assetFrom.time);
    const benchTo = indexAtOrBefore(benchmark, assetTo.time);
    if (
      benchFrom >= 0 &&
      benchTo > benchFrom &&
      assetFrom.time - benchmark[benchFrom].time <= MAX_ANCHOR_GAP_SECONDS &&
      assetTo.time - benchmark[benchTo].time <= MAX_ANCHOR_GAP_SECONDS
    ) {
      benchmarkReturnPercent = percentReturn(
        benchmark[benchFrom].close,
        benchmark[benchTo].close,
      );
    }
  }

  const residualReturnPercent =
    benchmarkReturnPercent === null ? null : assetReturnPercent - benchmarkReturnPercent;

  // A zero or missing baseline cannot normalize anything. Dividing by it would
  // produce Infinity, which downstream would render as a spectacular shock.
  const baseline = input.baselineVolatilityPercent;
  const normalizedShock =
    residualReturnPercent !== null &&
    typeof baseline === 'number' &&
    Number.isFinite(baseline) &&
    baseline > 0
      ? residualReturnPercent / baseline
      : null;

  return {
    assetReturnPercent,
    benchmarkReturnPercent,
    residualReturnPercent,
    normalizedShock,
    reactionWindow: window,
  };
}

/**
 * Baseline volatility for normalization: standard deviation of the most recent
 * `lookback` bar-over-bar percent returns.
 *
 * Returns null rather than 0 for a flat series, so `calculateEventReaction`
 * reports "not normalizable" instead of dividing by zero.
 */
export function baselineVolatilityPercent(candles: Candle[], lookback = 20): number | null {
  const usable = candles.filter(isUsable).slice(-(lookback + 1));
  if (usable.length < 3) return null;
  const returns: number[] = [];
  for (let i = 1; i < usable.length; i++) {
    const value = percentReturn(usable[i - 1].close, usable[i].close);
    if (value !== null) returns.push(value);
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((sum, v) => sum + v, 0) / returns.length;
  const variance =
    returns.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (returns.length - 1);
  const stdev = Math.sqrt(variance);
  return stdev > 0 && Number.isFinite(stdev) ? stdev : null;
}

/** Non-causal UI copy. Centralised so no surface can reach for "impact". */
export const REACTION_WINDOW_LABELS: Record<ChartEventReactionWindow, string> = {
  '30m': 'Reaction, 30 minutes',
  '1h': 'Reaction, 1 hour',
  session: 'Observed move, same session',
  'next-session': 'Observed move, next session',
};

export const RESIDUAL_MOVE_CAPTION =
  'Residual move is the symbol return less the benchmark return over the same window. It describes what happened, not what the event caused.';
