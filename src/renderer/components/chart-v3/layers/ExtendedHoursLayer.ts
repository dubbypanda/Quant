// Extended-hours rendering: session bands and per-bar emphasis.
//
// Two rules this layer exists to keep:
//   * no second y-axis — pre/post bars are the same instrument at the same
//     scale, and splitting the axis would imply otherwise;
//   * no artificial bars for session gaps — a symbol that does not trade
//     pre-market gets no band, not a flat synthetic run.

import type { Candle, MarketSession } from '../../../../shared/types';
import type { SessionBand } from '../model/annotationLayout';

/** Background tints for the session bands. Low alpha: this is context behind
 *  the price, not a foreground element competing with it. */
export const SESSION_BAND_COLORS: Record<SessionBand['session'], string> = {
  pre: 'rgba(84, 198, 235, 0.07)',
  regular: 'transparent',
  post: 'rgba(168, 117, 255, 0.07)',
};

/** Only the extended windows get shading; the regular session is the baseline
 *  and tinting it would make the whole chart a wash. */
export function visibleSessionBands(bands: SessionBand[]): SessionBand[] {
  return bands.filter((band) => band.session !== 'regular');
}

/**
 * Per-bar opacity.
 *
 * Extended-hours bars are real trades on thin volume, so they are shown at
 * reduced emphasis rather than hidden: dropping them would make a gap-up look
 * like it came from nowhere.
 */
export function sessionBarOpacity(session: MarketSession | undefined): number {
  switch (session) {
    case 'pre':
    case 'post':
      return 0.55;
    case 'closed':
      return 0.35;
    default:
      return 1;
  }
}

/** Whether the extended-hours layer is meaningful for this interval. Daily and
 *  longer bars aggregate whole sessions, so there is nothing to distinguish. */
export function supportsExtendedHours(interval: string): boolean {
  return /m$|h$/.test(interval) && interval !== '1mo';
}

/**
 * Whether any extended-hours bars are actually present.
 *
 * The toolbar toggle is hidden when there are none: an enabled control that
 * changes nothing reads as broken.
 */
export function hasExtendedHoursBars(candles: Candle[]): boolean {
  return candles.some((candle) => candle.session === 'pre' || candle.session === 'post');
}

/** Default toggle state per range, per section 4: on for 1D and 1W, irrelevant
 *  for daily ranges. */
export function defaultExtendedHoursEnabled(range: string): boolean {
  return range === '1d' || range === '1w';
}
