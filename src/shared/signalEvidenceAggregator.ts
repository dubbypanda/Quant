// Consolidates raw factors and external context into the canonical evidence
// categories. Ported from the Quantactic iOS model
// (`SignalEvidenceAggregator.swift`).
//
// The point of this module is that the user-facing row count does not grow when
// an indicator is added: a new momentum indicator makes the Momentum row better
// informed, not the screen longer.

import type { TradeDirection } from './quant';
import type { SignalFactor, SignalFactorKind, SignalReadings } from './signalFactors';
import { factorPriceLean } from './signalFactors';
import type { PriceAcceptanceEvidence } from './volumeProfile';
import {
  ACCEPTANCE_APPROXIMATION_NOTE,
  CATEGORY_LEAN_SENTENCES,
  DIRECTIONAL_EVIDENCE_CATEGORIES,
  EVIDENCE_UNAVAILABLE_DETAIL,
  type EvidenceLean,
  type EvidenceState,
  type SignalAdvancedFact,
  type SignalEvidence,
  type SignalEvidenceCategory,
} from './unifiedSignal';
import {
  isConstructiveAcceptance,
  isDestructiveAcceptance,
  isMeasuredAcceptance,
  isTwoSidedAcceptance,
} from './volumeProfile';

/** The direction a setup is arguing for. Evidence is always stated relative to
 *  this, which is why a downtrend *supports* a SELL setup. */
export type SetupDirection = 'positive' | 'negative' | 'neutral';

/** Relative performance against a benchmark and, when known, a sector proxy. */
export interface RelativeMarketContext {
  symbol: string;
  symbolReturn: number;
  benchmarkSymbol: string;
  benchmarkReturn: number | null;
  sectorSymbol?: string;
  sectorReturn?: number | null;
}

export interface EvidenceAggregatorInputs {
  factors: SignalFactor[];
  readings: SignalReadings;
  acceptance: PriceAcceptanceEvidence | null;
  relative: RelativeMarketContext | null;
  /** Quant's cross-asset market pulse regime score, 0-100. */
  marketPulseScore: number | null;
}

/** Anything smaller than this is noise rather than a lean. */
const LEAN_THRESHOLD = 0.05;

/** Inside this much of the benchmark, it is the same move rather than leadership. */
const RELATIVE_STRENGTH_THRESHOLD_PERCENT = 1;

/**
 * The evidence category a raw factor consolidates into.
 *
 * Exhaustive with no `default` on purpose: adding a factor kind must fail to
 * compile until someone decides which row it belongs to.
 */
export function evidenceCategoryFor(kind: SignalFactorKind): SignalEvidenceCategory {
  switch (kind) {
    case 'trend-alignment':
    case 'yearly-high':
    case 'average-reclaim':
    case 'average-loss':
    case 'above-average':
    case 'below-average':
      return 'trend';
    case 'range':
      // A tight band is precisely the absence of a clear direction, and its
      // zero lean lands the row on "trend is unclear".
      return 'trend';
    case 'macd':
    case 'rsi':
    case 'momentum':
    case 'price-move':
      return 'momentum';
    case 'volume':
      return 'volume';
  }
}

export function setupDirectionFor(direction: TradeDirection): SetupDirection {
  if (direction === 'long') return 'positive';
  if (direction === 'short') return 'negative';
  return 'neutral';
}

/** A signed factor total becomes a lean once it clears the noise floor. */
function resolveLean(net: number): EvidenceLean {
  if (Math.abs(net) < LEAN_THRESHOLD) return 'mixed';
  return net > 0 ? 'bullish' : 'bearish';
}

/** Restate a lean relative to the setup being argued. */
export function evidenceStateFor(lean: EvidenceLean, direction: SetupDirection): EvidenceState {
  if (lean === 'mixed') return 'mixed';
  if (direction === 'negative') return lean === 'bearish' ? 'supports' : 'weakens';
  // With no direction of its own, a neutral setup is read the conventional way:
  // constructive evidence supports it.
  return lean === 'bullish' ? 'supports' : 'weakens';
}

function unavailable(category: SignalEvidenceCategory): SignalEvidence {
  return {
    category,
    state: 'mixed',
    lean: 'mixed',
    availability: 'unavailable',
    detail: EVIDENCE_UNAVAILABLE_DETAIL,
    advanced: [],
  };
}

function leanSentence(category: SignalEvidenceCategory, lean: EvidenceLean): string {
  if (category === 'risk-plan') return '';
  return CATEGORY_LEAN_SENTENCES[category][lean];
}

function numberFact(label: string, value: number | null, digits = 2): SignalAdvancedFact | null {
  if (value === null || !Number.isFinite(value)) return null;
  return { label, value: value.toFixed(digits) };
}

function advancedFactsFor(
  category: SignalEvidenceCategory,
  readings: SignalReadings,
): SignalAdvancedFact[] {
  switch (category) {
    case 'trend':
      return [
        numberFact('MA 20', readings.movingAverage20),
        numberFact('MA 50', readings.movingAverage50),
        numberFact('MA 120', readings.movingAverage120),
        numberFact('ATR 14', readings.atr14),
      ].filter((fact): fact is SignalAdvancedFact => fact !== null);
    case 'momentum':
      return [
        numberFact('RSI 14', readings.rsi14, 1),
        numberFact('MACD', readings.macdHistogram, 3),
      ].filter((fact): fact is SignalAdvancedFact => fact !== null);
    case 'volume': {
      const relativeVolume = readings.relativeVolume;
      if (relativeVolume === null || !Number.isFinite(relativeVolume)) return [];
      return [{ label: 'RVOL', value: `${relativeVolume.toFixed(2)}×` }];
    }
    default:
      return [];
  }
}

function factorEvidence(
  category: SignalEvidenceCategory,
  direction: SetupDirection,
  inputs: EvidenceAggregatorInputs,
): SignalEvidence {
  const factors = inputs.factors.filter((factor) => evidenceCategoryFor(factor.kind) === category);
  if (!factors.length) return unavailable(category);
  const net = factors.reduce(
    (total, factor) => total + factor.weight * factorPriceLean(factor.kind, factor.positive),
    0,
  );
  const lean = resolveLean(net);
  return {
    category,
    state: evidenceStateFor(lean, direction),
    lean,
    availability: 'measured',
    detail: leanSentence(category, lean),
    advanced: advancedFactsFor(category, inputs.readings),
  };
}

function acceptanceAdvancedFacts(acceptance: PriceAcceptanceEvidence): SignalAdvancedFact[] {
  const facts: SignalAdvancedFact[] = [];
  const level = (label: string, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return;
    facts.push({ label, value: value.toFixed(2) });
  };
  level('VAH', acceptance.valueAreaHigh);
  level('POC', acceptance.pointOfControl);
  level('VAL', acceptance.valueAreaLow);
  level('Current', acceptance.currentPrice);
  facts.push({ label: 'Completed closes', value: `${acceptance.closesBeyondBoundary}` });
  if (acceptance.relativeVolume !== null && Number.isFinite(acceptance.relativeVolume)) {
    facts.push({ label: 'RVOL', value: `${acceptance.relativeVolume.toFixed(2)}×` });
  }
  if (acceptance.isApproximation) {
    facts.push({ label: 'Method', value: ACCEPTANCE_APPROXIMATION_NOTE });
  }
  return facts;
}

function acceptanceEvidence(
  direction: SetupDirection,
  inputs: EvidenceAggregatorInputs,
): SignalEvidence {
  const acceptance = inputs.acceptance;
  if (!acceptance || !isMeasuredAcceptance(acceptance)) return unavailable('price-acceptance');
  // A balanced high-volume area is a magnet, not a direction, so it never reads
  // as support for either side.
  let lean: EvidenceLean = 'mixed';
  if (isTwoSidedAcceptance(acceptance.state)) lean = 'mixed';
  else if (isConstructiveAcceptance(acceptance.state)) lean = 'bullish';
  else if (isDestructiveAcceptance(acceptance.state)) lean = 'bearish';
  return {
    category: 'price-acceptance',
    state: evidenceStateFor(lean, direction),
    lean,
    availability: 'measured',
    detail: leanSentence('price-acceptance', lean),
    advanced: acceptanceAdvancedFacts(acceptance),
  };
}

function relativeStrengthEvidence(
  direction: SetupDirection,
  inputs: EvidenceAggregatorInputs,
): SignalEvidence {
  const relative = inputs.relative;
  if (!relative) return unavailable('relative-strength');
  const sectorExcess =
    relative.sectorReturn === null || relative.sectorReturn === undefined
      ? null
      : relative.symbolReturn - relative.sectorReturn;
  const benchmarkExcess =
    relative.benchmarkReturn === null ? null : relative.symbolReturn - relative.benchmarkReturn;
  const excess = sectorExcess ?? benchmarkExcess;
  if (excess === null || !Number.isFinite(excess)) return unavailable('relative-strength');

  const lean: EvidenceLean =
    Math.abs(excess) < RELATIVE_STRENGTH_THRESHOLD_PERCENT
      ? 'mixed'
      : excess > 0
        ? 'bullish'
        : 'bearish';

  const advanced: SignalAdvancedFact[] = [
    { label: relative.symbol, value: `${relative.symbolReturn.toFixed(1)}%` },
  ];
  if (relative.sectorSymbol && relative.sectorReturn !== null && relative.sectorReturn !== undefined) {
    advanced.push({ label: relative.sectorSymbol, value: `${relative.sectorReturn.toFixed(1)}%` });
  }
  if (relative.benchmarkReturn !== null) {
    advanced.push({
      label: relative.benchmarkSymbol,
      value: `${relative.benchmarkReturn.toFixed(1)}%`,
    });
  }

  return {
    category: 'relative-strength',
    state: evidenceStateFor(lean, direction),
    lean,
    availability: 'measured',
    detail: leanSentence('relative-strength', lean),
    advanced,
  };
}

function marketContextEvidence(
  direction: SetupDirection,
  inputs: EvidenceAggregatorInputs,
): SignalEvidence {
  const score = inputs.marketPulseScore;
  if (score === null || !Number.isFinite(score)) return unavailable('market-context');
  const lean: EvidenceLean = score >= 60 ? 'bullish' : score <= 40 ? 'bearish' : 'mixed';
  return {
    category: 'market-context',
    state: evidenceStateFor(lean, direction),
    lean,
    availability: 'measured',
    detail: leanSentence('market-context', lean),
    advanced: [{ label: 'Market pulse', value: `${Math.round(score)} / 100` }],
  };
}

/**
 * The directional rows, in canonical order.
 *
 * The risk-plan gate is deliberately not here. It has no direction, so putting
 * it in this array meant inventing a Supports/Mixed value for it and asking
 * every reader to remember to filter it back out. It travels as
 * `UnifiedSignalSummary.riskPlan` instead.
 */
export function aggregateSignalEvidence(
  direction: SetupDirection,
  inputs: EvidenceAggregatorInputs,
): SignalEvidence[] {
  return DIRECTIONAL_EVIDENCE_CATEGORIES.map((category) => {
    switch (category) {
      case 'trend':
      case 'momentum':
      case 'volume':
        return factorEvidence(category, direction, inputs);
      case 'price-acceptance':
        return acceptanceEvidence(direction, inputs);
      case 'relative-strength':
        return relativeStrengthEvidence(direction, inputs);
      case 'market-context':
        return marketContextEvidence(direction, inputs);
      default:
        return unavailable(category);
    }
  });
}
