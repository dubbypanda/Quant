// Versioned chart workspace preferences, persisted to local storage.
//
// The migration rule from docs/quant-v3/02 section 11: migrate an old
// preference only when the mapping is obvious, otherwise keep the 3.0 default.
// Silently mapping an unrelated 2.x control onto a new one produces a workspace
// the user never configured and cannot explain.

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ChartEventKind } from '../../../../shared/types';
import { DEFAULT_VISIBLE_EVENT_KINDS } from '../model/annotationLayout';

export type InspectorTab = 'overview' | 'signal' | 'events' | 'forecast' | 'position';

export interface ChartWorkspacePreferencesV3 {
  version: 3;
  showExtendedHours: boolean;
  showSignals: boolean;
  showAllSignalDecisions: boolean;
  showEvents: boolean;
  eventKinds: ChartEventKind[];
  showForecast: boolean;
  movingAverages: Array<20 | 50 | 200>;
  logScale: boolean;
  inspectorTab: InspectorTab;
}

export const WORKSPACE_STORAGE_KEY = 'quant.chart-workspace.v3';
/** The 2.x key, read once for the migration and then left alone. */
export const LEGACY_OVERLAY_STORAGE_KEY = 'quant.chart-overlays.v2';

export const DEFAULT_WORKSPACE_PREFERENCES: ChartWorkspacePreferencesV3 = {
  version: 3,
  showExtendedHours: true,
  showSignals: true,
  // Off by default: WAIT and NO TRADE markers outnumber candidates and would
  // bury them.
  showAllSignalDecisions: false,
  showEvents: true,
  eventKinds: [...DEFAULT_VISIBLE_EVENT_KINDS],
  showForecast: false,
  movingAverages: [20, 50],
  logScale: false,
  inspectorTab: 'overview',
};

const INSPECTOR_TABS: InspectorTab[] = ['overview', 'signal', 'events', 'forecast', 'position'];
const MOVING_AVERAGES: Array<20 | 50 | 200> = [20, 50, 200];

function boolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Coerces stored JSON to the current shape.
 *
 * Every field is validated individually so one corrupted entry does not discard
 * the whole workspace — losing a user's layout because an enum gained a value
 * is a worse outcome than falling back on that single field.
 */
export function coerceWorkspacePreferences(raw: unknown): ChartWorkspacePreferencesV3 {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_WORKSPACE_PREFERENCES };
  const stored = raw as Partial<ChartWorkspacePreferencesV3>;
  const defaults = DEFAULT_WORKSPACE_PREFERENCES;
  const eventKinds = Array.isArray(stored.eventKinds)
    ? stored.eventKinds.filter((kind): kind is ChartEventKind => typeof kind === 'string')
    : defaults.eventKinds;
  const movingAverages = Array.isArray(stored.movingAverages)
    ? MOVING_AVERAGES.filter((length) => stored.movingAverages?.includes(length))
    : defaults.movingAverages;
  return {
    version: 3,
    showExtendedHours: boolean(stored.showExtendedHours, defaults.showExtendedHours),
    showSignals: boolean(stored.showSignals, defaults.showSignals),
    showAllSignalDecisions: boolean(stored.showAllSignalDecisions, defaults.showAllSignalDecisions),
    showEvents: boolean(stored.showEvents, defaults.showEvents),
    eventKinds: eventKinds.length ? eventKinds : [...defaults.eventKinds],
    showForecast: boolean(stored.showForecast, defaults.showForecast),
    movingAverages: movingAverages.length ? movingAverages : [...defaults.movingAverages],
    logScale: boolean(stored.logScale, defaults.logScale),
    inspectorTab:
      stored.inspectorTab && INSPECTOR_TABS.includes(stored.inspectorTab)
        ? stored.inspectorTab
        : defaults.inspectorTab,
  };
}

/**
 * Migrates 2.x overlay preferences.
 *
 * Only two mappings are obvious enough to carry over: the forecast overlay
 * toggle and the log-scale toggle, both of which meant the same thing in 2.x.
 * Everything else keeps the 3.0 default — there was no 2.x concept of extended
 * hours, event layers, or signal-decision filtering to map from.
 */
export function migrateLegacyOverlayPreferences(raw: unknown): Partial<ChartWorkspacePreferencesV3> {
  if (!raw || typeof raw !== 'object') return {};
  const legacy = raw as Record<string, unknown>;
  const migrated: Partial<ChartWorkspacePreferencesV3> = {};
  if (typeof legacy.showForecast === 'boolean') migrated.showForecast = legacy.showForecast;
  if (typeof legacy.forecastOverlay === 'boolean') migrated.showForecast = legacy.forecastOverlay;
  if (typeof legacy.logScale === 'boolean') migrated.logScale = legacy.logScale;
  return migrated;
}

function readStored(): ChartWorkspacePreferencesV3 {
  try {
    const current = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (current) return coerceWorkspacePreferences(JSON.parse(current));
    const legacy = window.localStorage.getItem(LEGACY_OVERLAY_STORAGE_KEY);
    if (legacy) {
      return coerceWorkspacePreferences({
        ...DEFAULT_WORKSPACE_PREFERENCES,
        ...migrateLegacyOverlayPreferences(JSON.parse(legacy)),
      });
    }
  } catch {
    // Private-mode windows and blocked site data both throw here.
  }
  return { ...DEFAULT_WORKSPACE_PREFERENCES };
}

export interface ChartWorkspaceStateApi {
  preferences: ChartWorkspacePreferencesV3;
  update: (patch: Partial<ChartWorkspacePreferencesV3>) => void;
  toggleEventKind: (kind: ChartEventKind) => void;
  toggleMovingAverage: (length: 20 | 50 | 200) => void;
  reset: () => void;
}

export function useChartWorkspaceState(): ChartWorkspaceStateApi {
  const [preferences, setPreferences] = useState<ChartWorkspacePreferencesV3>(readStored);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(preferences));
    } catch {
      // Persisting preferences is a convenience; failing to must not break the
      // workspace.
    }
  }, [preferences]);

  const update = useCallback((patch: Partial<ChartWorkspacePreferencesV3>) => {
    setPreferences((current) => coerceWorkspacePreferences({ ...current, ...patch }));
  }, []);

  const toggleEventKind = useCallback((kind: ChartEventKind) => {
    setPreferences((current) => {
      const active = current.eventKinds.includes(kind);
      const eventKinds = active
        ? current.eventKinds.filter((item) => item !== kind)
        : [...current.eventKinds, kind];
      return { ...current, eventKinds };
    });
  }, []);

  const toggleMovingAverage = useCallback((length: 20 | 50 | 200) => {
    setPreferences((current) => {
      const active = current.movingAverages.includes(length);
      const movingAverages = active
        ? current.movingAverages.filter((item) => item !== length)
        : MOVING_AVERAGES.filter((item) => item === length || current.movingAverages.includes(item));
      return { ...current, movingAverages };
    });
  }, []);

  const reset = useCallback(() => setPreferences({ ...DEFAULT_WORKSPACE_PREFERENCES }), []);

  return useMemo(
    () => ({ preferences, update, toggleEventKind, toggleMovingAverage, reset }),
    [preferences, update, toggleEventKind, toggleMovingAverage, reset],
  );
}
