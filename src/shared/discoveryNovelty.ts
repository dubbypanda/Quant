// Novelty: what CHANGED since the previous completed scan.
//
// The design point is that novelty is not bullishness. A symbol that has been
// strong and unchanged for three weeks scores zero here, because there is
// nothing new to look at. A symbol whose regime just flipped scores highly even
// if its absolute reading is mediocre — that is the thing worth a human's
// attention today.
//
// Every increase is tied to a *crossing*, so repeatedly strong but static
// symbols lose novelty naturally rather than by an explicit decay rule.

import type { DiscoveryFeatures, NoveltyResult } from './discovery';
import type { TradeDecision } from './quant';

/** The subset of a prior scan that novelty needs. */
export interface DiscoverySnapshotEntry {
  symbol: string;
  regime: DiscoveryFeatures['regime'];
  returnZ20: number | null;
  volumeZ60: number | null;
  relativeStrengthPercentile126: number | null;
  decision: TradeDecision | null;
  attentionRank: number | null;
}

export interface DiscoverySnapshot {
  id: string;
  completedAt: string;
  entries: Record<string, DiscoverySnapshotEntry>;
}

export interface NoveltyInput {
  features: DiscoveryFeatures;
  decision: TradeDecision | null;
  /** 1-based rank in the current run, or null when unranked. */
  attentionRank: number | null;
  prior: DiscoverySnapshotEntry | null;
  /** True when there is no prior scan at all. */
  firstScan?: boolean;
}

const POINTS = {
  regimeChange: 3,
  returnZCrossing: 2.5,
  volumeZCrossing: 2,
  relativeStrengthJump: 1.5,
  enteredTopTwentyFive: 2,
  decisionChange: 2.5,
} as const;

export const NOVELTY_MAX = 10;

/**
 * Scores what changed.
 *
 * On the very first scan there is nothing to compare against, so novelty is 0
 * with an explanatory note rather than a maximum — a first run would otherwise
 * mark the entire universe as novel.
 */
export function calculateNovelty(input: NoveltyInput): NoveltyResult {
  const { features, prior } = input;
  if (!prior) {
    return {
      score: 0,
      changes: input.firstScan
        ? ['First scan; nothing to compare against yet']
        : ['Not seen in the previous scan'],
    };
  }

  let score = 0;
  const changes: string[] = [];

  if (prior.regime !== features.regime) {
    score += POINTS.regimeChange;
    changes.push(`Regime changed from ${prior.regime} to ${features.regime}`);
  }

  // Crossings, not levels: a z-score that was already above 2 and still is has
  // not changed.
  if (
    prior.returnZ20 !== null &&
    features.returnZ20 !== null &&
    prior.returnZ20 < 1 &&
    features.returnZ20 > 2
  ) {
    score += POINTS.returnZCrossing;
    changes.push(`Return z-score crossed from ${prior.returnZ20.toFixed(1)} to ${features.returnZ20.toFixed(1)}`);
  }
  if (
    prior.returnZ20 !== null &&
    features.returnZ20 !== null &&
    prior.returnZ20 > -1 &&
    features.returnZ20 < -2
  ) {
    score += POINTS.returnZCrossing;
    changes.push(`Return z-score fell to ${features.returnZ20.toFixed(1)}`);
  }

  if (
    prior.volumeZ60 !== null &&
    features.volumeZ60 !== null &&
    prior.volumeZ60 < 1 &&
    features.volumeZ60 > 2
  ) {
    score += POINTS.volumeZCrossing;
    changes.push('Volume moved from normal to unusually high');
  }

  if (
    prior.relativeStrengthPercentile126 !== null &&
    features.relativeStrengthPercentile126 !== null
  ) {
    const jump = features.relativeStrengthPercentile126 - prior.relativeStrengthPercentile126;
    if (Math.abs(jump) >= 20) {
      score += POINTS.relativeStrengthJump;
      changes.push(
        `Relative strength ${jump > 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(jump))} percentile points`,
      );
    }
  }

  // Entering the top 25 from outside the top 100 is a real change in standing;
  // moving from 30th to 24th is not.
  if (
    input.attentionRank !== null &&
    input.attentionRank <= 25 &&
    (prior.attentionRank === null || prior.attentionRank > 100)
  ) {
    score += POINTS.enteredTopTwentyFive;
    changes.push('Entered the top 25 from outside the top 100');
  }

  if (prior.decision !== input.decision && input.decision !== null) {
    score += POINTS.decisionChange;
    changes.push(
      `Signal decision changed from ${prior.decision ?? 'none'} to ${input.decision}`,
    );
  }

  return { score: Math.min(NOVELTY_MAX, score), changes };
}

/** Builds the snapshot entry to persist for the next run's comparison. */
export function toSnapshotEntry(args: {
  features: DiscoveryFeatures;
  decision: TradeDecision | null;
  attentionRank: number | null;
}): DiscoverySnapshotEntry {
  return {
    symbol: args.features.symbol,
    regime: args.features.regime,
    returnZ20: args.features.returnZ20,
    volumeZ60: args.features.volumeZ60,
    relativeStrengthPercentile126: args.features.relativeStrengthPercentile126,
    decision: args.decision,
    attentionRank: args.attentionRank,
  };
}
