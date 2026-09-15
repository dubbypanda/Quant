// The positions table.
//
// Copy says "Positions", never "Holdings": `Holding` is an ETF constituent
// elsewhere in Quant, and reusing the word here is exactly the ambiguity
// section 1 forbids.

import React from 'react';
import type { PortfolioPosition } from '../../../shared/portfolio';
import type { PortfolioRiskReport } from '../../../shared/portfolioRisk';
import { money, percent, quantity, signedMoney, signedPercent, toneOf } from './format';

interface PositionsTableProps {
  positions: PortfolioPosition[];
  risk: PortfolioRiskReport | null;
  onOpenSymbol?: (symbol: string) => void;
}

export function PositionsTable({
  positions,
  risk,
  onOpenSymbol,
}: PositionsTableProps): React.ReactElement {
  const riskBySymbol = new Map(
    (risk?.contributions ?? []).map((item) => [item.symbol, item.componentRiskPercent]),
  );

  if (!positions.length) {
    return (
      <p className="pf-empty">
        No positions yet. Add one, or import a CSV, to see value, P/L and risk.
      </p>
    );
  }

  return (
    <div className="pf-table-wrap">
      <table className="pf-table">
        <caption className="cv3-visually-hidden">
          Your positions with quantity, cost, value, change, profit and loss, weight and risk
          contribution
        </caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col" className="num">Qty</th>
            <th scope="col" className="num">Avg Cost</th>
            <th scope="col" className="num">Price</th>
            <th scope="col" className="num">Value</th>
            <th scope="col" className="num">Day</th>
            <th scope="col" className="num">Total P/L</th>
            <th scope="col" className="num">Weight</th>
            <th scope="col" className="num">Risk %</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((position) => (
            <tr key={position.symbol}>
              <th scope="row">
                {onOpenSymbol ? (
                  <button type="button" className="pf-symbol" onClick={() => onOpenSymbol(position.symbol)}>
                    {position.symbol}
                  </button>
                ) : (
                  position.symbol
                )}
                <span className="pf-asset-type">{position.assetType}</span>
                {position.marketValue === null ? (
                  // Named, not silently blank: the user needs to know why this
                  // row has no value rather than assuming it is worthless.
                  <span className="pf-unpriced" title="No price was available for this symbol">
                    unpriced
                  </span>
                ) : null}
              </th>
              <td className="num">{quantity(position.quantity)}</td>
              <td className="num">{money(position.averageCost)}</td>
              <td className="num">{money(position.marketPrice)}</td>
              <td className="num">{money(position.marketValue)}</td>
              <td className={`num ${toneOf(position.dayChange)}`}>
                {signedMoney(position.dayChange)}
              </td>
              <td className={`num ${toneOf(position.unrealizedPnl)}`}>
                {signedMoney(position.unrealizedPnl)}
                <small>{signedPercent(position.unrealizedPnlPercent)}</small>
              </td>
              <td className="num">{percent(position.portfolioWeightPercent, 1)}</td>
              <td className="num">{percent(riskBySymbol.get(position.symbol) ?? null, 1)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
