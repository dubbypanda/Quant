// Compact segmented controls for the workspace.
//
// Section 12's layout rules applied: text and segmented controls rather than
// oversized buttons, no nested cards, and every toggle is a real <button> with
// `aria-pressed` so keyboard and screen-reader users get the same affordance as
// the mouse.

import React from 'react';
import type { ChartRange } from '../../../shared/types';
import { CHART_RANGES } from '../../../shared/types';
import type { ChartWorkspacePreferencesV3 } from './hooks/useChartWorkspaceState';

interface ChartToolbarProps {
  range: ChartRange;
  onRangeChange: (range: ChartRange) => void;
  preferences: ChartWorkspacePreferencesV3;
  onUpdate: (patch: Partial<ChartWorkspacePreferencesV3>) => void;
  onToggleMovingAverage: (length: 20 | 50 | 200) => void;
  /** Hidden when the loaded series has no extended-hours bars: a control that
   *  changes nothing reads as broken. */
  extendedHoursAvailable: boolean;
}

function Toggle({
  label,
  pressed,
  onClick,
  title,
}: {
  label: string;
  pressed: boolean;
  onClick: () => void;
  title?: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`cv3-toggle${pressed ? ' is-on' : ''}`}
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
    >
      {label}
    </button>
  );
}

export function ChartToolbar({
  range,
  onRangeChange,
  preferences,
  onUpdate,
  onToggleMovingAverage,
  extendedHoursAvailable,
}: ChartToolbarProps): React.ReactElement {
  return (
    <div className="cv3-toolbar">
      <div className="cv3-segment" role="group" aria-label="Chart range">
        {CHART_RANGES.map((option) => (
          <button
            key={option}
            type="button"
            className={`cv3-segment-item${option === range ? ' is-active' : ''}`}
            aria-pressed={option === range}
            onClick={() => onRangeChange(option)}
          >
            {option.toUpperCase()}
          </button>
        ))}
      </div>

      <div className="cv3-toolbar-group" role="group" aria-label="Moving averages">
        {([20, 50, 200] as const).map((length) => (
          <Toggle
            key={length}
            label={`MA${length}`}
            pressed={preferences.movingAverages.includes(length)}
            onClick={() => onToggleMovingAverage(length)}
          />
        ))}
      </div>

      <div className="cv3-toolbar-group" role="group" aria-label="Annotation layers">
        {extendedHoursAvailable ? (
          <Toggle
            label="Extended hours"
            pressed={preferences.showExtendedHours}
            onClick={() => onUpdate({ showExtendedHours: !preferences.showExtendedHours })}
            title="Shade pre-market and after-hours bars"
          />
        ) : null}
        <Toggle
          label="Signals"
          pressed={preferences.showSignals}
          onClick={() => onUpdate({ showSignals: !preferences.showSignals })}
          title="Historical signal markers, as originally emitted"
        />
        {preferences.showSignals ? (
          <Toggle
            label="All decisions"
            pressed={preferences.showAllSignalDecisions}
            onClick={() =>
              onUpdate({ showAllSignalDecisions: !preferences.showAllSignalDecisions })
            }
            title="Also mark WAIT and NO TRADE decisions"
          />
        ) : null}
        <Toggle
          label="Events"
          pressed={preferences.showEvents}
          onClick={() => onUpdate({ showEvents: !preferences.showEvents })}
          title="Macro releases and corporate events"
        />
        <Toggle
          label="Forecast"
          pressed={preferences.showForecast}
          onClick={() => onUpdate({ showForecast: !preferences.showForecast })}
        />
        <Toggle
          label="Log"
          pressed={preferences.logScale}
          onClick={() => onUpdate({ logScale: !preferences.logScale })}
          title="Logarithmic price scale"
        />
      </div>
    </div>
  );
}
