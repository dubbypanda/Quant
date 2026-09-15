// Presentation models for event and signal markers.
//
// Two accessibility rules from docs/quant-v3/02 are enforced structurally
// rather than left to each renderer:
//
//   * colour is never the only indicator — every marker carries a `glyph` and
//     an `accessibleLabel`, so the decision survives greyscale and a screen
//     reader;
//   * event markers stay usable when enrichment is incomplete — the label
//     falls back to the title and time, and missing values render as "—"
//     rather than blanking the row.

import type {
  ChartEventKind,
  ChartEventRecord,
  HistoricalSignalSnapshot,
  MarketSession,
} from '../../../../shared/types';
import { MARKET_SESSION_LABELS } from '../../../../shared/marketSession';

export type MarkerTone = 'bullish' | 'bearish' | 'neutral' | 'invalidated';
export type MarkerPosition = 'aboveBar' | 'belowBar' | 'inBar';

export interface EventMarkerModel {
  id: string;
  time: number;
  /** A short glyph, shown only when the zoom level allows. */
  glyph: string;
  title: string;
  tone: MarkerTone;
  accessibleLabel: string;
  /** How many records this marker stands for, when clustered. */
  count: number;
  records: ChartEventRecord[];
}

export interface SignalMarkerModel {
  id: string;
  time: number;
  glyph: string;
  tone: MarkerTone;
  position: MarkerPosition;
  accessibleLabel: string;
  snapshot: HistoricalSignalSnapshot;
}

const EVENT_GLYPHS: Record<ChartEventKind, string> = {
  fomc: 'FOMC',
  'fed-press-conference': 'FED',
  'fed-minutes': 'MIN',
  'fed-speech': 'SPCH',
  cpi: 'CPI',
  ppi: 'PPI',
  pce: 'PCE',
  payrolls: 'NFP',
  unemployment: 'U3',
  jolts: 'JOLTS',
  'jobless-claims': 'CLMS',
  gdp: 'GDP',
  'retail-sales': 'RTL',
  ism: 'ISM',
  'treasury-auction': 'AUCT',
  earnings: 'ER',
  dividend: 'DIV',
  split: 'SPLT',
  custom: 'EVT',
};

export const EVENT_KIND_LABELS: Record<ChartEventKind, string> = {
  fomc: 'FOMC rate decision',
  'fed-press-conference': 'Fed press conference',
  'fed-minutes': 'FOMC minutes',
  'fed-speech': 'Fed speech',
  cpi: 'Consumer Price Index',
  ppi: 'Producer Price Index',
  pce: 'PCE price index',
  payrolls: 'Nonfarm payrolls',
  unemployment: 'Unemployment rate',
  jolts: 'JOLTS job openings',
  'jobless-claims': 'Initial jobless claims',
  gdp: 'Gross domestic product',
  'retail-sales': 'Retail sales',
  ism: 'ISM survey',
  'treasury-auction': 'Treasury auction',
  earnings: 'Earnings report',
  dividend: 'Dividend',
  split: 'Stock split',
  custom: 'Event',
};

function formatTime(iso: string): string {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return 'time unknown';
  return new Date(stamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** A marker for one cluster of events sharing a pixel bucket. */
export function buildEventMarker(time: number, records: ChartEventRecord[]): EventMarkerModel | null {
  if (!records.length) return null;
  const primary = records[0];
  const extra = records.length - 1;
  const when = formatTime(primary.occurredAt ?? primary.scheduledAt);
  // Enrichment may be absent; the title and time are always available, so the
  // label degrades instead of disappearing.
  const detail = primary.title || EVENT_KIND_LABELS[primary.kind];
  return {
    id: records.map((record) => record.id).join('+'),
    time,
    glyph: extra > 0 ? `${EVENT_GLYPHS[primary.kind]}+${extra}` : EVENT_GLYPHS[primary.kind],
    title: extra > 0 ? `${detail} and ${extra} more` : detail,
    tone: 'neutral',
    accessibleLabel:
      extra > 0
        ? `${detail}, ${when}, and ${extra} more event${extra === 1 ? '' : 's'} at this point`
        : `${detail}, ${when}`,
    count: records.length,
    records,
  };
}

/**
 * Marker semantics from section 10.
 *
 * BUY sits below the bar and SHORT above it, so direction reads from position
 * as well as from colour. WAIT and NO TRADE return null: they are not shown
 * unless the caller has opted into all decisions, and filtering here keeps that
 * rule in one place.
 */
export function buildSignalMarker(
  snapshot: HistoricalSignalSnapshot,
  showAllDecisions: boolean,
): SignalMarkerModel | null {
  const when = formatTime(snapshot.observedAt);
  const base = {
    id: snapshot.id,
    time: snapshot.signalBarTime,
    snapshot,
  };

  switch (snapshot.decision) {
    case 'buy-candidate':
      return {
        ...base,
        glyph: '▲',
        tone: 'bullish',
        position: 'belowBar',
        accessibleLabel: `Buy candidate, ${snapshot.setupType}, quality ${snapshot.setupQuality} of 100, observed ${when}`,
      };
    case 'short-candidate':
      return {
        ...base,
        glyph: '▼',
        tone: 'bearish',
        position: 'aboveBar',
        accessibleLabel: `Short candidate, ${snapshot.setupType}, quality ${snapshot.setupQuality} of 100, observed ${when}`,
      };
    case 'invalidated':
      return {
        ...base,
        glyph: '✕',
        tone: 'invalidated',
        position: 'aboveBar',
        accessibleLabel: `Thesis invalidated, ${snapshot.setupType}, observed ${when}`,
      };
    case 'wait':
    case 'no-trade':
      if (!showAllDecisions) return null;
      return {
        ...base,
        glyph: '·',
        tone: 'neutral',
        position: 'inBar',
        accessibleLabel: `${snapshot.decision === 'wait' ? 'Wait' : 'No trade'}, ${snapshot.setupType}, observed ${when}`,
      };
    default:
      return null;
  }
}

/** Crosshair tooltip text for an intraday bar. The session is named in words
 *  because the band shading alone is a colour-only signal. */
export function crosshairSessionLabel(session: MarketSession | undefined): string | null {
  if (!session || session === 'unknown') return null;
  return MARKET_SESSION_LABELS[session];
}

/** Inspector rows for one event. Missing values render as an em dash so the row
 *  keeps its shape when enrichment is partial. */
export function eventInspectorRows(
  record: ChartEventRecord,
): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [
    { label: 'Event', value: record.title || EVENT_KIND_LABELS[record.kind] },
    { label: 'Category', value: EVENT_KIND_LABELS[record.kind] },
    { label: 'Scheduled', value: formatTime(record.scheduledAt) },
    {
      label: 'Occurred',
      value: record.occurredAt ? formatTime(record.occurredAt) : 'Not reported',
    },
    { label: 'Source', value: record.sourceName || '—' },
    { label: 'Provenance', value: record.provenance },
  ];
  for (const value of record.values) {
    rows.push({
      label: value.label,
      value: [
        value.actual === null ? '—' : value.actual,
        value.expected === null ? null : `est. ${value.expected}`,
        value.previous === null ? null : `prev. ${value.previous}`,
      ]
        .filter((part): part is string => part !== null)
        .join('  '),
    });
  }
  return rows;
}

/**
 * Inspector rows for a stored signal snapshot.
 *
 * Reads only the snapshot. When historical validation was not captured at
 * signal time the row says `Not captured` rather than computing today's
 * backtest, which would imply knowledge the model did not have.
 */
export function signalInspectorRows(
  snapshot: HistoricalSignalSnapshot,
): Array<{ label: string; value: string }> {
  const price = (value: number | null) => (value === null ? 'Not captured' : value.toFixed(2));
  return [
    { label: 'Decision', value: snapshot.decision },
    { label: 'Setup Quality', value: `${snapshot.setupQuality} / 100` },
    { label: 'Setup Type', value: snapshot.setupType },
    { label: 'Direction', value: snapshot.direction },
    { label: 'Entry', value: price(snapshot.entry) },
    { label: 'Stop', value: price(snapshot.stop) },
    { label: 'Target 1', value: price(snapshot.target1) },
    { label: 'Target 2', value: price(snapshot.target2) },
    {
      label: 'Blockers',
      value: snapshot.noTradeReasons.length ? snapshot.noTradeReasons.join('; ') : 'None',
    },
    {
      label: 'Forward outcome',
      value: snapshot.outcome
        ? `${snapshot.outcome.status}${
            snapshot.outcome.netR === null ? '' : ` (${snapshot.outcome.netR.toFixed(2)}R)`
          }`
        : 'Open',
    },
    { label: 'Model', value: `${snapshot.modelName} / ${snapshot.strategyVersion}` },
    { label: 'Observed', value: formatTime(snapshot.observedAt) },
    {
      label: 'Data cutoff',
      value: snapshot.dataCutoffTime
        ? new Date(snapshot.dataCutoffTime * 1000).toLocaleDateString()
        : 'Not captured',
    },
    { label: 'Record source', value: snapshot.source },
  ];
}
