// Bureau of Economic Analysis release-schedule parser (GDP, PCE prices,
// personal income). Parsing only; no network access.

import type { ChartEventKind, ChartEventRecord } from '../../../shared/types';
import { eventId } from './federalReserve';
import { parseEasternDateTime } from './laborStatistics';

export const ECONOMIC_ANALYSIS_SOURCE = 'Bureau of Economic Analysis';
export const BEA_SCHEDULE_URL = 'https://www.bea.gov/news/schedule';

/**
 * Maps a BEA release name to an event kind.
 *
 * "Personal Income and Outlays" is the PCE price release, which is the number
 * the market trades — the plain-language name does not say so, so the mapping
 * is explicit.
 */
export function classifyEconomicAnalysisRelease(name: string): ChartEventKind | null {
  const text = name.toLowerCase();
  if (text.includes('personal income') || text.includes('pce')) return 'pce';
  if (text.includes('gross domestic product') || text.includes('gdp')) return 'gdp';
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

function text(value: string): string {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function parseEconomicAnalysisSchedule(html: string): ChartEventRecord[] {
  const records: ChartEventRecord[] = [];
  const seen = new Set<string>();
  const rowPattern = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowPattern.exec(html)) !== null) {
    const cells: string[] = [];
    const cellPattern = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellPattern.exec(rowMatch[1])) !== null) cells.push(text(cellMatch[1]));
    if (cells.length < 2) continue;

    // BEA puts the date first in some tables and the release first in others,
    // so both orderings are attempted rather than assuming one layout.
    const dateFirst = /([A-Z][a-z]+\.?\s+\d{1,2},\s*\d{4})/.exec(cells[0]);
    const dateCell = dateFirst ? cells[0] : cells.find((cell) => /\d{1,2},\s*\d{4}/.test(cell));
    const nameCell = dateFirst ? cells.slice(1).join(' ') : cells[0];
    if (!dateCell || !nameCell) continue;

    const kind = classifyEconomicAnalysisRelease(nameCell);
    if (!kind) continue;
    const dateMatch = /([A-Z][a-z]+\.?\s+\d{1,2},\s*\d{4})/.exec(dateCell);
    if (!dateMatch) continue;
    const timeMatch = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i.exec(cells.join(' '));
    const scheduledAt = parseEasternDateTime(dateMatch[1], timeMatch ? timeMatch[1] : null);
    if (!scheduledAt) continue;

    const id = eventId('bea', kind, scheduledAt, nameCell);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      kind,
      title: nameCell,
      scheduledAt,
      occurredAt: null,
      sourceName: ECONOMIC_ANALYSIS_SOURCE,
      sourceUrl: BEA_SCHEDULE_URL,
      values: [],
      provenance: 'live',
    });
  }
  return records;
}
