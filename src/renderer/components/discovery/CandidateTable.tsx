// The Discover table.
//
// Columns per docs/quant-v3/04 section 16. The Attention column is labelled
// `Attention`, never Confidence, and the caption says what it is not.

import React from 'react';
import type { DiscoveryCandidate } from '../../../shared/discovery';
import { ATTENTION_CAPTION, ATTENTION_LABEL } from '../../../shared/discovery';
import { CandidateReasonCell } from './CandidateReasonCell';

interface CandidateTableProps {
  candidates: DiscoveryCandidate[];
  onOpenSymbol: (symbol: string) => void;
}

function number(value: number | null | undefined, digits = 1, suffix = ''): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}${suffix}`;
}

function tone(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value === 0) return '';
  return value > 0 ? 'up' : 'down';
}

function dataAgeLabel(seconds: number): string {
  if (seconds < 36 * 60 * 60) return 'current';
  const days = Math.round(seconds / (24 * 60 * 60));
  return `${days}d old`;
}

export function CandidateTable({
  candidates,
  onOpenSymbol,
}: CandidateTableProps): React.ReactElement {
  if (!candidates.length) {
    return <p className="dc-empty">No research candidates in the last scan.</p>;
  }

  return (
    <div className="dc-table-wrap">
      <table className="dc-table">
        <caption>{ATTENTION_CAPTION}</caption>
        <thead>
          <tr>
            <th scope="col">Symbol</th>
            <th scope="col" className="num">{ATTENTION_LABEL}</th>
            <th scope="col">Why Now</th>
            <th scope="col">Signal</th>
            <th scope="col" className="num">1D</th>
            <th scope="col" className="num">Volume</th>
            <th scope="col" className="num">RS</th>
            <th scope="col" className="num">Novelty</th>
            <th scope="col">Data</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((candidate) => {
            const stale = candidate.dataAgeSeconds > 36 * 60 * 60;
            return (
              <tr key={candidate.symbol} className={stale ? 'dc-stale-row' : ''}>
                <th scope="row">
                  <button type="button" className="dc-symbol" onClick={() => onOpenSymbol(candidate.symbol)}>
                    {candidate.symbol}
                  </button>
                  <span className="dc-name">{candidate.name}</span>
                  <span className="dc-asset">{candidate.assetType}</span>
                </th>
                <td className="num dc-attention">{candidate.attentionScore.toFixed(0)}</td>
                <td>
                  <CandidateReasonCell candidate={candidate} />
                </td>
                <td>
                  {candidate.decision ? (
                    <span className={`dc-decision dc-decision-${candidate.decision}`}>
                      {candidate.decision}
                      {candidate.setupQuality !== null ? (
                        <small>{candidate.setupQuality}/100</small>
                      ) : null}
                    </span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className={`num ${tone(candidate.features.return1)}`}>
                  {number(candidate.features.return1, 2, '%')}
                </td>
                <td className="num">{number(candidate.features.volumeRatio20, 2, '×')}</td>
                <td className="num">
                  {number(candidate.features.relativeStrengthPercentile126, 0)}
                </td>
                <td className="num">{number(candidate.novelty.score, 1)}</td>
                <td className={stale ? 'down' : ''}>{dataAgeLabel(candidate.dataAgeSeconds)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
