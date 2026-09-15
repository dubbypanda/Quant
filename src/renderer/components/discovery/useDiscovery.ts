// Discovery data hook.
//
// A run is expensive, so it is never triggered automatically on mount: the page
// shows the last completed run and the user asks for a new one. Hydration
// status is polled only while hydration is actually running.

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DiscoveryEligibilitySettings,
  DiscoveryRunResult,
  UniverseHydrationStatus,
} from '../../../shared/discovery';
import { api } from '../../api';

const HYDRATION_POLL_MS = 3_000;

export interface DiscoveryState {
  result: DiscoveryRunResult | null;
  hydration: UniverseHydrationStatus | null;
  running: boolean;
  error: string | null;
  loading: boolean;
}

export function useDiscovery(): DiscoveryState & {
  run: (settings?: Partial<DiscoveryEligibilitySettings>) => Promise<void>;
  startHydration: () => Promise<void>;
  stopHydration: () => Promise<void>;
} {
  const [state, setState] = useState<DiscoveryState>({
    result: null,
    hydration: null,
    running: false,
    error: null,
    loading: true,
  });
  const pollRef = useRef<number | null>(null);

  const loadLatest = useCallback(async () => {
    try {
      const [result, hydration] = await Promise.all([
        api.getLatestDiscovery(),
        api.getDiscoveryHydrationStatus(),
      ]);
      setState((current) => ({ ...current, result, hydration, loading: false }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'Discovery could not be loaded.',
      }));
    }
  }, []);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Poll only while hydration is running; an idle app should not be asking
  // every three seconds forever.
  useEffect(() => {
    if (!state.hydration?.running) {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current !== null) return;
    pollRef.current = window.setInterval(() => {
      void api
        .getDiscoveryHydrationStatus()
        .then((hydration) => setState((current) => ({ ...current, hydration })))
        .catch(() => undefined);
    }, HYDRATION_POLL_MS);
    return () => {
      if (pollRef.current !== null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [state.hydration?.running]);

  const run = useCallback(
    async (settings?: Partial<DiscoveryEligibilitySettings>) => {
      setState((current) => ({ ...current, running: true, error: null }));
      try {
        const response = await api.runDiscovery(settings);
        if (response.status === 'completed') {
          setState((current) => ({ ...current, result: response.result, running: false }));
          return;
        }
        if (response.status === 'running') {
          // Another run was already in flight; say so rather than appearing to
          // have done nothing.
          setState((current) => ({
            ...current,
            running: true,
            error: 'A scan is already running; its results will appear when it finishes.',
          }));
          return;
        }
        setState((current) => ({ ...current, running: false, error: response.message }));
      } catch (error) {
        setState((current) => ({
          ...current,
          running: false,
          error: error instanceof Error ? error.message : 'The discovery run failed.',
        }));
      }
    },
    [],
  );

  return {
    ...state,
    run,
    startHydration: async () => {
      const hydration = await api.startDiscoveryHydration();
      setState((current) => ({ ...current, hydration }));
    },
    stopHydration: async () => {
      const hydration = await api.stopDiscoveryHydration();
      setState((current) => ({ ...current, hydration }));
    },
  };
}
