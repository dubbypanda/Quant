// One Today group.

import React from 'react';
import type { DiscoveryCandidate } from '../../../shared/discovery';
import { whyNowReasons } from '../../../shared/discoveryRanking';

export interface TodayItem {
  candidate: DiscoveryCandidate;
  /** Groups other than the primary one this symbol also qualified for. */
  secondaryGroups: string[];
}

interface TodaySectionProps {
  title: string;
  description: string;
  items: TodayItem[];
  onOpenSymbol: (symbol: string) => void;
}

export function TodaySection({
  title,
  description,
  items,
  onOpenSymbol,
}: TodaySectionProps): React.ReactElement | null {
  if (!items.length) return null;
  return (
    <section className="td-section" aria-label={title}>
      <header className="td-section-head">
        <h3>{title}</h3>
        <p>{description}</p>
      </header>
      <ul className="td-cards">
        {items.map(({ candidate, secondaryGroups }) => (
          <li key={candidate.symbol}>
            <button
              type="button"
              className="td-card"
              onClick={() => onOpenSymbol(candidate.symbol)}
            >
              <span className="td-card-head">
                <span className="td-card-symbol">{candidate.symbol}</span>
                <span className="td-card-attention">{candidate.attentionScore.toFixed(0)}</span>
              </span>
              <span className="td-card-name">{candidate.name}</span>
              <span className="td-card-reasons">
                {whyNowReasons(candidate.features, candidate.components, 2).map((reason) => (
                  <span key={reason} className="td-reason">
                    {reason}
                  </span>
                ))}
              </span>
              {/* A symbol can qualify for several groups; it appears once with
                  chips rather than as four duplicate cards. */}
              {secondaryGroups.length ? (
                <span className="td-chips">
                  {secondaryGroups.map((group) => (
                    <span key={group} className="td-chip">
                      {group}
                    </span>
                  ))}
                </span>
              ) : null}
              {candidate.warnings.length ? (
                <span className="td-card-warning">{candidate.warnings[0]}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
