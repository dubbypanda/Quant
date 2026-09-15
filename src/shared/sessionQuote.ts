// Session-aware price presentation for the symbol header.
//
// The rule this module enforces: never mix bases. A regular-session move and an
// extended-hours move are measured from different starting points, so adding
// them together to produce one combined percentage invents a number that
// describes nothing. They are presented as two lines with two labels, and the
// basis of the extended-hours percentage is stated in the caption rather than
// left for the reader to assume.

import type { ChartData, MarketSession } from './types';
import { isActiveMarketState, sessionFromMarketState } from './marketSession';

export interface SessionQuotePresentation {
  primaryLabel: string;
  primaryPrice: string;
  primaryChange: string | null;
  secondaryLabel: 'Pre-Market' | 'After Hours' | null;
  secondaryPrice: string | null;
  secondaryChange: string | null;
  /** Date/time qualifier for a stale extended-hours value, e.g. after the post
   *  session has ended. Null while the quote is current. */
  secondaryAsOf: string | null;
  /** Which basis the extended-hours percentage uses. Shown in the tooltip and
   *  exposed to assistive tech. */
  secondaryBasisCaption: string | null;
  session: MarketSession;
  sessionLabel: string;
}

const SESSION_LABELS: Record<MarketSession, string> = {
  pre: 'Pre-market',
  regular: 'Regular hours',
  post: 'After hours',
  closed: 'Closed',
  unknown: 'Session unknown',
};

export const PROVIDER_PERCENT_CAPTION =
  'Change is the percentage reported by the data provider for this session.';
export const REGULAR_CLOSE_PERCENT_CAPTION =
  'Change is measured against the regular-session close.';

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function signed(value: number, digits = 2): string {
  return `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
}

function changeText(change: number | null, changePercent: number | null): string | null {
  if (change === null && changePercent === null) return null;
  const parts: string[] = [];
  if (change !== null) parts.push(`${change >= 0 ? '+' : '-'}$${Math.abs(change).toFixed(2)}`);
  if (changePercent !== null) parts.push(`(${signed(changePercent)}%)`);
  return parts.join(' ');
}

function finite(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function formatAsOf(iso: string | null, nowUnixSeconds: number): string | null {
  if (!iso) return null;
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return null;
  const ageSeconds = nowUnixSeconds - Math.floor(stamp / 1000);
  // Inside the same session the value is current and needs no qualifier.
  if (ageSeconds < 4 * 60 * 60) return null;
  return new Date(stamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/**
 * Builds the two-line header presentation.
 *
 * `session` is taken from the provider's `marketState` when it is present,
 * because that is the venue's own view, and falls back to the last bar's
 * classified session otherwise.
 */
export function buildSessionQuotePresentation(
  data: ChartData,
  nowUnixSeconds: number,
): SessionQuotePresentation {
  const lastCandle = data.candles[data.candles.length - 1];
  const stateSession = sessionFromMarketState(data.marketState);
  const session: MarketSession =
    stateSession !== 'unknown' ? stateSession : lastCandle?.session ?? 'unknown';

  const regularPrice = finite(data.regularMarketPrice) ?? finite(lastCandle?.close) ?? null;
  const previousClose = finite(data.previousClose);
  const regularChange =
    regularPrice !== null && previousClose !== null ? regularPrice - previousClose : null;
  const regularChangePercent =
    regularChange !== null && previousClose !== null && previousClose !== 0
      ? (regularChange / previousClose) * 100
      : null;

  // Which extended-hours window to show:
  //   PRE            -> the pre-market quote
  //   POST           -> the after-hours quote
  //   REGULAR        -> nothing; a pre-market quote from this morning is
  //                     historical context, and showing it live would read as
  //                     a second current price
  //   CLOSED         -> the most recent post-market value, date-qualified
  let window: 'pre' | 'post' | null = null;
  if (session === 'pre') window = 'pre';
  else if (session === 'post') window = 'post';
  else if (session === 'closed' || session === 'unknown') {
    if (data.postMarket?.price !== undefined && data.postMarket?.price !== null) window = 'post';
    else if (data.preMarket?.price !== undefined && data.preMarket?.price !== null) window = 'pre';
  }

  const quote = window === 'pre' ? data.preMarket : window === 'post' ? data.postMarket : null;
  const secondaryPriceValue = finite(quote?.price ?? null);

  let secondaryChangeText: string | null = null;
  let secondaryBasisCaption: string | null = null;
  if (secondaryPriceValue !== null) {
    const providerChange = finite(quote?.change ?? null);
    const providerPercent = finite(quote?.changePercent ?? null);
    if (providerChange !== null || providerPercent !== null) {
      // The provider gave an authoritative figure for this session; use it and
      // say so, rather than recomputing against a base it may not have used.
      secondaryChangeText = changeText(providerChange, providerPercent);
      secondaryBasisCaption = PROVIDER_PERCENT_CAPTION;
    } else if (regularPrice !== null && regularPrice !== 0) {
      const derivedChange = secondaryPriceValue - regularPrice;
      secondaryChangeText = changeText(derivedChange, (derivedChange / regularPrice) * 100);
      secondaryBasisCaption = REGULAR_CLOSE_PERCENT_CAPTION;
    }
  }

  return {
    primaryLabel: session === 'regular' || isActiveMarketState(data.marketState) ? 'Last' : 'Close',
    primaryPrice: regularPrice === null ? '—' : money(regularPrice),
    primaryChange: changeText(regularChange, regularChangePercent),
    secondaryLabel:
      secondaryPriceValue === null ? null : window === 'pre' ? 'Pre-Market' : 'After Hours',
    secondaryPrice: secondaryPriceValue === null ? null : money(secondaryPriceValue),
    secondaryChange: secondaryPriceValue === null ? null : secondaryChangeText,
    secondaryAsOf:
      secondaryPriceValue === null ? null : formatAsOf(quote?.updatedAt ?? null, nowUnixSeconds),
    secondaryBasisCaption: secondaryPriceValue === null ? null : secondaryBasisCaption,
    session,
    sessionLabel: SESSION_LABELS[session],
  };
}
