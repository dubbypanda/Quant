// Orchestration shell for the 3.0 chart workspace.
//
// This file wires; it does not decide. Domain logic lives in the shared modules
// and the hooks, which is the rule section 1 sets so `ChartModal.tsx`'s
// accumulation of domain logic is not simply recreated one directory over.

import React, { useCallback, useMemo, useState } from 'react';
import type {
  ChartData,
  ChartRange,
  HistoricalSignalSnapshot,
  MacroOverlaySeries,
  PivotPoint,
} from '../../../shared/types';
import type { RiskRewardPlan } from '../../../shared/quant';
import type { TrendLines } from '../../../shared/priceStructure';
import type { ForecastActualPoint, ForecastRecord } from '../../../shared/forecast';
import { SymbolHeader } from './SymbolHeader';
import { ChartToolbar } from './ChartToolbar';
import { ChartStage } from './ChartStage';
import { ResearchInspector } from './ResearchInspector';
import { useChartEvents } from './hooks/useChartEvents';
import { useSignalHistory } from './hooks/useSignalHistory';
import {
  useChartWorkspaceState,
  type InspectorTab,
} from './hooks/useChartWorkspaceState';
import { hasExtendedHoursBars, supportsExtendedHours } from './layers/ExtendedHoursLayer';

interface ChartWorkspaceProps {
  symbol: string;
  companyName?: string;
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  data: ChartData | null;
  loading: boolean;
  pivots: PivotPoint[];
  trendLines: TrendLines;
  numbered: boolean[];
  highlight: number | null;
  macroOverlays: MacroOverlaySeries[];
  riskPlan: RiskRewardPlan | null;
  showRiskOverlay: boolean;
  forecastRecord: ForecastRecord | null;
  forecastActual: ForecastActualPoint[];
  overviewPanel: React.ReactNode;
  signalPanel: React.ReactNode;
  forecastPanel: React.ReactNode;
  /** Filled by Plan 03. Until then the tab explains itself rather than
   *  rendering an empty box. */
  positionPanel?: React.ReactNode;
  onNeedMoreHistory?: () => void;
  onClose: () => void;
}

export function ChartWorkspace({
  symbol,
  companyName,
  range,
  onRangeChange,
  data,
  loading,
  pivots,
  trendLines,
  numbered,
  highlight,
  macroOverlays,
  riskPlan,
  showRiskOverlay,
  forecastRecord,
  forecastActual,
  overviewPanel,
  signalPanel,
  forecastPanel,
  positionPanel,
  onNeedMoreHistory,
  onClose,
}: ChartWorkspaceProps): React.ReactElement {
  const { preferences, update, toggleMovingAverage } = useChartWorkspaceState();
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedSignal, setSelectedSignal] = useState<HistoricalSignalSnapshot | null>(null);

  const candles = useMemo(() => data?.candles ?? [], [data]);

  const { events } = useChartEvents(symbol, candles, preferences.showEvents);
  const { snapshots } = useSignalHistory(symbol, candles, preferences.showSignals);

  const extendedHoursAvailable = Boolean(
    data && supportsExtendedHours(data.interval) && hasExtendedHoursBars(data.candles),
  );

  const handleTabChange = useCallback(
    (tab: InspectorTab) => update({ inspectorTab: tab }),
    [update],
  );

  // Clicking a marker opens its tab and selects the record, so the marker and
  // the inspector never disagree about what is being looked at.
  const handleSelectEvent = useCallback(
    (id: string | null) => {
      setSelectedEventId(id);
      if (id) update({ inspectorTab: 'events' });
    },
    [update],
  );

  const handleSelectSignal = useCallback(
    (snapshot: HistoricalSignalSnapshot) => {
      setSelectedSignal(snapshot);
      update({ inspectorTab: 'signal' });
    },
    [update],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    },
    [onClose],
  );

  return (
    <div className="cv3-workspace" onKeyDown={handleKeyDown}>
      <SymbolHeader
        symbol={symbol}
        companyName={companyName}
        data={data}
        // A refresh over cached data is a subtle stale state, never a blocking
        // spinner: the canvas stays readable while the new payload lands.
        refreshing={loading && data !== null}
      />

      <ChartToolbar
        range={range}
        onRangeChange={onRangeChange}
        preferences={preferences}
        onUpdate={update}
        onToggleMovingAverage={toggleMovingAverage}
        extendedHoursAvailable={extendedHoursAvailable}
      />

      <div className="cv3-body">
        {data ? (
          <ChartStage
            data={data}
            pivots={pivots}
            trendLines={trendLines}
            numbered={numbered}
            highlight={highlight}
            macroOverlays={macroOverlays}
            riskPlan={riskPlan}
            showRiskOverlay={showRiskOverlay}
            forecastRecord={forecastRecord}
            forecastActual={forecastActual}
            preferences={preferences}
            events={events}
            signalHistory={snapshots}
            onSelectEvent={handleSelectEvent}
            onSelectSignal={handleSelectSignal}
            onNeedMoreHistory={onNeedMoreHistory}
          />
        ) : (
          <div className="cv3-stage cv3-stage-empty" role="status">
            {loading ? 'Loading chart…' : 'No chart data is available for this symbol.'}
          </div>
        )}

        <ResearchInspector
          tab={preferences.inspectorTab}
          onTabChange={handleTabChange}
          collapsed={inspectorCollapsed}
          onToggleCollapsed={() => setInspectorCollapsed((value) => !value)}
          overview={overviewPanel}
          signal={signalPanel}
          forecast={forecastPanel}
          position={
            positionPanel ?? (
              <p className="cv3-empty">
                Position context arrives with the portfolio engine.
              </p>
            )
          }
          events={events}
          selectedEventId={selectedEventId}
          onSelectEvent={handleSelectEvent}
          selectedSignal={selectedSignal}
        />
      </div>
    </div>
  );
}
