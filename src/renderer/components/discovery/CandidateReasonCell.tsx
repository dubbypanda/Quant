// The `Why Now` cell: at most two reasons plus a details affordance.
//
// Reasons are observations, not advice — "20-day move is 3.2 sigma", never
// "strong buy". The attention score ranks what to look at; it does not have
// standing to recommend anything.

import React, { useState } from 'react';
import type { DiscoveryCandidate } from '../../../shared/discovery';
import { whyNowReasons } from '../../../shared/discoveryRanking';

interface CandidateReasonCellProps {
  candidate: DiscoveryCandidate;
}

export function CandidateReasonCell({ candidate }: CandidateReasonCellProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const reasons = whyNowReasons(candidate.features, candidate.components);
  const components = candidate.components;

  const breakdown: Array<[string, number]> = [
    ['Abnormal move', components.abnormalMove],
    ['Participation', components.participation],
    ['Relative strength', components.relativeStrength],
    ['Structural change', components.structuralChange],
    ['Model evidence', components.modelEvidence],
    ['Novelty', components.novelty],
    ['Personal relevance', components.personalRelevance],
  ];

  return (
    <div className="dc-why">
      <ul className="dc-reasons">
        {reasons.length ? (
          reasons.map((reason) => <li key={reason}>{reason}</li>)
        ) : (
          <li className="dc-muted">No single standout reason</li>
        )}
      </ul>
      <button
        type="button"
        className="dc-details"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {expanded ? 'Hide detail' : 'Detail'}
      </button>
      {expanded ? (
        <div className="dc-breakdown">
          <ul>
            {breakdown.map(([label, value]) => (
              <li key={label}>
                <span>{label}</span>
                <span>{value.toFixed(1)}</span>
              </li>
            ))}
            {components.qualityPenalty > 0 ? (
              <li className="dc-penalty">
                <span>Data quality penalty</span>
                <span>−{components.qualityPenalty.toFixed(1)}</span>
              </li>
            ) : null}
          </ul>
          {candidate.novelty.changes.length ? (
            <>
              <h5>What changed</h5>
              <ul>
                {candidate.novelty.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            </>
          ) : null}
          {candidate.warnings.length ? (
            <ul className="dc-warnings">
              {candidate.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
