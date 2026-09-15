// The single place a BUY / WAIT / SELL conclusion is decided. Ported from the
// Quantactic iOS model (`UnifiedSignalResolver.swift`).
//
// Surfaces must never map raw fields to user words themselves — that is how an
// app ends up showing "no-trade" beside "quality 88/100" beside "breakout".
// Every surface reads the summary this module produces.
//
// The decision is made by gates, not by a score threshold: a high setup quality
// with a missing trigger, an unusable risk plan or contradicting evidence is a
// WAIT, however confident the number looks.

import type { Candle } from './types';
import type { RiskSettings } from './quant';
import { DEFAULT_RISK_SETTINGS } from './quant';
import type { SignalCoreEvaluation } from './signalV2';
import { detectSignalFactors, type SignalFactorSet } from './signalFactors';
import {
  aggregateSignalEvidence,
  setupDirectionFor,
  type RelativeMarketContext,
  type SetupDirection,
} from './signalEvidenceAggregator';
import { prioritizeSignalReasons } from './signalReasonPrioritizer';
import {
  CATEGORY_WATCH_LINES,
  RISK_PLAN_BLOCKER_REASONS,
  SIGNAL_SUMMARY_SENTENCES,
  UNIFIED_SIGNAL_MODEL_VERSION,
  isDegraded,
  isMeasured,
  type EventRiskSummary,
  type RiskPlanBlocker,
  type SignalDataQuality,
  type SignalEvidence,
  type SignalEvidenceCategory,
  type SignalSummaryKey,
  type UnifiedRiskPlan,
  type UnifiedSignal,
  type UnifiedSignalSummary,
} from './unifiedSignal';
import {
  DAILY_ACCEPTANCE_CONFIG,
  confirmsUpsideBreakout,
  isDestructiveAcceptance,
  isMeasuredAcceptance,
  measurePriceAcceptance,
  type PriceAcceptanceConfig,
  type PriceAcceptanceEvidence,
} from './volumeProfile';

/**
 * A strong number can rank clarity inside a conclusion, but it can never
 * promote WAIT into BUY. These caps stop the number from contradicting the word
 * next to it.
 */
const WAIT_STRENGTH_CEILING = 74;
const DECIDED_STRENGTH_FLOOR = 55;
const DECIDED_STRENGTH_CEILING = 96;

/** Minimum bars before the engine will claim anything at all. */
const MINIMUM_HISTORY_BARS = 50;

/** The priority order used for both reason selection and watch lines. */
const WATCH_PRIORITY: SignalEvidenceCategory[] = [
  'price-acceptance',
  'trend',
  'momentum',
  'relative-strength',
  'volume',
  'market-context',
];

export interface ResolveUnifiedSignalInput {
  symbol: string;
  /** Daily candles, ascending. The same series the Signal Desk evaluated. */
  candles: Candle[];
  /** Quant's deterministic core evaluation — the setup, direction and geometry. */
  evaluation: SignalCoreEvaluation;
  /** Bars used to measure price acceptance. Defaults to `candles`; pass an
   *  intraday series (with `acceptanceConfig`) when one is available. */
  acceptanceCandles?: Candle[];
  acceptanceConfig?: PriceAcceptanceConfig;
  relative?: RelativeMarketContext | null;
  /** Cross-asset market pulse regime score, 0-100. */
  marketPulseScore?: number | null;
  eventRisk?: EventRiskSummary | null;
  /** Categories that changed since the last reading, for "what changed" copy. */
  changedCategories?: ReadonlySet<SignalEvidenceCategory>;
  riskSettings?: RiskSettings;
  /** Live quote, when a same-session move should be visible before the bar closes. */
  livePrice?: number | null;
  nowSeconds?: number;
}

interface Outcome {
  signal: UnifiedSignal;
  summaryKey: SignalSummaryKey;
  /** Whether the setup's own trigger is satisfied. */
  confirmed: boolean;
}

/** Translates Quant's blockers into the risk-plan gate.
 *
 * Quant's `noTradeReasons` are free text, so the mapping is driven by the
 * structured fields it also exposes; the text is only used to recognise the two
 * blockers that have no field of their own. */
function riskPlanFrom(
  evaluation: SignalCoreEvaluation,
  settings: RiskSettings,
): UnifiedRiskPlan | null {
  const { risk, direction } = evaluation;
  if (direction === 'none') return null;

  let blocker: RiskPlanBlocker | null = null;
  if (!Number.isFinite(risk.riskPerUnit) || risk.riskPerUnit <= 0) {
    blocker = 'insufficient-data';
  } else if (!Number.isFinite(risk.target1) || risk.target1 === risk.entry) {
    blocker = 'target-unavailable';
  } else if (risk.rewardRisk1 < settings.minimumRewardRisk) {
    blocker = 'reward-risk-below-minimum';
  } else if (risk.positionSize <= 0) {
    blocker = 'position-size-zero';
  } else if (
    evaluation.noTradeReasons.some((reason) => reason.toLowerCase().includes('negative expectancy'))
  ) {
    blocker = 'negative-historical-expectancy';
  }

  const structuralReadiness = blocker === null ? 'ready' : 'needs-work';
  return {
    structuralReadiness,
    readiness: structuralReadiness,
    blocker,
    blockerDetail: blocker === null ? null : RISK_PLAN_BLOCKER_REASONS[blocker],
    direction,
    entry: risk.entry,
    stop: risk.stop,
    target: risk.target1,
    rewardRisk: risk.rewardRisk1,
    riskPerUnit: risk.riskPerUnit,
    positionSize: risk.positionSize,
  };
}

function blockedByEvent(plan: UnifiedRiskPlan): UnifiedRiskPlan {
  return {
    ...plan,
    readiness: 'needs-work',
    blocker: 'event-risk',
    blockerDetail: RISK_PLAN_BLOCKER_REASONS['event-risk'],
  };
}

/**
 * The engine's own trigger, plus acceptance where the setup depends on it.
 *
 * Price printing through a level is not a breakout; a breakout is a level that
 * price then holds. So a setup resting on new highs needs accepted price
 * behaviour, and if acceptance could not be measured at all, the setup waits
 * rather than assuming the best.
 */
function upsideConfirmed(
  factors: SignalFactorSet | null,
  evaluation: SignalCoreEvaluation,
  acceptance: PriceAcceptanceEvidence | null,
): boolean {
  const triggered =
    (factors?.breakoutConfirmed ?? false) ||
    (factors?.reclaimedMovingAverage20 ?? false) ||
    evaluation.setupType === 'breakout' ||
    evaluation.setupType === 'pullback-continuation' ||
    evaluation.setupType === 'higher-low-continuation';
  if (!triggered) return false;

  const restsOnBreakout =
    evaluation.setupType === 'breakout' ||
    (factors?.atOrNearYearHigh ?? false) ||
    (factors?.factors.some((factor) => factor.kind === 'yearly-high') ?? false);

  if (!acceptance || !isMeasuredAcceptance(acceptance)) {
    return !restsOnBreakout;
  }
  if (isDestructiveAcceptance(acceptance.state)) return false;
  return restsOnBreakout ? confirmsUpsideBreakout(acceptance) : true;
}

/**
 * The downside gate.
 *
 * Quant's core engine detects short setups (`failed-breakout`,
 * `lower-high-rejection`) but has no acceptance-based breakdown trigger of its
 * own, and inventing a symmetric one out of "trend and momentum agree" would
 * let a slow drift read as a confirmed breakdown.
 *
 * So this requires the one real bearish confirmation the toolkit actually has:
 * measured Price Acceptance showing price *held* below the area it was trading
 * in, with the symbol's own trend or momentum behind it. When acceptance cannot
 * be measured the answer is WAIT rather than a guess — which is why a scan with
 * no volume history never reaches SELL.
 *
 * A genuinely symmetric bearish engine is a larger piece of work: mirrored
 * detection rules, a direction-neutral trigger state machine and short-side
 * risk geometry. Until that exists, this gate stays narrow on purpose.
 */
function downsideConfirmed(
  evidence: SignalEvidence[],
  acceptance: PriceAcceptanceEvidence | null,
): boolean {
  if (!acceptance || !isMeasuredAcceptance(acceptance) || !isDestructiveAcceptance(acceptance.state)) {
    return false;
  }
  return evidence.some(
    (item) =>
      (item.category === 'trend' || item.category === 'momentum') &&
      isMeasured(item) &&
      item.state === 'supports',
  );
}

function decide(args: {
  direction: SetupDirection;
  factors: SignalFactorSet | null;
  evaluation: SignalCoreEvaluation;
  evidence: SignalEvidence[];
  acceptance: PriceAcceptanceEvidence | null;
  riskPlan: UnifiedRiskPlan | null;
  eventRisk: EventRiskSummary | null;
  dataQuality: SignalDataQuality;
  stronglyContradicted: boolean;
}): Outcome {
  const { direction, evaluation, evidence, acceptance, riskPlan, eventRisk, dataQuality } = args;

  if (dataQuality === 'insufficient-history') {
    return { signal: 'wait', summaryKey: 'wait-data', confirmed: false };
  }

  // Gate 1: a confirmed high-impact corporate event inside the blocking window.
  if (eventRisk?.blocksEntry) {
    return { signal: 'wait', summaryKey: 'wait-event-risk', confirmed: false };
  }

  const riskPlanUsable = riskPlan?.readiness === 'ready';

  if (direction === 'positive') {
    const confirmed = upsideConfirmed(args.factors, evaluation, acceptance);
    if (!riskPlanUsable) {
      // A directionally strong setup with no usable geometry is still a wait —
      // this is the gate a score cannot override.
      return { signal: 'wait', summaryKey: 'wait-risk', confirmed };
    }
    if (confirmed && !args.stronglyContradicted) {
      return { signal: 'buy', summaryKey: 'buy', confirmed: true };
    }
    return {
      signal: 'wait',
      summaryKey: args.stronglyContradicted ? 'wait-mixed' : 'wait-unconfirmed',
      confirmed,
    };
  }

  if (direction === 'negative') {
    const confirmed = downsideConfirmed(evidence, acceptance);
    if (riskPlan?.direction !== 'short' || !riskPlanUsable) {
      return { signal: 'wait', summaryKey: 'wait-risk', confirmed };
    }
    if (confirmed && !args.stronglyContradicted) {
      return { signal: 'sell', summaryKey: 'sell', confirmed: true };
    }
    return {
      signal: 'wait',
      summaryKey: args.stronglyContradicted ? 'wait-mixed' : 'wait-unconfirmed',
      confirmed,
    };
  }

  return { signal: 'wait', summaryKey: 'wait-mixed', confirmed: false };
}

/** Agreement, confirmation and data quality, less a conflict penalty.
 *  Deliberately not a count of positive indicators, and never a percentage. */
function computeStrength(args: {
  signal: UnifiedSignal;
  supports: number;
  contradictions: number;
  confirmed: boolean;
  riskPlanReady: boolean;
  dataQuality: SignalDataQuality;
}): number {
  let score = 40;
  score += args.supports * 7;
  score -= args.contradictions * 8;
  if (args.confirmed) score += 12;
  if (args.riskPlanReady) score += 8;
  if (isDegraded(args.dataQuality)) score -= 10;

  if (args.signal === 'wait') return Math.min(WAIT_STRENGTH_CEILING, Math.max(5, score));
  return Math.min(DECIDED_STRENGTH_CEILING, Math.max(DECIDED_STRENGTH_FLOOR, score));
}

function watchLines(signal: UnifiedSignal, evidence: SignalEvidence[]): string[] {
  // For a decided conclusion the interesting risk is the support that could be
  // withdrawn. For a wait it is what still has to happen.
  const candidates =
    signal === 'wait'
      ? evidence.filter((item) => item.state !== 'supports')
      : evidence.filter((item) => isMeasured(item) && item.state === 'supports');

  const index = (category: SignalEvidenceCategory) => {
    const at = WATCH_PRIORITY.indexOf(category);
    return at < 0 ? WATCH_PRIORITY.length : at;
  };

  return [...candidates]
    .sort((a, b) => index(a.category) - index(b.category))
    .slice(0, 2)
    .map((item) => {
      if (item.category === 'risk-plan') return '';
      const lines = CATEGORY_WATCH_LINES[item.category];
      return signal === 'wait' ? lines.pending : lines.decided;
    })
    .filter((line) => line.length > 0);
}

/** Resolves one symbol to the single conclusion every surface reads. */
export function resolveUnifiedSignal(input: ResolveUnifiedSignalInput): UnifiedSignalSummary {
  const settings = input.riskSettings ?? DEFAULT_RISK_SETTINGS;
  const symbol = input.symbol.trim().toUpperCase();
  const evaluation = input.evaluation;
  const direction = setupDirectionFor(evaluation.direction);

  const factors =
    input.candles.length >= MINIMUM_HISTORY_BARS
      ? detectSignalFactors(input.candles, input.livePrice ?? null)
      : null;
  const readings = factors?.readings ?? {
    rsi14: null,
    macdHistogram: null,
    movingAverage20: null,
    movingAverage50: null,
    movingAverage120: null,
    relativeVolume: null,
    atr14: null,
    distanceToYearHighPercent: null,
  };

  const acceptanceCandles = input.acceptanceCandles ?? input.candles;
  const currentPrice =
    factors?.mark ?? input.livePrice ?? input.candles[input.candles.length - 1]?.close ?? 0;
  const acceptance =
    factors === null
      ? null
      : measurePriceAcceptance({
          candles: acceptanceCandles,
          currentPrice,
          atr: readings.atr14,
          relativeVolume: readings.relativeVolume,
          config: input.acceptanceConfig ?? DAILY_ACCEPTANCE_CONFIG,
          nowSeconds: input.nowSeconds,
        });

  const dataQuality: SignalDataQuality =
    factors === null
      ? 'insufficient-history'
      : !isMeasuredAcceptance(acceptance)
        ? 'price-acceptance-unavailable'
        : 'sufficient';

  const evidence = aggregateSignalEvidence(direction, {
    factors: factors?.factors ?? [],
    readings,
    acceptance,
    relative: input.relative ?? null,
    marketPulseScore: input.marketPulseScore ?? null,
  });

  let riskPlan = riskPlanFrom(evaluation, settings);
  const eventRisk = input.eventRisk ?? null;
  if (eventRisk?.blocksEntry && riskPlan) riskPlan = blockedByEvent(riskPlan);

  const contradictions = evidence.filter((item) => isMeasured(item) && item.state === 'weakens');
  const supports = evidence.filter((item) => isMeasured(item) && item.state === 'supports');
  const acceptanceRow = evidence.find((item) => item.category === 'price-acceptance');

  // A conclusion is contradicted when two categories argue against it, or when
  // price itself is being rejected where it matters.
  const stronglyContradicted =
    contradictions.length >= 2 ||
    (acceptanceRow !== undefined &&
      isMeasured(acceptanceRow) &&
      acceptanceRow.state === 'weakens');

  const outcome = decide({
    direction,
    factors,
    evaluation,
    evidence,
    acceptance,
    riskPlan,
    eventRisk,
    dataQuality,
    stronglyContradicted,
  });

  // SELL safety: SELL must never be shown against long-side geometry.
  if (outcome.signal === 'sell' && riskPlan?.direction !== 'short') riskPlan = null;

  return {
    symbol,
    signal: outcome.signal,
    strength: computeStrength({
      signal: outcome.signal,
      supports: supports.length,
      contradictions: contradictions.length,
      confirmed: outcome.confirmed,
      riskPlanReady: riskPlan?.readiness === 'ready',
      dataQuality,
    }),
    summary: SIGNAL_SUMMARY_SENTENCES[outcome.summaryKey],
    keyReasons: prioritizeSignalReasons(outcome.signal, evidence, input.changedCategories),
    evidence,
    riskPlan,
    eventRisk,
    dataQuality,
    whatCouldChange: watchLines(outcome.signal, evidence),
    acceptance,
    modelVersion: UNIFIED_SIGNAL_MODEL_VERSION,
  };
}
