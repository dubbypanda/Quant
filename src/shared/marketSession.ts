// Pure session classification for U.S. equity and ETF bars.
//
// This is a *display* classifier, not an exchange-calendar authority. It
// answers "which session does this wall-clock time fall in", which is what the
// chart needs to shade pre/regular/post bands. Holidays and early closes are
// the forecast exchange calendar's job (`forecastCalendar.ts`); a holiday with
// no bars simply renders nothing here, and `calendarOverride` lets a caller
// supply that authority once it is wired through.
//
// Timezone arithmetic goes through `Intl.DateTimeFormat`, which carries the
// IANA database and therefore handles DST without a hand-maintained table of
// transition dates. Doing this with a fixed UTC offset is the classic version
// of this bug: it is correct for half the year.

import type { MarketSession } from './types';

export const US_EQUITY_TIMEZONE = 'America/New_York';

/** Session boundaries in minutes from exchange-local midnight. */
export const US_EQUITY_SESSION_MINUTES = {
  preOpen: 4 * 60, // 04:00
  regularOpen: 9 * 60 + 30, // 09:30
  regularClose: 16 * 60, // 16:00
  postClose: 20 * 60, // 20:00
} as const;

export interface SessionClassificationInput {
  unixSeconds: number;
  exchangeTimezone?: string;
  /** Supplied by an exchange-calendar authority when one is available. When it
   *  reports the date is not a trading day, the answer is `closed` regardless
   *  of the clock. */
  calendarOverride?: (localDate: string) => { isTradingDay: boolean; earlyCloseMinute?: number };
}

export interface ExchangeLocalTime {
  /** `YYYY-MM-DD` in exchange local time. */
  date: string;
  /** 0 = Sunday. */
  weekday: number;
  minuteOfDay: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Converts a UTC instant to exchange wall-clock fields.
 *
 * Returns null when the timestamp or timezone is unusable, so callers report
 * `unknown` rather than silently classifying against the host's local zone.
 */
export function exchangeLocalTime(
  unixSeconds: number,
  timeZone: string = US_EQUITY_TIMEZONE,
): ExchangeLocalTime | null {
  if (!Number.isFinite(unixSeconds)) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = formatterFor(timeZone).formatToParts(new Date(unixSeconds * 1000));
  } catch {
    return null;
  }
  const lookup: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') lookup[part.type] = part.value;
  }
  const year = Number(lookup.year);
  const month = Number(lookup.month);
  const day = Number(lookup.day);
  // `hour12: false` renders midnight as "24" in some ICU versions.
  const hour = Number(lookup.hour) % 24;
  const minute = Number(lookup.minute);
  if (![year, month, day, hour, minute].every(Number.isFinite)) return null;
  const weekday = WEEKDAY_INDEX[lookup.weekday ?? ''];
  if (weekday === undefined) return null;
  const pad = (value: number) => String(value).padStart(2, '0');
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    weekday,
    minuteOfDay: hour * 60 + minute,
    hour,
    minute,
  };
}

/**
 * Classifies one instant into a U.S. equity session.
 *
 * Weekends are `closed`. Inside a weekday:
 * `04:00–09:30` pre, `09:30–16:00` regular, `16:00–20:00` post, else `closed`.
 */
export function classifyUsEquitySession(input: SessionClassificationInput): MarketSession {
  const local = exchangeLocalTime(input.unixSeconds, input.exchangeTimezone ?? US_EQUITY_TIMEZONE);
  if (!local) return 'unknown';
  if (local.weekday === 0 || local.weekday === 6) return 'closed';

  const calendar = input.calendarOverride?.(local.date);
  if (calendar && !calendar.isTradingDay) return 'closed';

  const { preOpen, regularOpen, regularClose, postClose } = US_EQUITY_SESSION_MINUTES;
  const close = calendar?.earlyCloseMinute ?? regularClose;
  const minute = local.minuteOfDay;

  if (minute >= preOpen && minute < regularOpen) return 'pre';
  if (minute >= regularOpen && minute < close) return 'regular';
  // An early close shortens the regular session; the post window still ends at
  // 20:00, which is how the venues actually behave on half days.
  if (minute >= close && minute < postClose) return 'post';
  return 'closed';
}

/** True while bars can still arrive, which is what drives refresh cadence. */
export function isActiveSession(session: MarketSession): boolean {
  return session === 'pre' || session === 'regular' || session === 'post';
}

/**
 * Whether a provider's `marketState` string says the tape is live.
 *
 * Yahoo uses PRE / REGULAR / POST / POSTPOST / PREPRE / CLOSED. `POSTPOST` and
 * `PREPRE` are the dead zones between sessions, so they are not active — the
 * naive `startsWith('POST')` test gets that wrong and polls all night.
 */
export function isActiveMarketState(marketState: string | null | undefined): boolean {
  if (!marketState) return false;
  const state = marketState.trim().toUpperCase();
  return state === 'PRE' || state === 'REGULAR' || state === 'POST';
}

/** Maps a provider `marketState` onto the session vocabulary. */
export function sessionFromMarketState(
  marketState: string | null | undefined,
): MarketSession {
  if (!marketState) return 'unknown';
  switch (marketState.trim().toUpperCase()) {
    case 'PRE':
      return 'pre';
    case 'REGULAR':
      return 'regular';
    case 'POST':
      return 'post';
    case 'PREPRE':
    case 'POSTPOST':
    case 'CLOSED':
      return 'closed';
    default:
      return 'unknown';
  }
}

/** Labels for the session bands and headers. */
export const MARKET_SESSION_LABELS: Record<MarketSession, string> = {
  pre: 'Pre-market',
  regular: 'Regular hours',
  post: 'After hours',
  closed: 'Closed',
  unknown: 'Session unknown',
};
