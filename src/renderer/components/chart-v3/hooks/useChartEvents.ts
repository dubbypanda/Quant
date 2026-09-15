// Loads chart events for the visible symbol and range.
//
// Events are fetched for the whole loaded series once and then filtered in
// memory as the viewport moves: the macro calendar is small, and refetching on
// every pan would make scrolling feel like network latency.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, ChartEventKind, ChartEventRecord } from '../../../../shared/types';
import { api } from '../../../api';
import {
  clusterByPixelBucket,
  filterToVisibleRange,
  snapEventToBar,
  type VisibleRange,
} from '../model/annotationLayout';
import { buildEventMarker, type EventMarkerModel } from '../model/chartAnnotations';

export interface ChartEventsState {
  events: ChartEventRecord[];
  loading: boolean;
  error: string | null;
}

function isoDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function useChartEvents(
  symbol: string,
  candles: Candle[],
  enabled: boolean,
): ChartEventsState {
  const [state, setState] = useState<ChartEventsState>({
    events: [],
    loading: false,
    error: null,
  });
  const requestRef = useRef(0);

  const first = candles[0]?.time;
  const last = candles[candles.length - 1]?.time;

  useEffect(() => {
    if (!enabled || !symbol || first === undefined || last === undefined) {
      setState({ events: [], loading: false, error: null });
      return;
    }
    const generation = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    let cancelled = false;
    api
      .getChartEvents({ symbol, from: isoDate(first), to: isoDate(last) })
      .then((events) => {
        if (cancelled || generation !== requestRef.current) return;
        setState({ events, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== requestRef.current) return;
        setState({
          events: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Events could not be loaded.',
        });
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the series bounds rather than the array identity: a refresh that
    // appends one live bar must not refetch the whole calendar.
  }, [symbol, first, last, enabled]);

  return state;
}

/**
 * Turns records into the markers the chart should actually draw.
 *
 * Order matters for performance: filter to the viewport first, then cluster.
 * Clustering the full set and filtering afterwards would do the expensive work
 * on every event in history.
 */
export function useEventMarkers(
  events: ChartEventRecord[],
  candles: Candle[],
  visibleRange: VisibleRange | null,
  pixelWidth: number,
  enabledKinds: ChartEventKind[],
): EventMarkerModel[] {
  return useMemo(() => {
    if (!events.length || !candles.length) return [];
    const allowed = new Set(enabledKinds);
    const positioned = events
      .filter((event) => allowed.has(event.kind))
      .map((event) => {
        const stamp = Date.parse(event.occurredAt ?? event.scheduledAt);
        if (!Number.isFinite(stamp)) return null;
        const time = snapEventToBar(candles, Math.floor(stamp / 1000));
        return time === null ? null : { time, event };
      })
      .filter((item): item is { time: number; event: ChartEventRecord } => item !== null);

    const visible = filterToVisibleRange(positioned, visibleRange);
    return clusterByPixelBucket(visible, visibleRange, pixelWidth)
      .map((cluster) => buildEventMarker(cluster.time, cluster.records.map((item) => item.event)))
      .filter((marker): marker is EventMarkerModel => marker !== null);
  }, [events, candles, visibleRange, pixelWidth, enabledKinds]);
}
