// Exposure, including fund look-through — presented as a floor, not a total.

import React from 'react';
import type { PortfolioExposureReport } from '../../../shared/portfolioExposure';
import { percent } from './format';

interface ExposurePanelProps {
  exposure: PortfolioExposureReport | null;
  loading: boolean;
}

function SliceList({
  title,
  slices,
}: {
  title: string;
  slices: Array<{ key: string; weightPercent: number }>;
}): React.ReactElement | null {
  if (!slices.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="pf-bars">
        {slices.slice(0, 8).map((slice) => (
          <li key={slice.key}>
            <span className="pf-bar-label">{slice.key}</span>
            <span className="pf-bar-track" aria-hidden="true">
              <span
                className="pf-bar-fill"
                style={{ width: `${Math.max(0, Math.min(100, slice.weightPercent))}%` }}
              />
            </span>
            <span className="pf-bar-value">{percent(slice.weightPercent, 1)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

export function ExposurePanel({ exposure, loading }: ExposurePanelProps): React.ReactElement {
  if (loading && !exposure) return <p className="pf-empty">Measuring exposure…</p>;
  if (!exposure) return <p className="pf-empty">Exposure is unavailable.</p>;

  return (
    <section className="pf-panel" aria-label="Exposure">
      <h3>Exposure</h3>

      <SliceList title="Asset types" slices={exposure.assetType} />
      <SliceList title="Sectors" slices={exposure.sector} />

      {exposure.topUnderlying.length ? (
        <>
          <h4>Underlying overlap</h4>
          <div className="pf-table-wrap">
            <table className="pf-table pf-table-compact">
              <thead>
                <tr>
                  <th scope="col">Symbol</th>
                  <th scope="col" className="num">Direct</th>
                  <th scope="col" className="num">Via funds</th>
                  <th scope="col" className="num">Combined known</th>
                </tr>
              </thead>
              <tbody>
                {exposure.topUnderlying.map((item) => (
                  <tr key={item.symbol}>
                    <th scope="row">{item.symbol}</th>
                    {/* Direct and indirect stay in separate columns; only the
                        final column sums them, and it says "known". */}
                    <td className="num">{percent(item.directWeightPercent, 1)}</td>
                    <td className="num">{percent(item.indirectWeightPercent, 1)}</td>
                    <td className="num">{percent(item.combinedKnownWeightPercent, 1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      <h4>Concentration</h4>
      <dl className="pf-rows">
        <div className="pf-row">
          <dt>Largest position</dt>
          <dd>{percent(exposure.concentration.top1Percent, 1)}</dd>
        </div>
        <div className="pf-row">
          <dt>Top 3</dt>
          <dd>{percent(exposure.concentration.top3Percent, 1)}</dd>
        </div>
        <div className="pf-row">
          <dt>Top 5</dt>
          <dd>{percent(exposure.concentration.top5Percent, 1)}</dd>
        </div>
        <div className="pf-row" title="Herfindahl-Hirschman index over direct position weights.">
          <dt>HHI</dt>
          <dd>{exposure.concentration.hhi.toFixed(0)}</dd>
        </div>
        <div className="pf-row">
          <dt>Classification coverage</dt>
          <dd>{percent(exposure.coveragePercent, 1)}</dd>
        </div>
      </dl>

      {exposure.warnings.length ? (
        <ul className="pf-warnings" role="status">
          {exposure.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
