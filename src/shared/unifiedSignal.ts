// The single user-facing conclusion vocabulary, ported from the Quantactic iOS
// model (`UnifiedSignal.swift`).
//
// Quant already speaks five decisions (`buy-candidate`, `short-candidate`,
// `wait`, `no-trade`, `invalidated`), a 0-100 setup quality, a setup type and a
// regime — four scales that a surface has to reconcile on its own, which is how
// a UI ends up showing "no-trade" beside "quality 88/100". This model resolves
// all of it to exactly one of three words plus an evidence list that explains
// it, and nothing else is allowed to reach a user-facing surface.
//
// The decision itself lives in `unifiedSignalResolver.ts`. This file is the
// vocabulary and the copy.

import type { PriceAcceptanceEvidence } from './volumeProfile';
import type { TradeDirection } from './quant';

/** The only conclusion Quant shows for a symbol. Two labels that appear to
 *  disagree are worse than one label that is honest about being unresolved,
 *  which is what `wait` is for. */
export type UnifiedSignal = 'buy' | 'wait' | 'sell';

/** The only directional vocabulary a single piece of evidence may use.
 *  Deliberately three words, and deliberately not a second opinion: a category
 *  never says "buy", it says whether it supports the conclusion being shown. */
export type EvidenceState = 'supports' | 'mixed' | 'weakens';

/**
 * Which way a category leans for price, before it is restated relative to a
 * conclusion.
 *
 * Both readings are needed. `EvidenceState` answers "does this support the
 * conclusion shown", which is why a downtrend supports a SELL. `EvidenceLean`
 * answers "what is price doing", which is what the sentence has to say — a SELL
 * row must read "price is holding below a key area", not above it.
 */
export type EvidenceLean = 'bullish' | 'mixed' | 'bearish';

/** Whether a category could be measured at all. Kept separate from
 *  `EvidenceState` so "we could not calculate this" never masquerades as a
 *  directional reading, and so no fourth badge word enters the vocabulary. */
export type EvidenceAvailability = 'measured' | 'unavailable';

/** The stable category set, in display order. Raw factors consolidate into
 *  these; the list does not grow because an indicator was added. `risk-plan` is
 *  a gate rather than a direction. */
export type SignalEvidenceCategory =
  | 'trend'
  | 'momentum'
  | 'volume'
  | 'price-acceptance'
  | 'relative-strength'
  | 'market-context'
  | 'risk-plan';

export const SIGNAL_EVIDENCE_CATEGORIES: SignalEvidenceCategory[] = [
  'trend',
  'momentum',
  'volume',
  'price-acceptance',
  'relative-strength',
  'market-context',
  'risk-plan',
];

/** Every category except the risk-plan gate carries a direction. */
export const DIRECTIONAL_EVIDENCE_CATEGORIES: SignalEvidenceCategory[] =
  SIGNAL_EVIDENCE_CATEGORIES.filter((category) => category !== 'risk-plan');

/** The risk-plan gate. Not a direction, and never rendered with the directional
 *  vocabulary. */
export type RiskPlanReadiness = 'ready' | 'needs-work';

/** The user-facing reason otherwise valid geometry cannot currently be used. */
export type RiskPlanBlocker =
  | 'event-risk'
  | 'target-unavailable'
  | 'reward-risk-below-minimum'
  | 'stop-too-wide'
  | 'insufficient-data'
  | 'unsupported-direction'
  | 'position-size-zero'
  | 'negative-historical-expectancy';

/** A technical row shown only behind explicit advanced disclosure. RSI, MACD,
 *  POC, VAH, VAL and ATR live here and nowhere else in the normal UI. */
export interface SignalAdvancedFact {
  label: string;
  value: string;
}

/** One consolidated category reading. */
export interface SignalEvidence {
  category: SignalEvidenceCategory;
  /** Stated relative to the conclusion being shown: on a SELL setup, a
   *  downtrend *supports* the setup rather than weakening it. */
  state: EvidenceState;
  /** What price is actually doing, independent of the conclusion. */
  lean: EvidenceLean;
  availability: EvidenceAvailability;
  /** One plain sentence. */
  detail: string;
  advanced: SignalAdvancedFact[];
}

export function isMeasured(evidence: SignalEvidence): boolean {
  return evidence.availability === 'measured';
}

/** A short phrase for the collapsed list. At most two ever reach a card. */
export interface SignalReason {
  category: SignalEvidenceCategory;
  direction: 'positive' | 'negative' | 'neutral';
  text: string;
}

/** Entry, stop, target and geometry, in the four terms Quant commits to. */
export interface UnifiedRiskPlan {
  /** Readiness of the geometry itself, before external gates. */
  structuralReadiness: RiskPlanReadiness;
  /** Readiness after event risk and other blockers are applied. What the UI shows. */
  readiness: RiskPlanReadiness;
  blocker: RiskPlanBlocker | null;
  blockerDetail: string | null;
  direction: TradeDirection;
  entry: number;
  stop: number;
  target: number;
  rewardRisk: number;
  riskPerUnit: number;
  positionSize: number;
}

/** Summary of an upcoming corporate event that creates gap risk. */
export interface EventRiskSummary {
  title: string;
  detail: string;
  eventId: string;
  /** True only inside the blocking window; a distant event is context, not a gate. */
  blocksEntry: boolean;
}

/** Why a conclusion may be less trustworthy than its evidence count suggests. */
export type SignalDataQuality =
  | 'sufficient'
  /** Bar data was too thin to measure where price is being accepted. */
  | 'price-acceptance-unavailable'
  /** Not enough history to run the engine at all. */
  | 'insufficient-history';

export function isDegraded(quality: SignalDataQuality): boolean {
  return quality !== 'sufficient';
}

/** Everything a user-facing surface is allowed to say about one symbol. */
export interface UnifiedSignalSummary {
  symbol: string;
  signal: UnifiedSignal;
  /**
   * 0-100 clarity of the evidence — agreement, confirmation and data quality,
   * less a conflict penalty. This is *not* a probability and is never rendered
   * with a percent sign; use `strengthLabel`.
   */
  strength: number;
  /** One sentence stating the conclusion. */
  summary: string;
  /** At most two, for the collapsed list. */
  keyReasons: SignalReason[];
  /** The directional categories, in canonical order. */
  evidence: SignalEvidence[];
  riskPlan: UnifiedRiskPlan | null;
  eventRisk: EventRiskSummary | null;
  dataQuality: SignalDataQuality;
  /** What would invalidate the current reading. */
  whatCouldChange: string[];
  acceptance: PriceAcceptanceEvidence | null;
  /** The model that produced this conclusion. */
  modelVersion: string;
}

export const UNIFIED_SIGNAL_MODEL_VERSION = 'QuantUnifiedSignal_v1';

/** "Signal strength 84/100" — centralised so no surface can quietly turn it
 *  back into a percentage. */
export function strengthLabel(strength: number): string {
  return `Signal strength ${strength}/100`;
}

export function evidenceFor(
  summary: UnifiedSignalSummary,
  category: SignalEvidenceCategory,
): SignalEvidence | null {
  return summary.evidence.find((item) => item.category === category) ?? null;
}

// ---------------------------------------------------------------------------
// Copy
//
// Quant has no localization layer, so the phrasing lives here as one table
// rather than being inlined at each call site. The keys mirror the iOS
// localization keys so the two apps can be diffed for wording drift.
// ---------------------------------------------------------------------------

export const SIGNAL_TITLES: Record<UnifiedSignal, string> = {
  buy: 'BUY',
  wait: 'WAIT',
  sell: 'SELL',
};

export const SIGNAL_SHORT_MEANINGS: Record<UnifiedSignal, string> = {
  buy: 'The evidence is positive and the setup has enough confirmation to be considered active.',
  wait: 'There may be a setup, but the evidence is incomplete, mixed, or not confirmed yet.',
  sell: 'The evidence is negative and downside or exit conditions have enough confirmation to be considered active.',
};

export const SIGNAL_EDUCATION: Record<UnifiedSignal, string> = {
  buy: 'Quant sees supportive price structure and enough confirmation for this setup. BUY does not mean the price is guaranteed to rise — it means the rule-based evidence currently meets Quant’s positive setup criteria.',
  wait: 'WAIT means Quant does not see a clean active setup yet. The direction may be promising or weak, but confirmation, price structure, participation, data quality or risk conditions are not strong enough for BUY or SELL.',
  sell: 'Quant sees confirmed weakness in this setup. SELL does not guarantee further decline. If you do not own the security, read it as a negative research setup rather than a personal instruction.',
};

export const EVIDENCE_STATE_TITLES: Record<EvidenceState, string> = {
  supports: 'Supports',
  mixed: 'Mixed',
  weakens: 'Weakens',
};

export const EVIDENCE_STATE_MEANINGS: Record<EvidenceState, string> = {
  supports: 'This part of the evidence agrees with the conclusion shown above.',
  mixed: 'This part is two-sided or too close to call either way.',
  weakens: 'This part argues against the conclusion shown above.',
};

export const EVIDENCE_UNAVAILABLE_DETAIL = 'There is not enough data to measure this yet.';

export const CATEGORY_TITLES: Record<SignalEvidenceCategory, string> = {
  trend: 'Trend',
  momentum: 'Momentum',
  volume: 'Volume',
  'price-acceptance': 'Price Acceptance',
  'relative-strength': 'Relative Strength',
  'market-context': 'Market Context',
  'risk-plan': 'Risk Plan',
};

export const CATEGORY_SHORT_MEANINGS: Record<SignalEvidenceCategory, string> = {
  trend: 'Is price moving in a clear direction over time?',
  momentum: 'Is the move gaining or losing force?',
  volume: 'Is enough trading activity supporting the move?',
  'price-acceptance': 'Is the market holding above or below an important price area?',
  'relative-strength': 'Is this symbol doing better or worse than its market or sector?',
  'market-context': 'Does the broader market environment support the setup?',
  'risk-plan': 'Can the setup define a reasonable entry, exit and invalidation?',
};

export const CATEGORY_EXPANDED_MEANINGS: Record<SignalEvidenceCategory, string> = {
  trend:
    'Trend looks at the broader price structure and how the moving averages line up. Longer-term direction, distance from the yearly range, and whether price is reclaiming or losing its averages are all combined into one result.',
  momentum:
    'Momentum summarises the speed and persistence of recent price movement. Several indicators contribute behind the scenes, but the screen shows only the combined result.',
  volume:
    'Volume checks whether recent price movement is backed by meaningful participation, compared with this symbol’s own recent activity. It does not repeat what Price Acceptance measures.',
  'price-acceptance':
    'Price Acceptance looks at where trading has concentrated recently, and whether price is holding outside that area, drifting back into it, or being rejected from it. Holding a level matters more than touching it once.',
  'relative-strength':
    'Relative Strength compares the symbol with an appropriate market or sector benchmark, so you can tell whether the move belongs to this symbol or is happening everywhere.',
  'market-context':
    'Market Context uses Quant’s cross-asset market pulse — trend, breadth, stability, risk appetite and macro health. It contributes evidence to this symbol’s conclusion; it never produces a second conclusion of its own.',
  'risk-plan':
    'Risk Plan checks whether Quant can define a usable entry, stop, target and reward-to-risk shape. A directionally strong setup still waits if the risk plan is not usable.',
};

/** The sentence a row shows. Keyed on the lean, because the row says what price
 *  is doing — so it reads correctly under a SELL as well as a BUY. */
export const CATEGORY_LEAN_SENTENCES: Record<
  Exclude<SignalEvidenceCategory, 'risk-plan'>,
  Record<EvidenceLean, string>
> = {
  trend: {
    bullish: 'Trend is strong',
    mixed: 'Trend is unclear',
    bearish: 'Trend has weakened',
  },
  momentum: {
    bullish: 'Momentum is building',
    mixed: 'Momentum is mixed',
    bearish: 'Momentum is fading',
  },
  volume: {
    bullish: 'Participation is backing the move',
    mixed: 'Participation is uneven',
    bearish: 'Participation is thin',
  },
  'price-acceptance': {
    bullish: 'Price is holding above a key area',
    mixed: 'Price is inside a key area',
    bearish: 'Price is holding below a key area',
  },
  'relative-strength': {
    bullish: 'Leading its market',
    mixed: 'Moving with its market',
    bearish: 'Lagging its market',
  },
  'market-context': {
    bullish: 'Market conditions are supportive',
    mixed: 'Market conditions are balanced',
    bearish: 'Market conditions are restrictive',
  },
};

export const RISK_PLAN_READINESS_TITLES: Record<RiskPlanReadiness, string> = {
  ready: 'Ready',
  'needs-work': 'Needs Work',
};

export const RISK_PLAN_READINESS_SENTENCES: Record<RiskPlanReadiness, string> = {
  ready: 'Entry, stop and target are defined',
  'needs-work': 'No usable entry, stop and target yet',
};

export const RISK_PLAN_BLOCKER_REASONS: Record<RiskPlanBlocker, string> = {
  'event-risk': 'An upcoming company event is inside the active entry-risk window.',
  'target-unavailable':
    'No reliable overhead resistance was established, so a conventional upside target cannot be derived.',
  'reward-risk-below-minimum': 'Reward/risk is below the configured minimum.',
  'stop-too-wide': 'The protective stop sits too far from entry for the reward on offer.',
  'insufficient-data': 'Insufficient volatility history to define a defensible plan.',
  'unsupported-direction': 'The available geometry does not match the setup direction.',
  'position-size-zero': 'Position size resolves to zero under the current risk settings.',
  'negative-historical-expectancy':
    'Historical replay for this exact setup has negative expectancy.',
};

/** What would take a category's support away (decided conclusions), and what
 *  still has to happen (waits). */
export const CATEGORY_WATCH_LINES: Record<
  Exclude<SignalEvidenceCategory, 'risk-plan'>,
  { decided: string; pending: string }
> = {
  trend: {
    decided: 'The trend structure breaks down',
    pending: 'The trend turns clearly in one direction',
  },
  momentum: {
    decided: 'Momentum stalls',
    pending: 'Momentum picks up',
  },
  volume: {
    decided: 'Participation dries up',
    pending: 'Participation confirms the move',
  },
  'price-acceptance': {
    decided: 'Price falls back into the prior trading area',
    pending: 'Price holds outside the prior trading area',
  },
  'relative-strength': {
    decided: 'Relative strength weakens',
    pending: 'Relative strength improves',
  },
  'market-context': {
    decided: 'The market environment turns against the setup',
    pending: 'The market environment turns supportive',
  },
};

export const SIGNAL_SUMMARY_SENTENCES = {
  buy: 'The evidence is positive and confirmation is holding.',
  sell: 'The evidence is negative and the weakness is confirmed.',
  'wait-data': 'There is not enough data to judge this setup yet.',
  'wait-event-risk': 'An upcoming corporate event is inside the entry-risk window.',
  'wait-mixed': 'The evidence is currently pulling in both directions.',
  'wait-risk': 'There is no usable entry, stop and target for this setup yet.',
  'wait-unconfirmed': 'The direction is there, but confirmation is still missing.',
} as const;

export type SignalSummaryKey = keyof typeof SIGNAL_SUMMARY_SENTENCES;

export const ACCEPTANCE_APPROXIMATION_NOTE =
  'Estimated from OHLCV bars, not exchange volume-at-price.';
