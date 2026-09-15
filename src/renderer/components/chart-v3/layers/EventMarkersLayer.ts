// Event marker layer: quiet, neutral markers on the time axis.
//
// Design constraint from docs/quant-v3/02 section 8: markers are deliberately
// understated. One small neutral glyph, no full labels over candles by default,
// and a collision stack when several events land in the same pixel bucket —
// which the caller has already produced via `clusterByPixelBucket`.

import type { SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import type { EventMarkerModel } from '../model/chartAnnotations';

const EVENT_COLOR = '#9aa6bd';

export interface EventMarkerLayerOptions {
  /** Below this width per marker, glyph text is dropped and only the tick
   *  shows — a label that overlaps its neighbour is worse than no label. */
  showGlyphs: boolean;
}

export function buildEventSeriesMarkers(
  models: EventMarkerModel[],
  options: EventMarkerLayerOptions = { showGlyphs: true },
): SeriesMarker<Time>[] {
  return models
    .map((model) => ({
      time: model.time as UTCTimestamp,
      position: 'belowBar' as const,
      shape: 'circle' as const,
      color: EVENT_COLOR,
      text: options.showGlyphs ? model.glyph : undefined,
      size: 1 as const,
      id: `event-${model.id}`,
    }))
    .sort((a, b) => (a.time as number) - (b.time as number));
}

/**
 * Whether there is room for glyph text.
 *
 * Roughly 34 pixels per label is the point at which four-character glyphs like
 * `FOMC` stop colliding at the default font size.
 */
export function shouldShowEventGlyphs(markerCount: number, pixelWidth: number): boolean {
  if (markerCount === 0) return false;
  return pixelWidth / markerCount >= 34;
}

export function findEventMarkerAt(
  models: EventMarkerModel[],
  time: number,
): EventMarkerModel | null {
  return models.find((model) => model.time === time) ?? null;
}
