// QRM-3 experimental decision functional and entry-quality metric.
// Specified by docs/quant-v3/05-qrm-research-model-and-lab.md sections 11-12.
//
// ## What this is, and what it is not
//
// This is an EXPERIMENTAL research decision layer. It is not authoritative and
// must not be presented as a production conclusion: Signal Engine V2 remains
// the deterministic authority in 3.0 until QRM passes the promotion gates in
// that document. The thresholds below are research starting points versioned in
// config — they do not become production constants because the code compiles.
//
// The decision layer consumes a completed forecast; it never influences path
// generation. A renderer must be able to show a distribution even while this
// returns `wait` or `unavailable`.
//
// ## Why a functional and not a threshold on a score
//
// Signal Engine V2 aggregates trend, volume, reward/risk and location into one
// setup-quality number and cuts it at a level. Every term in that sum is a
// *trailing* measurement, and trailing trend measurements peak exactly at a
// local high — so the sum is highest where the entry is worst. No threshold on
// it fixes that.
//
// This reads a forward distribution and gates on its asymmetry rather than its
// centre. A positive median return is necessary and not sufficient: median MFE
// has to beat median |MAE| by `minimumRewardToRisk`. That single term is what
// makes a peak entry structurally hard to produce, and section 12's
// entry-location metric is how the claim gets falsified rather than asserted.
//
// The shape is informed by the Quantactic iOS policy (`QPMXSignalPolicy`), but
// deliberately re-derived against this document's contract and thresholds
// rather than copied: section "Global Constraints" forbids porting an
// experimental mobile decision policy straight into desktop production.

import type { QrmHorizon, QrmHorizonDistribution } from './qrm';

export type QrmExperimentalDecision =
  | 'long-candidate'
  | 'short-candidate'
  | 'wait'
  | 'unavailable';

export interface QrmDecisionResult {
  decision: QrmExperimentalDecision;
  horizon: QrmHorizon;
  /** Median terminal return, as a fraction. Null when unavailable. */
  edge: number | null;
  /** (p90 - p10) / 2 of terminal return, floored at epsilon. */
  uncertainty: number | null;
  signalToNoise: number | null;
  /** Long: median MFE / |median MAE|. Short: |median MAE| / median MFE. */
  rewardToRisk: number | null;
  probabilityDirectional: number | null;
  /** Adverse-tail magnitude: |p10 of terminal return| when that decile is a
   *  loss, else 0. Positive numbers always mean "more loss". */
  tailLoss: number | null;
  reasons: string[];
}

export interface QrmDecisionThresholds {
  configVersion: string;
  minimumSignalToNoise: number;
  minimumDirectionalProbability: number;
  minimumRewardToRisk: number;
  /** Maximum adverse-tail magnitude, by horizon. A 10-day window is allowed a
   *  deeper tail than a 1-day window because it has more time to produce one. */
  maximumTailLossByHorizon: Record<QrmHorizon, number>;
}

/** Initial research thresholds from section 11. Versioned so a Lab benchmark
 *  can replace them without a code change reading as a silent retune. */
export const QRM_DECISION_RESEARCH_V1: QrmDecisionThresholds = {
  configVersion: 'qrm-decision-research-v1',
  minimumSignalToNoise: 0.25,
  minimumDirectionalProbability: 0.6,
  minimumRewardToRisk: 1.3,
  maximumTailLossByHorizon: { 1: 0.04, 5: 0.08, 10: 0.12 },
};

const UNCERTAINTY_EPSILON = 1e-4;

/** Reason codes, so a refusal can be counted by a benchmark rather than parsed
 *  out of prose. Every code has a sentence in `QRM_DECISION_REASONS`. */
export type QrmDecisionReason =
  | 'distribution-unavailable'
  | 'signal-to-noise-too-low'
  | 'reward-to-risk-too-low'
  | 'directional-probability-too-low'
  | 'adverse-tail-too-deep';

export const QRM_DECISION_REASONS: Record<QrmDecisionReason, string> = {
  'distribution-unavailable': 'No usable forward distribution for this horizon.',
  'signal-to-noise-too-low':
    'The median forward move is small relative to the spread of sampled outcomes.',
  'reward-to-risk-too-low':
    'Sampled paths give up as much on the way as they gain, so the entry is poorly located.',
  'directional-probability-too-low':
    'Fewer than the required share of sampled paths agree on direction.',
  'adverse-tail-too-deep': 'The adverse tail of sampled outcomes is deeper than the horizon allows.',
};

function magnitude(value: number): number {
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

function isUsable(distribution: QrmHorizonDistribution | null | undefined): boolean {
  if (!distribution) return false;
  const { terminalReturn, mfe, mae, probabilityPositive } = distribution;
  return (
    [terminalReturn.p10, terminalReturn.p50, terminalReturn.p90, mfe.p50, mae.p50].every((value) =>
      Number.isFinite(value),
    ) &&
    Number.isFinite(probabilityPositive) &&
    probabilityPositive >= 0 &&
    probabilityPositive <= 1
  );
}

function unavailable(horizon: QrmHorizon): QrmDecisionResult {
  return {
    decision: 'unavailable',
    horizon,
    edge: null,
    uncertainty: null,
    signalToNoise: null,
    rewardToRisk: null,
    probabilityDirectional: null,
    tailLoss: null,
    reasons: [QRM_DECISION_REASONS['distribution-unavailable']],
  };
}

/**
 * Evaluates one horizon's distribution.
 *
 * `unavailable` and `wait` are different answers on purpose: the first says the
 * model could not speak, the second says it spoke and declined.
 */
export function decideQrm(
  distribution: QrmHorizonDistribution | null | undefined,
  thresholds: QrmDecisionThresholds = QRM_DECISION_RESEARCH_V1,
): QrmDecisionResult {
  if (!isUsable(distribution)) {
    return unavailable(distribution?.horizon ?? 1);
  }
  const dist = distribution as QrmHorizonDistribution;

  const edge = dist.terminalReturn.p50;
  const uncertainty = Math.max(
    UNCERTAINTY_EPSILON,
    (dist.terminalReturn.p90 - dist.terminalReturn.p10) / 2,
  );
  const signalToNoise = Math.abs(edge) / uncertainty;

  const favorable = magnitude(dist.mfe.p50);
  const adverse = magnitude(dist.mae.p50);

  // Symmetric by construction: one expression per side, so the two directions
  // cannot drift apart as the thresholds are retuned.
  const wantsLong = edge > 0;
  const rewardToRisk = wantsLong
    ? adverse > 0
      ? favorable / adverse
      : Infinity
    : favorable > 0
      ? adverse / favorable
      : Infinity;
  const probabilityDirectional = wantsLong
    ? dist.probabilityPositive
    : 1 - dist.probabilityPositive;
  const tailLoss = dist.terminalReturn.p10 < 0 ? Math.abs(dist.terminalReturn.p10) : 0;

  const codes: QrmDecisionReason[] = [];
  if (signalToNoise < thresholds.minimumSignalToNoise) codes.push('signal-to-noise-too-low');
  if (rewardToRisk < thresholds.minimumRewardToRisk) codes.push('reward-to-risk-too-low');
  if (probabilityDirectional < thresholds.minimumDirectionalProbability) {
    codes.push('directional-probability-too-low');
  }
  // The adverse tail disqualifies a long only. A short is not harmed by the
  // move it is positioned for, and gating it on the same term would refuse
  // every useful short.
  if (wantsLong && tailLoss > thresholds.maximumTailLossByHorizon[dist.horizon]) {
    codes.push('adverse-tail-too-deep');
  }

  return {
    decision: codes.length ? 'wait' : wantsLong ? 'long-candidate' : 'short-candidate',
    horizon: dist.horizon,
    edge,
    uncertainty,
    signalToNoise,
    rewardToRisk,
    probabilityDirectional,
    tailLoss,
    reasons: codes.map((code) => QRM_DECISION_REASONS[code]),
  };
}

/** Machine-readable form of the same refusals, for the benchmark ledger. */
export function qrmDecisionReasonCodes(result: QrmDecisionResult): QrmDecisionReason[] {
  const byText = new Map<string, QrmDecisionReason>(
    (Object.keys(QRM_DECISION_REASONS) as QrmDecisionReason[]).map((code) => [
      QRM_DECISION_REASONS[code],
      code,
    ]),
  );
  return result.reasons
    .map((reason) => byText.get(reason))
    .filter((code): code is QrmDecisionReason => code !== undefined);
}

// ---------------------------------------------------------------------------
// Section 12 — entry-quality metric
//
// Forecast metrics can improve while entries get worse, so entry location is
// measured explicitly rather than inferred from the decision.
// ---------------------------------------------------------------------------

export interface EntryQuality {
  /** 0 is the best possible long location, 1 the worst. */
  entryLocation: number;
  /** Direction-adjusted: for a short this is `1 - entryLocation`, so for both
   *  directions a lower number is a better entry. */
  entryPenalty: number;
  /** True when the forward window never moved, so the metric is undefined and
   *  the observation is counted separately rather than scored. */
  degenerate: boolean;
}

/**
 * Where an entry sat inside the range the market actually went on to trade.
 *
 * This is a *backward-looking research measurement* over a realised forward
 * window, which is why it lives with the benchmark rather than with the live
 * decision: computing it at decision time would require the future.
 */
export function measureEntryQuality(args: {
  entry: number;
  forwardMin: number;
  forwardMax: number;
  direction: 'long' | 'short';
}): EntryQuality {
  const { entry, forwardMin, forwardMax, direction } = args;
  const span = forwardMax - forwardMin;
  if (!Number.isFinite(span) || span <= 0 || !Number.isFinite(entry)) {
    return { entryLocation: 0, entryPenalty: 0, degenerate: true };
  }
  const raw = (entry - forwardMin) / span;
  const entryLocation = Math.min(1, Math.max(0, raw));
  return {
    entryLocation,
    entryPenalty: direction === 'short' ? 1 - entryLocation : entryLocation,
    degenerate: false,
  };
}

/** Mean entry penalty over non-degenerate observations, with the excluded count
 *  reported rather than folded into the average. */
export function summarizeEntryQuality(samples: EntryQuality[]): {
  meanEntryPenalty: number | null;
  meanEntryLocation: number | null;
  scored: number;
  degenerate: number;
} {
  const scored = samples.filter((sample) => !sample.degenerate);
  const degenerate = samples.length - scored.length;
  if (!scored.length) {
    return { meanEntryPenalty: null, meanEntryLocation: null, scored: 0, degenerate };
  }
  const mean = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
  return {
    meanEntryPenalty: mean(scored.map((s) => s.entryPenalty)),
    meanEntryLocation: mean(scored.map((s) => s.entryLocation)),
    scored: scored.length,
    degenerate,
  };
}
