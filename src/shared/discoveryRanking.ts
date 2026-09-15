// Cross-sectional ranking and attention scoring.
//
// Two rules the module exists to enforce:
//
//   * **Only comparable rows are ranked together.** A stale Friday row cannot
//     be percentile-ranked against current Monday rows: it would win or lose on
//     the calendar rather than on the data. Stale rows are marked ineligible
//     for current-session ranking and get a null percentile.
//   * **Evidence is grouped and capped.** Each attention component has its own
//     ceiling, so the 1-day, 5-day and 20-day versions of one move cannot each
//     claim full marks.

import type {
  AttentionComponents,
  DiscoveryFeatures,
  NoveltyResult,
  PersonalRelevance,
} from './discovery';
import { ATTENTION_COMPONENT_CAPS, emptyAttentionComponents } from './discovery';
import type { HistoricalValidationSummary } from './signalV2';
import type { TradeDecision } from './quant';

/**
 * Average-rank percentile over the non-null values.
 *
 * Ties share their average rank so two identical values cannot be separated by
 * an accident of array order. Symbols are only used to break ties for display
 * ordering, never to alter the score.
 */
export function percentileRank(
  values: Array<{ symbol: string; value: number | null }>,
): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const usable = values.filter(
    (item): item is { symbol: string; value: number } =>
      typeof item.value === 'number' && Number.isFinite(item.value),
  );
  for (const item of values) out.set(item.symbol, null);
  if (usable.length === 0) return out;
  if (usable.length === 1) {
    out.set(usable[0].symbol, 50);
    return out;
  }

  const sorted = [...usable].sort((a, b) => a.value - b.value || a.symbol.localeCompare(b.symbol));
  let index = 0;
  while (index < sorted.length) {
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].value === sorted[index].value) end += 1;
    // Average rank across the tied run.
    const averageRank = (index + end) / 2;
    const percentile = (averageRank / (sorted.length - 1)) * 100;
    for (let i = index; i <= end; i++) out.set(sorted[i].symbol, percentile);
    index = end + 1;
  }
  return out;
}

/** Rows whose newest bar is older than this are not ranked against current ones. */
export const STALE_DATA_SECONDS = 36 * 60 * 60;

export interface RankingRow {
  symbol: string;
  features: DiscoveryFeatures;
  dataAgeSeconds: number;
}

export function isCurrentSession(row: RankingRow): boolean {
  return row.dataAgeSeconds <= STALE_DATA_SECONDS;
}

/**
 * Fills in `relativeStrengthPercentile126` cross-sectionally.
 *
 * Only current rows participate. A stale row keeps a null percentile rather
 * than being ranked against a different session's data.
 */
export function assignRelativeStrengthPercentiles(rows: RankingRow[]): RankingRow[] {
  const current = rows.filter(isCurrentSession);
  const ranks = percentileRank(
    current.map((row) => ({ symbol: row.symbol, value: row.features.return126 })),
  );
  return rows.map((row) => ({
    ...row,
    features: {
      ...row.features,
      relativeStrengthPercentile126: isCurrentSession(row) ? ranks.get(row.symbol) ?? null : null,
    },
  }));
}

/** Maps a 0..1 fraction onto a capped component score. */
function scaled(fraction: number, cap: number): number {
  return Math.max(0, Math.min(cap, fraction * cap));
}

/**
 * Abnormal move, 0..20.
 *
 * Takes the MAXIMUM of the available abnormality measures rather than their
 * sum. That is the whole point of the group cap: the 20-day robust z-score, the
 * benchmark residual and the sector residual are three views of one move, and
 * adding them would pay for the same event three times.
 */
export function abnormalMoveScore(features: DiscoveryFeatures): number {
  const candidates: number[] = [];
  if (features.returnZ20 !== null) {
    // |z| of 3 saturates the component.
    candidates.push(Math.min(1, Math.abs(features.returnZ20) / 3));
  }
  if (features.spyResidual20 !== null) {
    candidates.push(Math.min(1, Math.abs(features.spyResidual20) / 15));
  }
  if (features.sectorResidual20 !== null) {
    candidates.push(Math.min(1, Math.abs(features.sectorResidual20) / 12));
  }
  if (features.spyResidual5 !== null) {
    candidates.push(Math.min(1, Math.abs(features.spyResidual5) / 8));
  }
  if (!candidates.length) return 0;
  return scaled(Math.max(...candidates), ATTENTION_COMPONENT_CAPS.abnormalMove);
}

/** Participation, 0..15: abnormal volume plus liquidity quality. */
export function participationScore(features: DiscoveryFeatures): number {
  const parts: number[] = [];
  if (features.volumeZ60 !== null) parts.push(Math.min(1, Math.max(0, features.volumeZ60) / 3));
  if (features.volumeRatio20 !== null) {
    parts.push(Math.min(1, Math.max(0, features.volumeRatio20 - 1) / 1.5));
  }
  if (!parts.length) return 0;
  const abnormal = Math.max(...parts);

  // Liquidity is a quality weight on the volume signal, not an independent
  // reason for attention: a thin name doubling its tiny volume is not news.
  const liquidity =
    features.dollarVolumeMedian20 === null
      ? 0.5
      : Math.min(1, Math.max(0.25, Math.log10(Math.max(1, features.dollarVolumeMedian20)) / 9));
  return scaled(abnormal * liquidity, ATTENTION_COMPONENT_CAPS.participation);
}

/** Relative strength, 0..15: cross-sectional rank plus sector-relative move. */
export function relativeStrengthScore(features: DiscoveryFeatures): number {
  const parts: number[] = [];
  if (features.relativeStrengthPercentile126 !== null) {
    // Both tails are interesting: leadership and capitulation.
    const centred = Math.abs(features.relativeStrengthPercentile126 - 50) / 50;
    parts.push(centred);
  }
  if (features.sectorResidual20 !== null) {
    parts.push(Math.min(1, Math.abs(features.sectorResidual20) / 12));
  }
  if (!parts.length) return 0;
  return scaled(Math.max(...parts), ATTENTION_COMPONENT_CAPS.relativeStrength);
}

/** Structural change, 0..15: regime transition, MA structure, volatility
 *  expansion, breakout/compression state. */
export function structuralChangeScore(features: DiscoveryFeatures): number {
  let score = 0;
  if (features.priorRegime !== null && features.priorRegime !== features.regime) {
    score += 0.45;
  }
  if (features.regime === 'breakout-compression' || features.regime === 'high-volatility') {
    score += 0.2;
  }
  if (features.volatilityRatio20To60 !== null && features.volatilityRatio20To60 > 1.4) {
    score += 0.2;
  }
  if (features.distance52wHighPercent !== null && features.distance52wHighPercent <= 2) {
    score += 0.2;
  }
  if (features.distanceMa20Atr !== null && Math.abs(features.distanceMa20Atr) > 2) {
    score += 0.15;
  }
  return scaled(Math.min(1, score), ATTENTION_COMPONENT_CAPS.structuralChange);
}

/**
 * Model evidence, 0..15.
 *
 * Zero during Stage A and populated only after Stage B, and capped at 15 so a
 * backtest can never dominate live market evidence. A null expectancy CI means
 * its sign is unknown — it is not treated as positive.
 */
export function modelEvidenceScore(args: {
  decision: TradeDecision | null;
  historical?: HistoricalValidationSummary | null;
}): number {
  const { decision, historical } = args;
  const isCandidate = decision === 'buy-candidate' || decision === 'short-candidate';
  if (!isCandidate) return 0;
  if (!historical || historical.status !== 'ready') return 2;

  const positiveExpectancy = historical.expectancyR > 0;
  const lowerBound = historical.expectancyCi95?.lower ?? null;

  if (historical.evidenceStrength === 'large-sample' && lowerBound !== null && lowerBound > 0) {
    return 15;
  }
  if (historical.evidenceStrength === 'large-sample' && positiveExpectancy) return 12;
  if (historical.evidenceStrength === 'usable' && positiveExpectancy) return 9;
  if (historical.evidenceStrength === 'thin') return 5;
  return 2;
}

/**
 * Quality penalty, 0..30, subtracted.
 *
 * Stale data is the heaviest penalty: a high score computed from last week's
 * bars is worse than no score, because it looks current.
 */
export function qualityPenalty(args: {
  dataAgeSeconds: number;
  lowLiquidity: boolean;
  historyBars: number;
  minimumHistoryBars: number;
}): number {
  let penalty = 0;
  if (args.dataAgeSeconds > STALE_DATA_SECONDS) {
    penalty += Math.min(18, 6 + (args.dataAgeSeconds - STALE_DATA_SECONDS) / (24 * 60 * 60) * 4);
  }
  if (args.lowLiquidity) penalty += 8;
  if (args.historyBars < args.minimumHistoryBars) penalty += 6;
  return Math.min(ATTENTION_COMPONENT_CAPS.qualityPenalty, penalty);
}

export interface BuildAttentionArgs {
  features: DiscoveryFeatures;
  dataAgeSeconds: number;
  lowLiquidity: boolean;
  historyBars: number;
  minimumHistoryBars: number;
  decision?: TradeDecision | null;
  historical?: HistoricalValidationSummary | null;
  novelty?: NoveltyResult | null;
  personal?: PersonalRelevance | null;
}

export function buildAttentionComponents(args: BuildAttentionArgs): AttentionComponents {
  return {
    ...emptyAttentionComponents(),
    abnormalMove: abnormalMoveScore(args.features),
    participation: participationScore(args.features),
    relativeStrength: relativeStrengthScore(args.features),
    structuralChange: structuralChangeScore(args.features),
    modelEvidence: modelEvidenceScore({
      decision: args.decision ?? null,
      historical: args.historical ?? null,
    }),
    novelty: Math.min(ATTENTION_COMPONENT_CAPS.novelty, Math.max(0, args.novelty?.score ?? 0)),
    personalRelevance: Math.min(
      ATTENTION_COMPONENT_CAPS.personalRelevance,
      Math.max(0, args.personal?.score ?? 0),
    ),
    qualityPenalty: qualityPenalty({
      dataAgeSeconds: args.dataAgeSeconds,
      lowLiquidity: args.lowLiquidity,
      historyBars: args.historyBars,
      minimumHistoryBars: args.minimumHistoryBars,
    }),
  };
}

/**
 * The at most two strongest reasons, for the `Why Now` column.
 *
 * Phrased as observations rather than advice: "20-day move is 3.2 sigma" says
 * what was measured, where "strong buy setup" would be a recommendation the
 * attention score is not entitled to make.
 */
export function whyNowReasons(
  features: DiscoveryFeatures,
  components: AttentionComponents,
  maximum = 2,
): string[] {
  const reasons: Array<{ weight: number; text: string }> = [];

  if (features.returnZ20 !== null && Math.abs(features.returnZ20) >= 1.5) {
    reasons.push({
      weight: components.abnormalMove,
      text: `20-day move is ${features.returnZ20.toFixed(1)} sigma vs its own history`,
    });
  }
  if (features.spyResidual20 !== null && Math.abs(features.spyResidual20) >= 5) {
    reasons.push({
      weight: components.abnormalMove * 0.9,
      text: `${features.spyResidual20 >= 0 ? '+' : ''}${features.spyResidual20.toFixed(1)}% beyond its market beta`,
    });
  }
  if (features.volumeZ60 !== null && features.volumeZ60 >= 2) {
    reasons.push({
      weight: components.participation,
      text: `Volume is ${features.volumeZ60.toFixed(1)} sigma above normal`,
    });
  }
  if (features.priorRegime !== null && features.priorRegime !== features.regime) {
    reasons.push({
      weight: components.structuralChange,
      text: `Regime changed from ${features.priorRegime} to ${features.regime}`,
    });
  }
  if (features.distance52wHighPercent !== null && features.distance52wHighPercent <= 2) {
    reasons.push({
      weight: components.structuralChange * 0.8,
      text: `Within ${features.distance52wHighPercent.toFixed(1)}% of its 52-week high`,
    });
  }
  if (
    features.relativeStrengthPercentile126 !== null &&
    Math.abs(features.relativeStrengthPercentile126 - 50) >= 35
  ) {
    reasons.push({
      weight: components.relativeStrength,
      text: `6-month relative strength in the ${Math.round(features.relativeStrengthPercentile126)}th percentile`,
    });
  }
  if (features.volatilityRatio20To60 !== null && features.volatilityRatio20To60 > 1.4) {
    reasons.push({
      weight: components.structuralChange * 0.7,
      text: 'Short-term volatility is expanding against its own baseline',
    });
  }

  return reasons
    .sort((a, b) => b.weight - a.weight)
    .slice(0, maximum)
    .map((reason) => reason.text);
}
