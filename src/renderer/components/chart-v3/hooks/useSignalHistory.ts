// Loads immutable signal snapshots for the marker layer.
//
// Snapshots are read, never recomputed. The hook deliberately exposes no way to
// refresh a record from the current model: that would turn history into a live
// view and defeat the contract the store exists to keep.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle, HistoricalSignalSnapshot } from '../../../../shared/types';
import { api } from '../../../api';
import {
  clusterByPixelBucket,
  filterToVisibleRange,
  type VisibleRange,
} from '../model/annotationLayout';
import { buildSignalMarker, type SignalMarkerModel } from '../model/chartAnnotations';

export interface SignalHistoryState {
  snapshots: HistoricalSignalSnapshot[];
  loading: boolean;
  error: string | null;
}

export function useSignalHistory(
  symbol: string,
  candles: Candle[],
  enabled: boolean,
): SignalHistoryState {
  const [state, setState] = useState<SignalHistoryState>({
    snapshots: [],
    loading: false,
    error: null,
  });
  const requestRef = useRef(0);

  const first = candles[0]?.time;
  const last = candles[candles.length - 1]?.time;

  useEffect(() => {
    if (!enabled || !symbol) {
      setState({ snapshots: [], loading: false, error: null });
      return;
    }
    const generation = ++requestRef.current;
    setState((current) => ({ ...current, loading: true, error: null }));
    let cancelled = false;
    api
      .getSignalHistory(symbol, first, last)
      .then((snapshots) => {
        if (cancelled || generation !== requestRef.current) return;
        setState({ snapshots, loading: false, error: null });
      })
      .catch((error: unknown) => {
        if (cancelled || generation !== requestRef.current) return;
        setState({
          snapshots: [],
          loading: false,
          error: error instanceof Error ? error.message : 'Signal history could not be loaded.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, first, last, enabled]);

  return state;
}

export function useSignalMarkers(
  snapshots: HistoricalSignalSnapshot[],
  visibleRange: VisibleRange | null,
  pixelWidth: number,
  showAllDecisions: boolean,
): SignalMarkerModel[] {
  return useMemo(() => {
    if (!snapshots.length) return [];
    const positioned = snapshots.map((snapshot) => ({
      time: snapshot.signalBarTime,
      snapshot,
    }));
    const visible = filterToVisibleRange(positioned, visibleRange);
    // A cluster keeps the most recent snapshot's marker: when two signals share
    // a pixel, the later one is the live thesis.
    return clusterByPixelBucket(visible, visibleRange, pixelWidth)
      .map((cluster) => {
        const latest = cluster.records[cluster.records.length - 1];
        return buildSignalMarker(latest.snapshot, showAllDecisions);
      })
      .filter((marker): marker is SignalMarkerModel => marker !== null);
  }, [snapshots, visibleRange, pixelWidth, showAllDecisions]);
}
