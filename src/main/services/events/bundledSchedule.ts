// Bundled offline fallback schedule.
//
// Quant's default experience requires no paid API and must degrade on a bad
// connection, so known-in-advance macro dates ship with the app. These are
// scheduled dates only: `occurredAt` is null and `provenance` is 'sample', so a
// bundled record can never be mistaken for a live release or used to measure a
// reaction to something that has not happened.
//
// A live record with the same id supersedes the bundled one — see
// `mergeEventRecords`.

import type { ChartEventRecord } from '../../../shared/types';

interface BundledEntry {
  kind: ChartEventRecord['kind'];
  title: string;
  /** ISO instant, Eastern-anchored at publication time. */
  scheduledAt: string;
}

/** FOMC decision dates are published a year ahead; the 14:00 ET statement time
 *  is the one the market trades. */
const FOMC_2026: BundledEntry[] = [
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-01-28T19:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-03-18T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-04-29T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-06-17T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-07-29T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-09-16T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-10-28T18:00:00.000Z' },
  { kind: 'fomc', title: 'FOMC statement', scheduledAt: '2026-12-09T19:00:00.000Z' },
];

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
}

function toRecord(entry: BundledEntry): ChartEventRecord {
  return {
    // Same id scheme as the live parsers, so a live record replaces rather
    // than duplicates this one.
    id: `fed:${entry.kind}:${entry.scheduledAt.slice(0, 10)}:${slug(entry.title)}`,
    kind: entry.kind,
    title: entry.title,
    scheduledAt: entry.scheduledAt,
    occurredAt: null,
    sourceName: 'Bundled schedule',
    values: [],
    provenance: 'sample',
  };
}

export const BUNDLED_MACRO_EVENTS: ChartEventRecord[] = FOMC_2026.map(toRecord);
