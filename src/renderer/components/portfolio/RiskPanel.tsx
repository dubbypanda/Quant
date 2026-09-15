// Risk figures, with every limitation stated rather than implied.

import React from 'react';
import type { PortfolioRiskReport } from '../../../shared/portfolioRisk';
import { percent } from './format';

interface RiskPanelProps {
  risk: PortfolioRiskReport | null;
  loading: boolean;
}

export function RiskPanel({ risk, loading }: RiskPanelProps): React.ReactElement {
  if (loading && !risk) return <p className="pf-empty">Measuring risk…</p>;
  if (!risk) return <p className="pf-empty">Risk is unavailable.</p>;

  const rows: Array<{ label: string; value: string; title?: string }> = [
    {
      label: 'Annualized volatility',
      value: percent(risk.annualizedVolatilityPercent, 1),
      title: 'Standard deviation of daily portfolio returns, scaled by the square root of 252.',
    },
    { label: 'Beta vs SPY', value: risk.betaToSpy === null ? '—' : risk.betaToSpy.toFixed(2) },
    { label: 'Max drawdown', value: percent(risk.maxDrawdownPercent, 1) },
    {
      label: '1-day VaR 95%',
      value: percent(risk.oneDayVaR95Percent, 2),
      title: 'Empirical 5th percentile of daily returns, shown as a loss magnitude. No normality assumed.',
    },
    {
      label: '1-day CVaR 95%',
      value: percent(risk.oneDayCVaR95Percent, 2),
      title: 'Average loss on the days at or beyond the 95% VaR threshold.',
    },
    {
      label: 'Diversification ratio',
      value: risk.diversificationRatio === null ? '—' : risk.diversificationRatio.toFixed(2),
      title: 'Weighted average standalone volatility over portfolio volatility. Above 1 means correlation is helping.',
    },
    { label: 'Lookback', value: `${risk.lookbackTradingDays} trading days` },
  ];

  return (
    <section className="pf-panel" aria-label="Risk">
      <h3>Risk</h3>
      <dl className="pf-rows">
        {rows.map((row) => (
          <div key={row.label} className="pf-row" title={row.title}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {risk.contributions.length ? (
        <>
          <h4>Risk contribution</h4>
          <ul className="pf-bars">
            {[...risk.contributions]
              .sort((a, b) => (b.componentRiskPercent ?? 0) - (a.componentRiskPercent ?? 0))
              .map((contribution) => (
                <li key={contribution.symbol}>
                  <span className="pf-bar-label">{contribution.symbol}</span>
                  <span className="pf-bar-track" aria-hidden="true">
                    <span
                      className="pf-bar-fill"
                      style={{
                        width: `${Math.max(0, Math.min(100, contribution.componentRiskPercent ?? 0))}%`,
                      }}
                    />
                  </span>
                  <span className="pf-bar-value">
                    {percent(contribution.componentRiskPercent, 1)}
                  </span>
                </li>
              ))}
          </ul>
        </>
      ) : null}

      {risk.warnings.length ? (
        <ul className="pf-warnings" role="status">
          {risk.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
