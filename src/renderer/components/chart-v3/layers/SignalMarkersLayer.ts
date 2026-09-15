// Signal marker layer: immutable snapshots → lightweight-charts markers.
//
// Pure on purpose. The layer never reads the live model, only the stored
// snapshots handed to it, which is what makes "changing the current model
// cannot alter an old marker" a property of the type system rather than a
// convention.

import type { SeriesMarker, Time, UTCTimestamp } from 'lightweight-charts';
import type { SignalMarkerModel } from '../model/chartAnnotations';

const TONE_COLORS = {
  bullish: '#2fbf71',
  bearish: '#e8553d',
  neutral: '#7d8798',
  invalidated: '#a875ff',
} as const;

const TONE_SHAPES = {
  bullish: 'arrowUp',
  bearish: 'arrowDown',
  neutral: 'circle',
  invalidated: 'square',
} as const;

export function buildSignalSeriesMarkers(models: SignalMarkerModel[]): SeriesMarker<Time>[] {
  return models
    .map((model) => ({
      time: model.time as UTCTimestamp,
      position: model.position,
      shape: TONE_SHAPES[model.tone],
      color: TONE_COLORS[model.tone],
      // The glyph is text, not only colour, so the direction survives
      // greyscale and high-contrast modes.
      text: model.glyph,
      size: 1 as const,
      id: `signal-${model.id}`,
    }))
    .sort((a, b) => (a.time as number) - (b.time as number));
}

/** Resolves a click on the chart back to the snapshot behind the marker. */
export function findSignalMarkerAt(
  models: SignalMarkerModel[],
  time: number,
): SignalMarkerModel | null {
  return models.find((model) => model.time === time) ?? null;
}
