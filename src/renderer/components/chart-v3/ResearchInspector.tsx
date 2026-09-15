// The collapsible right-hand inspector.
//
// Tabs are content slots rather than owners of domain logic: the workspace
// passes already-resolved models in. That keeps the "do not add domain logic to
// the shell" rule from section 1 enforceable, and lets Plan 03 fill the
// `Position` tab without touching this file's other tabs.

import React from 'react';
import type { ChartEventRecord, HistoricalSignalSnapshot } from '../../../shared/types';
import type { InspectorTab } from './hooks/useChartWorkspaceState';
import {
  EVENT_KIND_LABELS,
  eventInspectorRows,
  signalInspectorRows,
} from './model/chartAnnotations';
import { REACTION_WINDOW_LABELS, RESIDUAL_MOVE_CAPTION } from '../../../shared/eventReaction';

const TAB_LABELS: Record<InspectorTab, string> = {
  overview: 'Overview',
  signal: 'Signal',
  events: 'Events',
  forecast: 'Forecast',
  position: 'Position',
};

interface ResearchInspectorProps {
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  overview: React.ReactNode;
  signal: React.ReactNode;
  forecast: React.ReactNode;
  position: React.ReactNode;
  events: ChartEventRecord[];
  selectedEventId: string | null;
  onSelectEvent: (id: string | null) => void;
  selectedSignal: HistoricalSignalSnapshot | null;
}

function DetailRows({ rows }: { rows: Array<{ label: string; value: string }> }): React.ReactElement {
  return (
    <dl className="cv3-detail-rows">
      {rows.map((row) => (
        <div key={row.label} className="cv3-detail-row">
          <dt>{row.label}</dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function EventsTab({
  events,
  selectedEventId,
  onSelectEvent,
}: Pick<ResearchInspectorProps, 'events' | 'selectedEventId' | 'onSelectEvent'>): React.ReactElement {
  const selected = events.find((event) => event.id === selectedEventId) ?? null;
  if (!events.length) {
    return <p className="cv3-empty">No events in the loaded range.</p>;
  }
  return (
    <div className="cv3-events-tab">
      <ul className="cv3-event-list">
        {events.map((event) => (
          <li key={event.id}>
            <button
              type="button"
              className={`cv3-event-item${event.id === selectedEventId ? ' is-selected' : ''}`}
              onClick={() => onSelectEvent(event.id === selectedEventId ? null : event.id)}
            >
              <span className="cv3-event-kind">{EVENT_KIND_LABELS[event.kind]}</span>
              <span className="cv3-event-title">{event.title}</span>
              <span className="cv3-event-date">
                {new Date(event.occurredAt ?? event.scheduledAt).toLocaleDateString()}
              </span>
              {event.provenance === 'sample' ? (
                <span className="cv3-sample-tag">bundled schedule</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>

      {selected ? (
        <section className="cv3-event-detail" aria-label="Event detail">
          <DetailRows rows={eventInspectorRows(selected)} />
          {selected.reaction ? (
            <div className="cv3-reaction">
              <h4>{REACTION_WINDOW_LABELS[selected.reaction.reactionWindow]}</h4>
              <DetailRows
                rows={[
                  {
                    label: 'Symbol move',
                    value:
                      selected.reaction.assetReturnPercent === null
                        ? 'Not measurable'
                        : `${selected.reaction.assetReturnPercent.toFixed(2)}%`,
                  },
                  {
                    label: 'Benchmark move',
                    value:
                      selected.reaction.benchmarkReturnPercent === null
                        ? 'Not measurable'
                        : `${selected.reaction.benchmarkReturnPercent.toFixed(2)}%`,
                  },
                  {
                    label: 'Residual move',
                    value:
                      selected.reaction.residualReturnPercent === null
                        ? 'Not measurable'
                        : `${selected.reaction.residualReturnPercent.toFixed(2)}%`,
                  },
                  {
                    label: 'Normalized shock',
                    value:
                      selected.reaction.normalizedShock === null
                        ? 'Not measurable'
                        : `${selected.reaction.normalizedShock.toFixed(2)}x baseline`,
                  },
                ]}
              />
              <p className="cv3-caption">{RESIDUAL_MOVE_CAPTION}</p>
            </div>
          ) : (
            <p className="cv3-caption">No reaction measured for this event.</p>
          )}
        </section>
      ) : null}
    </div>
  );
}

export function ResearchInspector(props: ResearchInspectorProps): React.ReactElement {
  const { tab, onTabChange, collapsed, onToggleCollapsed, selectedSignal } = props;

  return (
    <aside className={`cv3-inspector${collapsed ? ' is-collapsed' : ''}`}>
      <div className="cv3-inspector-head">
        <div className="cv3-tabs" role="tablist" aria-label="Research inspector">
          {(Object.keys(TAB_LABELS) as InspectorTab[]).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              id={`cv3-tab-${option}`}
              aria-selected={option === tab}
              aria-controls={`cv3-panel-${option}`}
              className={`cv3-tab${option === tab ? ' is-active' : ''}`}
              onClick={() => onTabChange(option)}
            >
              {TAB_LABELS[option]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="cv3-collapse"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
        >
          {collapsed ? 'Expand inspector' : 'Collapse inspector'}
        </button>
      </div>

      {collapsed ? null : (
        <div
          className="cv3-inspector-body"
          role="tabpanel"
          id={`cv3-panel-${tab}`}
          aria-labelledby={`cv3-tab-${tab}`}
        >
          {tab === 'overview' ? props.overview : null}
          {tab === 'signal' ? (
            <div className="cv3-signal-tab">
              {selectedSignal ? (
                <section aria-label="Selected historical signal">
                  <h4>Signal snapshot</h4>
                  {/* Snapshot values only — never a fresh recomputation
                      presented as what was known then. */}
                  <DetailRows rows={signalInspectorRows(selectedSignal)} />
                  <p className="cv3-caption">
                    These are the values recorded when the signal was emitted.
                  </p>
                </section>
              ) : null}
              {props.signal}
            </div>
          ) : null}
          {tab === 'events' ? <EventsTab {...props} /> : null}
          {tab === 'forecast' ? props.forecast : null}
          {tab === 'position' ? props.position : null}
        </div>
      )}
    </aside>
  );
}
