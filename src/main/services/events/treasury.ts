// Treasury auction-schedule parser. Parsing only; no network access.
//
// Treasury publishes upcoming auctions as JSON from its public announcement
// service. The parser accepts the already-decoded payload so the boundary is a
// plain object rather than a wire format.

import type { ChartEventRecord } from '../../../shared/types';
import { eventId } from './federalReserve';

export const TREASURY_SOURCE = 'U.S. Treasury';
export const TREASURY_AUCTION_URL =
  'https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json';

export interface TreasuryAuctionRow {
  cusip?: string | null;
  securityType?: string | null;
  securityTerm?: string | null;
  auctionDate?: string | null;
  issueDate?: string | null;
  offeringAmount?: string | null;
}

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const stamp = Date.parse(value);
  if (!Number.isFinite(stamp)) return null;
  // Treasury dates are calendar days with no time; auctions are around 13:00
  // ET, so anchoring at 13:00 ET keeps the marker on the right session instead
  // of at midnight where no bar exists.
  const day = new Date(stamp);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 18, 0),
  ).toISOString();
}

export function parseTreasuryAuctions(payload: unknown): ChartEventRecord[] {
  if (!Array.isArray(payload)) return [];
  const records: ChartEventRecord[] = [];
  const seen = new Set<string>();
  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as TreasuryAuctionRow;
    const scheduledAt = isoDate(row.auctionDate);
    if (!scheduledAt) continue;
    const term = (row.securityTerm ?? '').trim();
    const type = (row.securityType ?? '').trim();
    const title = [term, type, 'auction'].filter(Boolean).join(' ') || 'Treasury auction';
    // The CUSIP makes the id unique when several terms auction on one day.
    const id = eventId('ust', 'treasury-auction', scheduledAt, `${row.cusip ?? ''}-${title}`);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      kind: 'treasury-auction',
      title,
      scheduledAt,
      occurredAt: null,
      sourceName: TREASURY_SOURCE,
      sourceUrl: 'https://www.treasurydirect.gov/auctions/upcoming/',
      values: [
        { label: 'Security', actual: type || null, expected: null, previous: null },
        { label: 'Term', actual: term || null, expected: null, previous: null },
        { label: 'Offering', actual: row.offeringAmount ?? null, expected: null, previous: null },
        { label: 'Issue date', actual: row.issueDate ?? null, expected: null, previous: null },
      ].filter((value) => value.actual !== null),
      provenance: 'live',
    });
  }
  return records;
}
