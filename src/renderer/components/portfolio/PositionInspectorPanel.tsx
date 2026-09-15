// The chart workspace's Position tab (Plan 02 section 11, Plan 03 Task 7).
//
// Two independent statements, never blended: the instrument decision comes from
// the signal engine and is passed in untouched, and the portfolio context is
// computed separately. A portfolio rule must never rewrite what the model said,
// because the model's conclusion is recorded as history.

import React from 'react';
import type { PortfolioActionContext, SymbolPortfolioContext } from '../../../shared/portfolio';
import { PORTFOLIO_ACTION_LABELS } from '../../../shared/portfolio';
import { money, percent, quantity, signedMoney, toneOf } from './format';

interface PositionInspectorPanelProps {
  symbol: string;
  context: SymbolPortfolioContext | null;
  action: PortfolioActionContext | null;
  loading: boolean;
  /** The instrument decision, rendered verbatim beside the portfolio context. */
  instrumentDecisionLabel?: string | null;
}

const WARNING_CONTEXTS: PortfolioActionContext[] = [
  'concentration-warning',
  'risk-budget-warning',
  'overlap-warning',
];

export function PositionInspectorPanel({
  symbol,
  context,
  action,
  loading,
  instrumentDecisionLabel,
}: PositionInspectorPanelProps): React.ReactElement {
  if (loading) return <p className="cv3-empty">Reading your portfolio…</p>;

  const isWarning = action !== null && WARNING_CONTEXTS.includes(action);

  return (
    <section className="pf-inspector" aria-label={`Portfolio position in ${symbol}`}>
      {instrumentDecisionLabel ? (
        <dl className="pf-rows">
          <div className="pf-row">
            <dt>Instrument decision</dt>
            <dd>{instrumentDecisionLabel}</dd>
          </div>
          <div className="pf-row">
            <dt>Portfolio context</dt>
            <dd className={isWarning ? 'down' : ''}>
              {action ? PORTFOLIO_ACTION_LABELS[action] : '—'}
            </dd>
          </div>
        </dl>
      ) : null}

      {context?.owned ? (
        <>
          <h4>Your Position</h4>
          <dl className="pf-rows">
            <div className="pf-row">
              <dt>Shares</dt>
              <dd>{quantity(context.quantity)}</dd>
            </div>
            <div className="pf-row">
              <dt>Avg cost</dt>
              <dd>{money(context.averageCost)}</dd>
            </div>
            <div className="pf-row">
              <dt>Market value</dt>
              <dd>{money(context.marketValue)}</dd>
            </div>
            <div className="pf-row">
              <dt>Unrealized P/L</dt>
              <dd className={toneOf(context.unrealizedPnl)}>{signedMoney(context.unrealizedPnl)}</dd>
            </div>
            <div className="pf-row">
              <dt>Portfolio weight</dt>
              <dd>{percent(context.weightPercent, 1)}</dd>
            </div>
            <div className="pf-row">
              <dt>Risk contribution</dt>
              <dd>{percent(context.componentRiskPercent, 1)}</dd>
            </div>
            {context.indirectExposurePercent !== null ? (
              <div className="pf-row" title="Exposure through funds you hold, from top-holdings data only.">
                <dt>Via funds</dt>
                <dd>{percent(context.indirectExposurePercent, 1)}</dd>
              </div>
            ) : null}
          </dl>
          <p className="cv3-caption">
            Cost-basis and lot lines are not drawn on the chart by default. Enable the Position
            overlay to show them.
          </p>
        </>
      ) : (
        <p className="cv3-empty">
          You do not hold {symbol}.
          {context?.indirectExposurePercent
            ? ` Known fund exposure is ${percent(context.indirectExposurePercent, 1)}.`
            : ''}
        </p>
      )}
    </section>
  );
}
