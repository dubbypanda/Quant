// Full-market discovery contracts.
//
// The honesty problem this replaces: Quant 2.1 built a universe and then did
// `universe.slice(0, request.limit)` with a default near 120, while calling the
// result "US stocks". That is the first N directory rows in alphabetical order,
// not a market-wide scan.
//
// So coverage is a first-class output here, not a footnote. Every run reports
// how many symbols were in the universe, hydrated, eligible, actually scanned,
// current versus stale, and failed. No surface may describe this as "all U.S.
// securities"; the phrase is "Quant U.S. universe" plus the count.
//
// Discovery output is a **Research Candidate**, never a buy recommendation, and
// it never alters Signal Engine V2's own historical rules.

import type { MarketRegime, SetupType, TradeDecision } from './quant';
import type { HistoricalValidationSummary } from './signalV2';

export type DiscoveryAssetType = 'stock' | 'etf';

export interface DiscoveryUniverseMember {
  symbol: string;
  name: string;
  assetType: DiscoveryAssetType;
  exchange: string;
  active: boolean;
  sector?: string;
  industry?: string;
  /** Explicit metadata, never inferred from the ticker string: "TQQQ" being
   *  leveraged is a fact about the fund, and a name-pattern guess would
   *  mislabel legitimate symbols. */
  leveraged?: boolean;
  inverse?: boolean;
  singleStockEtf?: boolean;
}

export interface UniverseCoverage {
  universeCount: number;
  hydratedCount: number;
  eligibleCount: number;
  scannedCount: number;
  /** Scanned symbols whose newest bar is the current session. */
  currentSessionCount: number;
  staleCount: number;
  failedCount: number;
  asOf: string;
}

export interface DiscoveryEligibilitySettings {
  minimumPrice: number;
  minimumMedianDollarVolume20: number;
  minimumHistoryBars: number;
  includeEtfs: boolean;
  includeLeveragedEtfs: boolean;
  includeInverseEtfs: boolean;
  includeSingleStockEtfs: boolean;
}

export const DEFAULT_ELIGIBILITY_SETTINGS: DiscoveryEligibilitySettings = {
  minimumPrice: 2,
  minimumMedianDollarVolume20: 5_000_000,
  minimumHistoryBars: 140,
  includeEtfs: true,
  includeLeveragedEtfs: false,
  includeInverseEtfs: false,
  includeSingleStockEtfs: false,
};

/** History we want per symbol so discovery is cheap after the first pass. */
export const PREFERRED_HISTORY_BARS = 260;

export interface DiscoveryFeatures {
  symbol: string;
  asOf: number;
  return1: number | null;
  return5: number | null;
  return20: number | null;
  return63: number | null;
  return126: number | null;
  realizedVol20: number | null;
  atrPercent14: number | null;
  volumeRatio20: number | null;
  dollarVolumeMedian20: number | null;
  distanceMa20Atr: number | null;
  distanceMa50Atr: number | null;
  distanceMa200Percent: number | null;
  distance52wHighPercent: number | null;
  /** Robust (median/MAD) z-score of the latest 20-day return. Stored uncapped. */
  returnZ20: number | null;
  volumeZ60: number | null;
  volatilityRatio20To60: number | null;
  spyResidual5: number | null;
  spyResidual20: number | null;
  sectorResidual5: number | null;
  sectorResidual20: number | null;
  relativeStrengthPercentile126: number | null;
  regime: MarketRegime;
  priorRegime: MarketRegime | null;
}

/**
 * Attention components, each individually capped.
 *
 * The cap per group is the point: Quant 2.x could reward the same move three
 * times by scoring its 1-day, 5-day and 20-day versions separately. A group
 * ceiling makes correlated evidence unable to compound.
 */
export interface AttentionComponents {
  abnormalMove: number; // 0..20
  participation: number; // 0..15
  relativeStrength: number; // 0..15
  structuralChange: number; // 0..15
  modelEvidence: number; // 0..15
  novelty: number; // 0..10
  personalRelevance: number; // 0..10
  qualityPenalty: number; // 0..30, subtracted
}

export const ATTENTION_COMPONENT_CAPS = {
  abnormalMove: 20,
  participation: 15,
  relativeStrength: 15,
  structuralChange: 15,
  modelEvidence: 15,
  novelty: 10,
  personalRelevance: 10,
  qualityPenalty: 30,
} as const;

export interface NoveltyResult {
  score: number; // 0..10
  changes: string[];
}

export interface PersonalRelevance {
  score: number; // 0..10
  reasons: Array<{
    kind: 'owned' | 'indirect-exposure' | 'correlated' | 'sector' | 'diversifier' | 'event';
    text: string;
    value?: number;
  }>;
}

export interface DiscoveryCandidate {
  symbol: string;
  name: string;
  assetType: DiscoveryAssetType;
  asOf: string;
  attentionScore: number;
  components: AttentionComponents;
  features: DiscoveryFeatures;
  decision: TradeDecision | null;
  setupType: SetupType | null;
  setupQuality: number | null;
  historicalEvidence?: HistoricalValidationSummary;
  novelty: NoveltyResult;
  personal?: PersonalRelevance;
  dataAgeSeconds: number;
  warnings: string[];
}

export interface DiscoveryRunResult {
  id: string;
  startedAt: string;
  completedAt: string;
  coverage: UniverseCoverage;
  settings: DiscoveryEligibilitySettings;
  preliminaryCount: number;
  deepCount: number;
  candidates: DiscoveryCandidate[];
}

/** Configurable ceilings, not claims about how many symbols exist. */
export const DISCOVERY_FUNNEL = {
  preliminaryCeiling: 300,
  deepCeiling: 50,
  todayCeiling: 20,
} as const;

export interface UniverseHydrationStatus {
  running: boolean;
  total: number;
  complete: number;
  current: string[];
  failed: number;
  startedAt: string | null;
  updatedAt: string;
}

export interface DiscoveryEligibilityResult {
  eligible: boolean;
  reasons: string[];
  /** True when the symbol passes only because the user relaxed a liquidity
   *  threshold. The row is shown, and visibly flagged. */
  lowLiquidity: boolean;
}

/**
 * Attention score. A ranking heuristic, and deliberately not a probability —
 * the UI must label it `Attention`, never `Confidence`.
 */
export function attentionScore(components: AttentionComponents): number {
  const total =
    Math.min(ATTENTION_COMPONENT_CAPS.abnormalMove, Math.max(0, components.abnormalMove)) +
    Math.min(ATTENTION_COMPONENT_CAPS.participation, Math.max(0, components.participation)) +
    Math.min(ATTENTION_COMPONENT_CAPS.relativeStrength, Math.max(0, components.relativeStrength)) +
    Math.min(ATTENTION_COMPONENT_CAPS.structuralChange, Math.max(0, components.structuralChange)) +
    Math.min(ATTENTION_COMPONENT_CAPS.modelEvidence, Math.max(0, components.modelEvidence)) +
    Math.min(ATTENTION_COMPONENT_CAPS.novelty, Math.max(0, components.novelty)) +
    Math.min(
      ATTENTION_COMPONENT_CAPS.personalRelevance,
      Math.max(0, components.personalRelevance),
    ) -
    Math.min(ATTENTION_COMPONENT_CAPS.qualityPenalty, Math.max(0, components.qualityPenalty));
  return Math.max(0, Math.min(100, total));
}

export function emptyAttentionComponents(): AttentionComponents {
  return {
    abnormalMove: 0,
    participation: 0,
    relativeStrength: 0,
    structuralChange: 0,
    modelEvidence: 0,
    novelty: 0,
    personalRelevance: 0,
    qualityPenalty: 0,
  };
}

/** The label the UI must use. Centralised so "Confidence" cannot creep in. */
export const ATTENTION_LABEL = 'Attention';
export const ATTENTION_CAPTION =
  'Attention is a ranking heuristic for what to look at first. It is not a probability, a forecast, or a recommendation.';
export const DISCOVERY_OUTPUT_LABEL = 'Research Candidate';
export const UNIVERSE_LABEL = 'Quant U.S. universe';

/**
 * Evaluates eligibility.
 *
 * Every rejection reason is returned so the coverage bar can explain the funnel
 * rather than just reporting that most of the universe vanished.
 */
export function evaluateDiscoveryEligibility(args: {
  member: DiscoveryUniverseMember;
  lastClose: number | null;
  medianDollarVolume20: number | null;
  historyBars: number;
  settings?: DiscoveryEligibilitySettings;
}): DiscoveryEligibilityResult {
  const settings = args.settings ?? DEFAULT_ELIGIBILITY_SETTINGS;
  const { member } = args;
  const reasons: string[] = [];

  if (!member.active) reasons.push('Symbol is not active.');
  if (member.assetType === 'etf' && !settings.includeEtfs) reasons.push('ETFs are excluded.');
  // Explicit metadata only. A ticker-name guess would exclude real symbols and
  // admit leveraged funds whose names do not advertise it.
  if (member.leveraged && !settings.includeLeveragedEtfs) {
    reasons.push('Leveraged funds are excluded.');
  }
  if (member.inverse && !settings.includeInverseEtfs) reasons.push('Inverse funds are excluded.');
  if (member.singleStockEtf && !settings.includeSingleStockEtfs) {
    reasons.push('Single-stock funds are excluded.');
  }

  if (args.lastClose === null || !Number.isFinite(args.lastClose)) {
    reasons.push('No usable price.');
  } else if (args.lastClose < settings.minimumPrice) {
    reasons.push(`Price below $${settings.minimumPrice}.`);
  }

  if (args.historyBars < settings.minimumHistoryBars) {
    reasons.push(`Only ${args.historyBars} daily bars; ${settings.minimumHistoryBars} required.`);
  }

  const dollarVolume = args.medianDollarVolume20;
  if (dollarVolume === null || !Number.isFinite(dollarVolume)) {
    reasons.push('No usable dollar volume.');
  } else if (dollarVolume < settings.minimumMedianDollarVolume20) {
    reasons.push('Median dollar volume below the threshold.');
  }

  // "Low liquidity" is relative to the default, not to the user's relaxed
  // setting: relaxing the threshold reveals thin names, it does not make them
  // thick.
  const lowLiquidity =
    dollarVolume !== null &&
    Number.isFinite(dollarVolume) &&
    dollarVolume < DEFAULT_ELIGIBILITY_SETTINGS.minimumMedianDollarVolume20;

  return { eligible: reasons.length === 0, reasons, lowLiquidity };
}
