// Federal Reserve calendar parser.
//
// Parsing is separated from fetching so every adapter is testable against a
// fixture: `parseFederalReserveCalendar` takes a string and returns records.
// Nothing here touches the network, and no test may hit federalreserve.gov.
//
// The Fed publishes its FOMC calendar as an RSS feed and as HTML. Both carry
// the same three facts the chart needs — what, when, and a link — so the parser
// accepts either and normalizes to one record shape.

import type { ChartEventKind, ChartEventRecord } from '../../../shared/types';

export const FEDERAL_RESERVE_SOURCE = 'Federal Reserve';
export const FOMC_CALENDAR_RSS =
  'https://www.federalreserve.gov/feeds/press_monetary.xml';

/** Classifies a Fed release title. Order matters: "minutes of the FOMC
 *  meeting" must not be read as a rate decision. */
export function classifyFederalReserveTitle(title: string): ChartEventKind | null {
  const text = title.toLowerCase();
  if (text.includes('minutes')) return 'fed-minutes';
  if (text.includes('press conference')) return 'fed-press-conference';
  if (
    text.includes('fomc statement') ||
    text.includes('federal open market committee') ||
    text.includes('fomc meeting') ||
    text.includes('monetary policy decision')
  ) {
    return 'fomc';
  }
  if (text.includes('speech') || text.includes('remarks') || text.includes('testimony')) {
    return 'fed-speech';
  }
  return null;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Ampersand last: decoding it first would let "&amp;lt;" become "<".
    .replace(/&amp;/g, '&');
}

function stripTags(value: string): string {
  return decodeXmlEntities(value.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function tagContent(block: string, tag: string): string | null {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block);
  if (!match) return null;
  const cdata = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(match[1]);
  return stripTags(cdata ? cdata[1] : match[1]);
}

function toIso(value: string | null): string | null {
  if (!value) return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/** Stable, content-derived id so re-parsing the same feed does not duplicate
 *  records in a merged set. */
export function eventId(prefix: string, kind: string, iso: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48);
  return `${prefix}:${kind}:${iso.slice(0, 10)}:${slug}`;
}

/** Parses the FOMC press RSS feed. Unrecognised items are skipped rather than
 *  filed as `custom`, which would fill the chart with press miscellany. */
export function parseFederalReserveCalendar(xml: string): ChartEventRecord[] {
  const records: ChartEventRecord[] = [];
  const seen = new Set<string>();
  const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;
  let match: RegExpExecArray | null;
  while ((match = itemPattern.exec(xml)) !== null) {
    const block = match[1];
    const title = tagContent(block, 'title');
    const published = toIso(tagContent(block, 'pubDate') ?? tagContent(block, 'dc:date'));
    if (!title || !published) continue;
    const kind = classifyFederalReserveTitle(title);
    if (!kind) continue;
    const link = tagContent(block, 'link') ?? undefined;
    const id = eventId('fed', kind, published, title);
    if (seen.has(id)) continue;
    seen.add(id);
    records.push({
      id,
      kind,
      title,
      scheduledAt: published,
      // A press release is published when it happens, so scheduled and
      // occurred coincide. They are still both recorded: a future calendar
      // entry will have `occurredAt: null` and must stay distinguishable.
      occurredAt: published,
      sourceName: FEDERAL_RESERVE_SOURCE,
      sourceUrl: link,
      values: [],
      provenance: 'live',
    });
  }
  return records;
}
