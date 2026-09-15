// The chart surface: price series plus the annotation layers.
//
// The performance rule lives here. Markers are built from the *visible* range
// and then clustered, so a symbol with a thousand events puts a handful of
// markers into lightweight-charts rather than a thousand — pointer interaction
// degrades long before the pixels do.

import React, { useCallback, useMemo, useRef, useState } from 'react';
import type { ChartData, ChartEventRecord, HistoricalSignalSnapshot, PivotPoint } from '../../../shared/types';
import type { RiskRewardPlan } from '../../../shared/quant';
import type { TrendLines } from '../../../shared/priceStructure';
import type { ForecastActualPoint, ForecastRecord } from '../../../shared/forecast';
import type { MacroOverlaySeries } from '../../../shared/types';
import { ChartCanvas, type ChartCanvasHandle } from '../chart/ChartCanvas';
import { buildSessionBands } from './model/annotationLayout';
import type { VisibleRange } from './model/annotationLayout';
import { useEventMarkers } from './hooks/useChartEvents';
import { useSignalMarkers } from './hooks/useSignalHistory';
import { buildEventSeriesMarkers, shouldShowEventGlyphs } from './layers/EventMarkersLayer';
import { buildSignalSeriesMarkers } from './layers/SignalMarkersLayer';
import {
  hasExtendedHoursBars,
  supportsExtendedHours,
  visibleSessionBands,
} from './layers/ExtendedHoursLayer';
import type { ChartWorkspacePreferencesV3 } from './hooks/useChartWorkspaceState';

interface ChartStageProps {
  data: ChartData;
  pivots: PivotPoint[];
  trendLines: TrendLines;
  numbered: boolean[];
  highlight: number | null;
  macroOverlays: MacroOverlaySeries[];
  riskPlan: RiskRewardPlan | null;
  showRiskOverlay: boolean;
  forecastRecord: ForecastRecord | null;
  forecastActual: ForecastActualPoint[];
  preferences: ChartWorkspacePreferencesV3;
  events: ChartEventRecord[];
  signalHistory: HistoricalSignalSnapshot[];
  onSelectEvent: (id: string) => void;
  onSelectSignal: (snapshot: HistoricalSignalSnapshot) => void;
  onNeedMoreHistory?: () => void;
}

const DEFAULT_PIXEL_WIDTH = 900;

export function ChartStage({
  data,
  pivots,
  trendLines,
  numbered,
  highlight,
  macroOverlays,
  riskPlan,
  showRiskOverlay,
  forecastRecord,
  forecastActual,
  preferences,
  events,
  signalHistory,
  onSelectEvent,
  onSelectSignal,
  onNeedMoreHistory,
}: ChartStageProps): React.ReactElement {
  const canvasRef = useRef<ChartCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [visibleRange, setVisibleRange] = useState<VisibleRange | null>(null);

  const pixelWidth = containerRef.current?.clientWidth ?? DEFAULT_PIXEL_WIDTH;

  const handleVisibleRangeChange = useCallback((range: { from: number; to: number } | null) => {
    setVisibleRange(range);
  }, []);

  const extendedHoursActive =
    preferences.showExtendedHours &&
    supportsExtendedHours(data.interval) &&
    hasExtendedHoursBars(data.candles);

  const sessionBands = useMemo(
    () => (extendedHoursActive ? visibleSessionBands(buildSessionBands(data.candles)) : []),
    [extendedHoursActive, data.candles],
  );

  const eventMarkerModels = useEventMarkers(
    preferences.showEvents ? events : [],
    data.candles,
    visibleRange,
    pixelWidth,
    preferences.eventKinds,
  );

  const signalMarkerModels = useSignalMarkers(
    preferences.showSignals ? signalHistory : [],
    visibleRange,
    pixelWidth,
    preferences.showAllSignalDecisions,
  );

  const extraMarkers = useMemo(
    () => [
      ...buildEventSeriesMarkers(eventMarkerModels, {
        showGlyphs: shouldShowEventGlyphs(eventMarkerModels.length, pixelWidth),
      }),
      ...buildSignalSeriesMarkers(signalMarkerModels),
    ],
    [eventMarkerModels, signalMarkerModels, pixelWidth],
  );

  return (
    <div className="cv3-stage" ref={containerRef}>
      {sessionBands.length ? (
        <ul className="cv3-session-legend" aria-label="Session shading legend">
          {/* Text, not only colour: the bands are a colour signal, so the
              legend names them. */}
          <li className="cv3-legend-pre">Pre-market</li>
          <li className="cv3-legend-post">After hours</li>
        </ul>
      ) : null}

      <ChartCanvas
        ref={canvasRef}
        data={data}
        pivots={pivots}
        trendLines={trendLines}
        numbered={numbered}
        highlight={highlight}
        macroOverlays={macroOverlays}
        riskPlan={riskPlan}
        showRiskOverlay={showRiskOverlay}
        studies={{
          ma20: preferences.movingAverages.includes(20),
          ma50: preferences.movingAverages.includes(50),
          ma200: preferences.movingAverages.includes(200),
        }}
        logScale={preferences.logScale}
        forecastRecord={preferences.showForecast ? forecastRecord : null}
        forecastActual={forecastActual}
        showForecastOverlay={preferences.showForecast}
        showForecastMa20={preferences.movingAverages.includes(20)}
        extraMarkers={extraMarkers}
        onVisibleRangeChange={handleVisibleRangeChange}
        onNeedMoreHistory={onNeedMoreHistory}
      />

      {/* Markers are drawn inside the canvas, so the accessible equivalents are
          exposed as a parallel list rather than left unreachable. */}
      {eventMarkerModels.length || signalMarkerModels.length ? (
        <ul className="cv3-marker-index" aria-label="Chart annotations">
          {signalMarkerModels.map((marker) => (
            <li key={marker.id}>
              <button
                type="button"
                className={`cv3-marker-chip cv3-tone-${marker.tone}`}
                onClick={() => onSelectSignal(marker.snapshot)}
              >
                <span aria-hidden="true">{marker.glyph}</span>
                <span className="cv3-visually-hidden">{marker.accessibleLabel}</span>
              </button>
            </li>
          ))}
          {eventMarkerModels.map((marker) => (
            <li key={marker.id}>
              <button
                type="button"
                className="cv3-marker-chip cv3-tone-neutral"
                onClick={() => onSelectEvent(marker.records[0].id)}
                title={marker.title}
              >
                <span aria-hidden="true">{marker.glyph}</span>
                <span className="cv3-visually-hidden">{marker.accessibleLabel}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
