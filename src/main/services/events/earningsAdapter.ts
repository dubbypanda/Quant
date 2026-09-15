// Symbol-specific corporate events: earnings, dividends, splits.
//
// Earnings come from Quant's existing earnings service, so this adapter
// converts an `EarningsEvent` into the unified chart-event record rather than
// adding a second source of truth for the same fact.

import type { ChartEventRecord, EarningsEvent } from '../../../shared/types';
import { eventId } from './federalReserve';

export const EARNINGS_SOURCE = 'Earnings calendar';

/**
 * Anchors an earnings report to a plottable instant.
 *
 * `bmo` reports land before the open and `amc` after the close, which is the
 * difference between the reaction being the same session or the next one. An
 * unknown time anchors to the close, the more common case for U.S. large caps.
 */
export function earningsInstant(date: string, time: EarningsEvent['time']): string | null {
  const stamp = Date.parse(`${date}T12:00:00Z`);
  if (!Number.isFinite(stamp)) return null;
  const day = new Date(stamp);
  const hourEastern = time === 'bmo' ? 7 : 16;
  const offsetHours = easternOffsetHours(day);
  return new Date(
    Date.UTC(
      day.getUTCFullYear(),
      day.getUTCMonth(),
      day.getUTCDate(),
      hourEastern - offsetHours,
      time === 'bmo' ? 30 : 30,
    ),
  ).toISOString();
}

function easternOffsetHours(date: Date): number {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  })
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  return name === 'EDT' ? -4 : -5;
}

function numberText(value: number | null | undefined, digits = 2): string | null {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : null;
}

export function earningsToChartEvents(events: EarningsEvent[]): ChartEventRecord[] {
  const records: ChartEventRecord[] = [];
  const seen = new Set<string>();
  for (const event of events) {
    const scheduledAt = earningsInstant(event.date, event.time);
    if (!scheduledAt) continue;
    const title = `${event.symbol} earnings`;
    const id = eventId('earn', 'earnings', scheduledAt, `${event.symbol}-${event.date}`);
    if (seen.has(id)) continue;
    seen.add(id);

    // A reported EPS is what makes this a past event. Without it the row is a
    // scheduled date, and `occurredAt` stays null so an event study cannot
    // measure a reaction to something that has not been released.
    const reported =
      typeof event.epsActual === 'number' && Number.isFinite(event.epsActual);

    records.push({
      id,
      kind: 'earnings',
      title,
      scheduledAt,
      occurredAt: reported ? scheduledAt : null,
      sourceName: EARNINGS_SOURCE,
      values: [
        {
          label: 'EPS',
          actual: numberText(event.epsActual ?? null),
          expected: numberText(event.epsEstimate),
          previous: null,
        },
        {
          label: 'Surprise',
          actual:
            typeof event.epsSurprisePercent === 'number' &&
            Number.isFinite(event.epsSurprisePercent)
              ? `${event.epsSurprisePercent.toFixed(1)}%`
              : null,
          expected: null,
          previous: null,
        },
        {
          label: 'Timing',
          actual: event.time === 'bmo' ? 'Before open' : event.time === 'amc' ? 'After close' : 'Unconfirmed',
          expected: null,
          previous: null,
        },
      ].filter((value) => value.actual !== null || value.expected !== null),
      provenance: event.source,
    });
  }
  return records;
}
