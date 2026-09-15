// Session-aware price header.
//
// Two lines, two bases, never summed. `buildSessionQuotePresentation` owns the
// arithmetic and the basis caption; this component only lays it out, so the
// "never add pre/post change to regular change" rule cannot be broken by a
// well-meaning edit here.

import React, { useMemo } from 'react';
import type { ChartData } from '../../../shared/types';
import { buildSessionQuotePresentation } from '../../../shared/sessionQuote';

interface SymbolHeaderProps {
  symbol: string;
  companyName?: string;
  data: ChartData | null;
  /** True while a newer payload is in flight; the header keeps showing the
   *  current numbers rather than blanking. */
  refreshing?: boolean;
}

function toneClass(text: string | null): string {
  if (!text) return '';
  if (text.startsWith('+')) return ' up';
  if (text.startsWith('-')) return ' down';
  return '';
}

export function SymbolHeader({
  symbol,
  companyName,
  data,
  refreshing = false,
}: SymbolHeaderProps): React.ReactElement {
  const presentation = useMemo(
    () => (data ? buildSessionQuotePresentation(data, Math.floor(Date.now() / 1000)) : null),
    [data],
  );

  return (
    <header className="cv3-symbol-header">
      <div className="cv3-identity">
        <h2 className="cv3-symbol">{symbol}</h2>
        {companyName ? <p className="cv3-company">{companyName}</p> : null}
      </div>

      <div className="cv3-quote">
        <div className="cv3-quote-primary">
          <span className="cv3-price">{presentation?.primaryPrice ?? '—'}</span>
          {presentation?.primaryChange ? (
            <span className={`cv3-change${toneClass(presentation.primaryChange)}`}>
              {presentation.primaryChange}
            </span>
          ) : null}
        </div>

        {presentation?.secondaryLabel ? (
          <div className="cv3-quote-secondary" title={presentation.secondaryBasisCaption ?? undefined}>
            <span className="cv3-session-tag">{presentation.secondaryLabel}</span>
            <span className="cv3-secondary-price">{presentation.secondaryPrice}</span>
            {presentation.secondaryChange ? (
              <span className={`cv3-change${toneClass(presentation.secondaryChange)}`}>
                {presentation.secondaryChange}
              </span>
            ) : null}
            {presentation.secondaryAsOf ? (
              <span className="cv3-as-of">as of {presentation.secondaryAsOf}</span>
            ) : null}
            {/* The basis is announced, not merely hinted at in a tooltip. */}
            <span className="cv3-visually-hidden">{presentation.secondaryBasisCaption}</span>
          </div>
        ) : null}
      </div>

      <div className="cv3-header-meta">
        <span className="cv3-session-state">{presentation?.sessionLabel ?? 'Session unknown'}</span>
        {data?.cache?.stale ? (
          // Stale means the network failed and this is the last good payload.
          // Saying so is the whole point of keeping the flag.
          <span className="cv3-stale" role="status">
            Showing last available data
          </span>
        ) : null}
        {data?.source === 'sample' ? (
          <span className="cv3-sample" role="status">
            Sample data
          </span>
        ) : null}
        {refreshing ? (
          <span className="cv3-refreshing" aria-live="polite">
            Updating…
          </span>
        ) : null}
      </div>
    </header>
  );
}
