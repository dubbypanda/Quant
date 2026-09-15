// Chart data loader for the modal.
//
// As of 3.0 this is an **L1 cache only** — a per-modal memory map that makes
// toggling back to a visited range instant. Durable state lives in the main
// process (`marketCache.ts` / `chartRepository.ts`):
//
//   L1 renderer memory  → miss →  L2 main-process persistent cache  → stale/miss → network
//
// The consequence for this file is that an L1 miss no longer implies network
// I/O, so it must not be treated as expensive. Prefetch is a request to the
// main process rather than a fetch into React state, and refresh cadence
// follows the reported market state instead of running all night.
//
// `generation` is a monotonic counter that bumps on every load (range switch or
// retry). Any async consumer — most importantly the pivot-news pipeline — must
// discard results belonging to an older generation, so switching ranges
// mid-flight never shows stale data.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChartData, ChartRange } from '../../../shared/types';
import { isActiveMarketState } from '../../../shared/marketSession';
import { api } from '../../api';

const ACTIVE_REFRESH_MS = 10_000;
const CLOSED_REFRESH_MS = 60_000;

export interface ChartDataState {
  data: ChartData | null;
  loading: boolean;
  error: string | null;
  /** Bumps on every load; loading state and its resolved data share a value. */
  generation: number;
}

export function useChartData(
  symbol: string,
  range: ChartRange,
): ChartDataState & { retry: () => void; loadOlder: () => Promise<void>; loadingOlder: boolean } {
  const cacheRef = useRef<Map<ChartRange, ChartData>>(new Map());
  const historyRangeRef = useRef<ChartRange>(range);
  const genRef = useRef(0);
  const [attempt, setAttempt] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [state, setState] = useState<ChartDataState>({
    data: null,
    loading: true,
    error: null,
    generation: 0,
  });

  useEffect(() => {
    historyRangeRef.current = range;
    const gen = ++genRef.current;
    const cached = cacheRef.current.get(range);
    if (cached) {
      setState({ data: cached, loading: false, error: null, generation: gen });
      return;
    }
    // Keep the previous canvas alive while the new range resolves. ChartModal
    // marks it as transitional and withholds stale analysis, avoiding a full
    // lightweight-charts teardown/recreate cycle on every range switch.
    setState((current) => ({
      data: current.data,
      loading: true,
      error: null,
      generation: gen,
    }));
    let cancelled = false;
    api
      .getChartV3({ symbol, range, includeExtendedHours: true, refresh: 'cache-first' })
      .then((data) => {
        if (cancelled || gen !== genRef.current) return; // stale response
        cacheRef.current.set(range, data);
        setState({ data, loading: false, error: null, generation: gen });
      })
      .catch((err: unknown) => {
        if (cancelled || gen !== genRef.current) return;
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'The chart request failed.';
        setState((current) => ({
          data: current.data,
          loading: false,
          error: message,
          generation: gen,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, range, attempt]);

  // Warm the next longer range in the main-process cache. This no longer
  // populates L1: the payload would be a duplicate of what L2 already holds,
  // and keeping every visited range resident in the renderer is what made the
  // 2.x cache grow without bound.
  useEffect(() => {
    if (range === 'max') return;
    const next = nextLongerRange(range);
    if (cacheRef.current.has(next)) return;
    const id = window.setTimeout(() => {
      void api.prefetchChartV3(symbol, next).catch(() => undefined);
    }, 700);
    return () => window.clearTimeout(id);
  }, [symbol, range, state.generation]);

  // Refresh only while bars can still arrive. `marketState` comes from the
  // provider via the repository; PREPRE and POSTPOST are dead zones and
  // `isActiveMarketState` excludes them, which is what stops the 2.x behaviour
  // of polling every 15 seconds overnight.
  const marketState = state.data?.marketState;
  useEffect(() => {
    if (range !== '1d' && range !== '1w' && range !== '1m') return;
    const intervalMs = isActiveMarketState(marketState) ? ACTIVE_REFRESH_MS : CLOSED_REFRESH_MS;
    const id = window.setInterval(() => {
      api
        .getChartV3({ symbol, range, includeExtendedHours: true, refresh: 'network-first' })
        .then(
          (fresh) => {
            cacheRef.current.set(range, fresh);
            setState((s) =>
              s.data && s.data.range === range
                ? {
                    data: mergeChartData(s.data, fresh),
                    loading: false,
                    error: null,
                    generation: s.generation + 1,
                  }
                : s,
            );
          },
          () => undefined,
        );
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [symbol, range, marketState]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);

  const loadOlder = useCallback(async () => {
    if (loadingOlder || historyRangeRef.current === 'max') return;
    setLoadingOlder(true);
    try {
      const longer = nextLongerRange(historyRangeRef.current);
      if (longer === historyRangeRef.current) return;
      const cached = cacheRef.current.get(longer);
      const older =
        cached ??
        (await api.getChartV3({
          symbol,
          range: longer,
          includeExtendedHours: true,
          refresh: 'cache-first',
        }));
      cacheRef.current.set(longer, older);
      setState((s) => {
        if (!s.data) return s;
        const merged = mergeChartData(older, s.data);
        if (merged.candles.length <= s.data.candles.length) return s;
        return {
          data: merged,
          loading: false,
          error: null,
          generation: s.generation + 1,
        };
      });
      historyRangeRef.current = longer;
    } finally {
      setLoadingOlder(false);
    }
  }, [loadingOlder, symbol]);

  return { ...state, retry, loadOlder, loadingOlder };
}

function nextLongerRange(range: ChartRange): ChartRange {
  switch (range) {
    case '1d':
      return '1w';
    case '1w':
      return '1m';
    case '1m':
      return '3m';
    case '3m':
      return '6m';
    case '6m':
      return '1y';
    case '1y':
      return '5y';
    case '5y':
      return 'max';
    case 'max':
      return 'max';
  }
}

function mergeChartData(base: ChartData, incoming: ChartData): ChartData {
  const byTime = new Map<number, ChartData['candles'][number]>();
  for (const c of base.candles) byTime.set(c.time, c);
  for (const c of incoming.candles) byTime.set(c.time, c);
  return {
    ...incoming,
    range: incoming.range,
    interval: incoming.interval,
    candles: [...byTime.values()].sort((a, b) => a.time - b.time),
  };
}
