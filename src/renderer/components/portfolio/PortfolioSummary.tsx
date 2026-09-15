// Top-line portfolio figures.
//
// One row of values rather than one card per metric, per section 10's
// instruction to keep the page flat and terminal-like. Incomplete data is
// stated in the strip rather than left for the user to infer from a total that
// looks lower than it should.

import React from 'react';
import type { PortfolioSnapshot } from '../../../shared/portfolio';
import { money, percent, signedMoney, signedPercent, toneOf } from './format';

interface PortfolioSummaryProps {
  snapshot: PortfolioSnapshot | null;
  coveragePercent: number | null;
}

export function PortfolioSummary({
  snapshot,
  coveragePercent,
}: PortfolioSummaryProps): React.ReactElement {
  return (
    <section className="pf-summary" aria-label="Portfolio summary">
      <div className="pf-metrics">
        <div className="pf-metric">
          <span className="pf-metric-label">Portfolio Value</span>
          <span className="pf-metric-value">{money(snapshot?.totalMarketValue)}</span>
        </div>
        <div className="pf-metric">
          <span className="pf-metric-label">Day Change</span>
          <span className={`pf-metric-value ${toneOf(snapshot?.dayChange)}`}>
            {signedMoney(snapshot?.dayChange)}
            <small>{signedPercent(snapshot?.dayChangePercent)}</small>
          </span>
        </div>
        <div className="pf-metric">
          <span className="pf-metric-label">Unrealized P/L</span>
          <span className={`pf-metric-value ${toneOf(snapshot?.unrealizedPnl)}`}>
            {signedMoney(snapshot?.unrealizedPnl)}
            <small>{signedPercent(snapshot?.unrealizedPnlPercent)}</small>
          </span>
        </div>
        <div className="pf-metric">
          <span className="pf-metric-label">Cash</span>
          <span className="pf-metric-value">{money(snapshot?.totalCash)}</span>
        </div>
        <div className="pf-metric">
          <span className="pf-metric-label">Cost Basis</span>
          <span className="pf-metric-value">{money(snapshot?.totalCostBasis)}</span>
        </div>
      </div>

      {snapshot && snapshot.dataHealth !== 'complete' ? (
        <p className="pf-warning" role="status">
          {snapshot.dataHealth === 'unavailable'
            ? 'No position could be priced, so portfolio value is unavailable.'
            : `${snapshot.unpricedSymbols.join(', ')} could not be priced and ${
                snapshot.unpricedSymbols.length === 1 ? 'is' : 'are'
              } excluded from totals.`}
        </p>
      ) : null}

      {coveragePercent !== null && coveragePercent < 100 ? (
        <p className="pf-note">
          Known classification covers {percent(coveragePercent, 1)} of portfolio value.
        </p>
      ) : null}
    </section>
  );
}
