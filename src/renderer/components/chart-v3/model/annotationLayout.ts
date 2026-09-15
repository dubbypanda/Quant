// Pure geometry for chart annotations: session bands, viewport filtering, and
// collision stacking for markers.
//
// The performance rule from docs/quant-v3/02 lives here: range filtering runs
// *before* anything reaches the chart renderer. A fixture with a thousand
// events must not put a thousand markers into lightweight-charts, because
// pointer interaction degrades long before the pixels do.

import type { Candle, ChartEventRecord, MarketSession } from '../../../../shared/types';

export interface SessionBand {
  session: 'pre' | 'regular' | 'post';
  /** Unix seconds, inclusive. */
  from: number;
  /** Unix seconds, inclusive — the last bar in the run, not a synthetic edge. */
  to: number;
}

const BANDED: ReadonlySet<MarketSession> = new Set<MarketSession>(['pre', 'regular', 'post']);

/**
 * Contiguous runs of same-session bars.
 *
 * Bounds come from bars that actually exist, so a session gap (a halt, a
 * holiday, a symbol that does not trade pre-market) simply produces no band.
 * Extending a band across a gap would draw shading over time when nothing
 * traded.
 */
export function buildSessionBands(candles: Candle[]): SessionBand[] {
  const bands: SessionBand[] = [];
  let current: SessionBand | null = null;
  for (const candle of candles) {
    const session = candle.session;
    if (!session || !BANDED.has(session)) {
      current = null;
      continue;
    }
    const banded = session as SessionBand['session'];
    if (current && current.session === banded) {
      current.to = candle.time;
      continue;
    }
    current = { session: banded, from: candle.time, to: candle.time };
    bands.push(current);
  }
  return bands;
}

/** Session boundaries where bars exist on both sides — the 09:30 and 16:00
 *  dividers. Returns the time of the first bar of the new session. */
export function buildSessionDividers(candles: Candle[]): Array<{ time: number; session: SessionBand['session'] }> {
  const dividers: Array<{ time: number; session: SessionBand['session'] }> = [];
  for (let i = 1; i < candles.length; i++) {
    const previous = candles[i - 1].session;
    const next = candles[i].session;
    if (!previous || !next || previous === next) continue;
    if (!BANDED.has(next)) continue;
    dividers.push({ time: candles[i].time, session: next as SessionBand['session'] });
  }
  return dividers;
}

export interface VisibleRange {
  from: number;
  to: number;
}

export interface TimedRecord {
  time: number;
}

/** Records inside the visible range, with a small margin so a marker does not
 *  pop in only once fully on-screen. */
export function filterToVisibleRange<T extends TimedRecord>(
  records: T[],
  range: VisibleRange | null,
  marginFraction = 0.05,
): T[] {
  if (!range || !Number.isFinite(range.from) || !Number.isFinite(range.to)) return records;
  const span = Math.max(0, range.to - range.from);
  const margin = span * marginFraction;
  const from = range.from - margin;
  const to = range.to + margin;
  return records.filter((record) => record.time >= from && record.time <= to);
}

export interface MarkerCluster<T extends TimedRecord> {
  /** Representative time for the cluster: the earliest record in it. */
  time: number;
  records: T[];
}

/**
 * Groups records that would land in the same pixel bucket.
 *
 * Two events an hour apart on a five-year chart are the same pixel; drawing two
 * markers there produces an unreadable smear and two overlapping hit targets.
 * The cluster keeps every record so the inspector can still list them all.
 */
export function clusterByPixelBucket<T extends TimedRecord>(
  records: T[],
  range: VisibleRange | null,
  pixelWidth: number,
  minimumPixelSeparation = 14,
): Array<MarkerCluster<T>> {
  const sorted = [...records].sort((a, b) => a.time - b.time);
  if (!sorted.length) return [];
  if (!range || !(pixelWidth > 0) || range.to <= range.from) {
    return sorted.map((record) => ({ time: record.time, records: [record] }));
  }
  const secondsPerPixel = (range.to - range.from) / pixelWidth;
  const bucketSeconds = Math.max(1, secondsPerPixel * minimumPixelSeparation);

  const clusters: Array<MarkerCluster<T>> = [];
  for (const record of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && record.time - last.time <= bucketSeconds) {
      last.records.push(record);
      continue;
    }
    clusters.push({ time: record.time, records: [record] });
  }
  return clusters;
}

/** Default event categories shown without opening layer settings. Everything
 *  else is available but off, so the chart is not a wall of glyphs. */
export const DEFAULT_VISIBLE_EVENT_KINDS: ChartEventRecord['kind'][] = [
  'fomc',
  'cpi',
  'pce',
  'payrolls',
  'earnings',
];

/** Snaps an event to the bar it should be drawn on: the last bar at or before
 *  it. Returns null when the event predates the series, so nothing is drawn
 *  clamped to the left edge where it would imply a bar that does not exist. */
export function snapEventToBar(
  candles: Candle[],
  eventUnixSeconds: number,
): number | null {
  if (!candles.length) return null;
  let low = 0;
  let high = candles.length - 1;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (candles[mid].time <= eventUnixSeconds) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found < 0 ? null : candles[found].time;
}
