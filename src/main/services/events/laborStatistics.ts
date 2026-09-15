// Bureau of Labor Statistics release-schedule parser (CPI, PPI, payrolls,
// unemployment, JOLTS, jobless claims).
//
// BLS publishes its schedule as an HTML table of release name plus date/time.
// The parser takes the markup and produces records; it never fetches.

import type { ChartEventKind, ChartEventRecord } from '../../../shared/types';
import { eventId } from './federalReserve';

export const LABOR_STATISTICS_SOURCE = 'Bureau of Labor Statistics';
export const BLS_SCHEDULE_URL = 'https://www.bls.gov/schedule/news_release/';

/**
 * Maps a BLS release name to an event kind.
 *
 * "Consumer Price Index" and "Producer Price Index" differ by one word, and
 * "Employment Situation" is the payrolls release despite not containing the
 * word — hence an explicit table rather than keyword guessing.
 */
export function classifyLaborRelease(name: string): ChartEventKind | null {
  const text = name.toLowerCase();
  if (text.includes('consumer price index')) return 'cpi';
  if (text.includes('producer price index')) return 'ppi';
  if (text.includes('employment situation')) return 'payrolls';
  if (text.includes('job openings') || text.includes('jolts')) return 'jolts';
  if (text.includes('unemployment insurance weekly claims') || text.includes('jobless claims')) {
    return 'jobless-claims';
  }
  if (text.includes('unemployment rate') || text.includes('metropolitan area employment')) {
    return 'unemployment';
  }
  return null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function cellText(cell: string): string {
  return decodeEntities(cell.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parses a `date time` string in BLS style, e.g. `Jan. 13, 2026 08:30 AM`.
 *
 * Times are Eastern. They are converted by constructing the instant from an
 * explicit offset rather than by trusting the host timezone, which would shift
 * every event by the developer's own UTC offset.
 */
export function parseEasternDateTime(date: string, time: string | null): string | null {
  const cleanDate = date.replace(/\./g, '').trim();
  const parsedDay = Date.parse(`${cleanDate} 12:00:00Z`);
  if (!Number.isFinite(parsedDay)) return null;
  const day = new Date(parsedDay);

  let hour = 8;
  let minute = 30;
  if (time) {
    const match = /(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(time);
    if (match) {
      hour = Number(match[1]) % 12;
      minute = Number(match[2]);
      if (match[3] && match[3].toUpperCase() === 'PM') hour += 12;
      if (!match[3] && Number(match[1]) === 12) hour = 12;
    }
  }

  // Eastern is UTC-5 in winter and UTC-4 in summer. Determine which by asking
  // Intl what the offset is on that date, rather than hardcoding a rule that
  // breaks whenever the DST dates move.
  const offsetHours = easternOffsetHours(day);
  const iso = new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour - offsetHours, minute),
  );
  return Number.isFinite(iso.getTime()) ? iso.toISOString() : null;
}

function easternOffsetHours(date: Date): number {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'short',
  });
  const name = formatter
    .formatToParts(date)
    .find((part) => part.type === 'timeZoneName')?.value;
  return name === 'EDT' ? -4 : -5;
}

/** Parses the BLS schedule table. Rows whose release is not one of the tracked
 *  series are skipped. */
export function parseLaborStatisticsSchedule(html: string): ChartEventRecord[] {
  const records: ChartEventRecord[] = [];
  const seen = new Set<string>();
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) {
      cells.push(cellText(cellMatch[1]));
    }
    if (cells.length < 2) continue;

    const name = cells[0];
    const kind = classifyLaborRelease(name);
    if (!kind) continue;

    const reference = cells.length >= 3 ? cells[1] : null;
    const dateCell = cells.length >= 3 ? cells[2] : cells[1];
    const dateMatch = /([A-Z][a-z]+\.?\s+\d{1,2},\s*\d{4})/.exec(dateCell);
    if (!dateMatch) continue;
    const timeMatch = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i.exec(dateCell);
    const scheduledAt = parseEasternDateTime(dateMatch[1], timeMatch ? timeMatch[1] : null);
    if (!scheduledAt) continue;

    const id = eventId('bls', kind, scheduledAt, name);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      kind,
      title: name,
      scheduledAt,
      // A schedule entry is a future event: it has not occurred yet, and
      // claiming otherwise would make an event study read a reaction against a
      // release that has not happened.
      occurredAt: null,
      sourceName: LABOR_STATISTICS_SOURCE,
      sourceUrl: BLS_SCHEDULE_URL,
      values: reference ? [{ label: 'Reference period', actual: reference, expected: null, previous: null }] : [],
      provenance: 'live',
    });
  }
  return records;
}
