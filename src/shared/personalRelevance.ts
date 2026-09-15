// Personal relevance: why the user should care, not whether to buy.
//
// The distinction matters because relevance is about the user's situation and
// says nothing about the instrument. A symbol correlated with a big position is
// relevant whether it is a good idea or a bad one.
//
// The labelling rule from docs/quant-v3/04 section 13 is enforced here: low
// correlation is described as "low observed correlation to portfolio", never as
// "good diversification", because whether diversifying is good depends on
// intent this module does not know.

import type { PersonalRelevance } from './discovery';

export interface PersonalRelevanceInput {
  symbol: string;
  /** Direct portfolio weight, percent. */
  ownedWeightPercent: number | null;
  /** Known exposure through funds the user holds, percent. */
  indirectWeightPercent: number | null;
  /** Return correlation to the portfolio over a common window, −1..1. */
  correlationToPortfolio: number | null;
  /** Sector of this symbol, and the user's concentrated sectors. */
  sector: string | null;
  concentratedSectors?: string[];
  /** An upcoming event affecting a symbol the user owns. */
  upcomingEventTitle?: string | null;
}

const POINTS = {
  owned: 6,
  indirect: 3,
  correlated: 2,
  sector: 2,
  diversifier: 1,
  event: 2,
} as const;

export const PERSONAL_RELEVANCE_MAX = 10;

export function calculatePersonalRelevance(input: PersonalRelevanceInput): PersonalRelevance {
  const reasons: PersonalRelevance['reasons'] = [];
  let score = 0;

  const owned = input.ownedWeightPercent;
  if (owned !== null && owned > 0) {
    score += POINTS.owned;
    reasons.push({
      kind: 'owned',
      text: `You hold ${input.symbol} at ${owned.toFixed(1)}% of the portfolio`,
      value: owned,
    });
  }

  const indirect = input.indirectWeightPercent;
  if (indirect !== null && indirect > 0.5) {
    score += POINTS.indirect;
    reasons.push({
      kind: 'indirect-exposure',
      text: `Known exposure of ${indirect.toFixed(1)}% through funds you hold`,
      value: indirect,
    });
  }

  const correlation = input.correlationToPortfolio;
  if (correlation !== null && Number.isFinite(correlation)) {
    if (Math.abs(correlation) >= 0.6) {
      score += POINTS.correlated;
      reasons.push({
        kind: 'correlated',
        text: `Return correlation of ${correlation.toFixed(2)} to your portfolio`,
        value: correlation,
      });
    } else if (Math.abs(correlation) <= 0.2) {
      score += POINTS.diversifier;
      // Deliberately descriptive. Calling this "good diversification" would be
      // advice this module is not entitled to give.
      reasons.push({
        kind: 'diversifier',
        text: `Low observed correlation to portfolio (${correlation.toFixed(2)})`,
        value: correlation,
      });
    }
  }

  if (input.sector && (input.concentratedSectors ?? []).includes(input.sector)) {
    score += POINTS.sector;
    reasons.push({
      kind: 'sector',
      text: `Same sector as a concentrated position (${input.sector})`,
    });
  }

  if (input.upcomingEventTitle) {
    score += POINTS.event;
    reasons.push({ kind: 'event', text: input.upcomingEventTitle });
  }

  return { score: Math.min(PERSONAL_RELEVANCE_MAX, score), reasons };
}
