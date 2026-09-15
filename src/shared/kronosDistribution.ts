// Derives a QRM-shaped forward distribution from the existing Kronos ensemble,
// and renders both models through the neutral `ResearchModelView`.
//
// Why an adapter rather than a second policy: docs/quant-v3/05 section 18 is
// explicit that QRM and Kronos are different models with different assumptions
// and must not be merged by averaging. So Kronos keeps its own identity and its
// own view; what this module shares is the *distribution shape*, so one
// decision functional can be pointed at either model and the two can be
// compared rather than blended.
//
// QRM's own pipeline (analogue weighting, stationary block resampling) does not
// exist yet. Until it does, this is what gives `qrmDecision.ts` a real
// distribution to read — labelled as Kronos throughout, never as QRM.

import type { ForecastRecord } from './forecast';
import type {
  QrmHorizon,
  QrmHorizonDistribution,
  QrmQuantiles,
  ResearchModelView,
} from './qrm';
import { quantilesOf } from './qrm';
import type { QrmDecisionResult } from './qrmDecision';

export const KRONOS_MODEL_ID = 'kronos';

export interface KronosDistributionResult {
  distribution: QrmHorizonDistribution;
  /** Usable paths. The Kronos ensemble is unweighted — every path carries equal
   *  weight — so this is a plain count, not a Kish effective sample size. */
  usablePaths: number;
  /** Paths dropped for non-finite or non-positive closes. */
  rejectedPaths: number;
  /**
   * Horizon reported by the record, in bars, alongside the `QrmHorizon` bucket
   * the distribution was filed under. Kronos runs a 24-hour intraday horizon,
   * which is not one of QRM's 1/5/10 *day* horizons, so the mapping is
   * approximate and is stated rather than hidden.
   */
  horizonBars: number;
}

/**
 * Kronos' 24 hourly bars are roughly one trading session ahead, so the
 * distribution is filed under the 1-day horizon. This is an approximation of
 * convenience for comparison, not a claim that the two horizons are the same
 * object.
 */
function horizonBucketFor(horizonBars: number): QrmHorizon {
  if (horizonBars <= 32) return 1;
  if (horizonBars <= 96) return 5;
  return 10;
}

function emptyQuantiles(): QrmQuantiles {
  return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };
}

/**
 * Builds the distribution from the persisted close paths.
 *
 * Returns null rather than a neutral-looking distribution when the record has
 * no usable paths: a fabricated zero-edge distribution would read as a measured
 * "no opinion" and would pass straight into the decision functional.
 */
export function buildKronosDistribution(
  record: ForecastRecord,
): KronosDistributionResult | null {
  const base = record.lastHistoricalClose;
  if (!Number.isFinite(base) || base <= 0) return null;

  const usable: number[][] = [];
  let rejectedPaths = 0;
  for (const path of record.closePaths ?? []) {
    if (
      Array.isArray(path) &&
      path.length > 0 &&
      path.every((value) => Number.isFinite(value) && value > 0)
    ) {
      usable.push(path);
    } else {
      rejectedPaths += 1;
    }
  }
  if (!usable.length) return null;

  const terminalReturns: number[] = [];
  const favorable: number[] = [];
  const adverse: number[] = [];
  let lossBeforeGain = 0;

  for (const path of usable) {
    let high = -Infinity;
    let low = Infinity;
    // Ordered scan: the "-5% before +5%" question is about which came first, so
    // it cannot be answered from the path's extremes alone.
    let firstTrigger: 'loss' | 'gain' | null = null;
    for (const close of path) {
      if (close > high) high = close;
      if (close < low) low = close;
      if (firstTrigger === null) {
        const change = close / base - 1;
        if (change <= -0.05) firstTrigger = 'loss';
        else if (change >= 0.05) firstTrigger = 'gain';
      }
    }
    terminalReturns.push(path[path.length - 1] / base - 1);
    favorable.push(Math.max(0, high / base - 1));
    adverse.push(Math.max(0, 1 - low / base));
    if (firstTrigger === 'loss') lossBeforeGain += 1;
  }

  const horizonBars = Math.max(...usable.map((path) => path.length));
  const positive = terminalReturns.filter((value) => value > 0).length;

  return {
    distribution: {
      horizon: horizonBucketFor(horizonBars),
      terminalReturn: terminalReturns.length ? quantilesOf(terminalReturns) : emptyQuantiles(),
      probabilityPositive: positive / usable.length,
      mfe: quantilesOf(favorable),
      mae: quantilesOf(adverse),
      probabilityLoss5PercentBeforeGain5Percent: lossBeforeGain / usable.length,
    },
    usablePaths: usable.length,
    rejectedPaths,
    horizonBars,
  };
}

function percent(value: number | null, digits = 1): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function ratio(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/**
 * Kronos' own view. Its native semantics are "sampled median positive /
 * negative", not a decision — so `decisionLabel` says that rather than
 * borrowing BUY/WAIT/SELL from an engine Kronos is not part of.
 */
export function kronosResearchView(
  record: ForecastRecord,
  built: KronosDistributionResult | null = buildKronosDistribution(record),
): ResearchModelView {
  if (!built) {
    return {
      modelId: KRONOS_MODEL_ID,
      modelVersion: record.provenance.modelId,
      status: 'unavailable',
      directionalView: 'none',
      decisionLabel: 'No usable sampled paths',
      horizonLabel: record.horizonLabel,
      reliabilityLabel: 'Unavailable',
      diagnostics: [],
    };
  }

  const median = built.distribution.terminalReturn.p50;
  const directionalView =
    median > 0 ? 'bullish' : median < 0 ? 'bearish' : 'neutral';
  const coverage = record.evaluation.p10P90Coverage;

  return {
    modelId: KRONOS_MODEL_ID,
    modelVersion: record.provenance.modelId,
    status: 'ready',
    directionalView,
    decisionLabel:
      median > 0
        ? 'Sampled median positive'
        : median < 0
          ? 'Sampled median negative'
          : 'Sampled median flat',
    horizonLabel: record.horizonLabel,
    // Never called an "80% confidence interval" unless measured holdout
    // coverage supports that reading (section 10).
    reliabilityLabel:
      coverage === undefined
        ? 'P10–P90 sampled range; holdout coverage not yet measured'
        : `P10–P90 sampled range; observed holdout coverage ${(coverage * 100).toFixed(0)}%`,
    diagnostics: [
      { label: 'Median sampled outcome', value: percent(median, 2) },
      {
        label: 'P10–P90 sampled range',
        value: `${percent(built.distribution.terminalReturn.p10, 2)} … ${percent(
          built.distribution.terminalReturn.p90,
          2,
        )}`,
      },
      { label: 'Share of paths positive', value: percent(built.distribution.probabilityPositive, 0) },
      { label: 'Sampled paths', value: `${built.usablePaths}` },
      { label: 'Horizon bars', value: `${built.horizonBars}` },
      { label: 'Run mode', value: record.provenance.mode },
    ],
  };
}

/** The experimental QRM decision layer's own view, so a workspace can show it
 *  beside Signal Engine V2 and Kronos without flattening the three onto one
 *  numeric scale. */
export function qrmResearchView(
  modelVersion: string,
  result: QrmDecisionResult,
): ResearchModelView {
  const directionalView =
    result.decision === 'long-candidate'
      ? 'bullish'
      : result.decision === 'short-candidate'
        ? 'bearish'
        : result.decision === 'wait'
          ? 'neutral'
          : 'none';
  return {
    modelId: 'qrm-3',
    modelVersion,
    status: result.decision === 'unavailable' ? 'unavailable' : 'ready',
    directionalView,
    decisionLabel:
      result.decision === 'long-candidate'
        ? 'Experimental long candidate'
        : result.decision === 'short-candidate'
          ? 'Experimental short candidate'
          : result.decision === 'wait'
            ? 'Experimental: wait'
            : 'Experimental: unavailable',
    horizonLabel: `${result.horizon}-day sampled horizon`,
    reliabilityLabel: 'Experimental — not an authoritative Quant decision',
    diagnostics: [
      { label: 'Median forward move', value: percent(result.edge, 2) },
      { label: 'Signal to noise', value: ratio(result.signalToNoise) },
      { label: 'Reward to risk', value: ratio(result.rewardToRisk) },
      { label: 'Directional agreement', value: percent(result.probabilityDirectional, 0) },
      { label: 'Adverse tail', value: percent(result.tailLoss, 2) },
      ...result.reasons.map((reason, index) => ({
        label: `Refusal ${index + 1}`,
        value: reason,
      })),
    ],
  };
}

/** Research context when models disagree. Per section 18 this is surfaced, not
 *  averaged away. */
export function describeModelDisagreement(views: ResearchModelView[]): string | null {
  const directional = views
    .filter((view) => view.status === 'ready' && view.directionalView !== 'none')
    .map((view) => view.directionalView);
  if (directional.length < 2) return null;
  const distinct = new Set(directional);
  if (distinct.size < 2) return null;
  return 'Models disagree — investigate assumptions';
}
