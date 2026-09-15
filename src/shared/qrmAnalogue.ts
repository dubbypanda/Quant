// Historical analogue records, the distance function, and ESS-targeted kernel
// bandwidth.
//
// The leakage rule is the important one. A candidate analogue at index `i` is
// eligible only if its longest forward horizon fully realised **before** the
// inference cutoff. Without that, a 10-day-horizon analogue drawn from nine
// days ago is partly made of the same future the model is being asked to
// predict, and the benchmark would reward the leak.
//
// Bandwidth is solved for an effective sample size rather than fixed. A fixed
// temperature quietly concentrates all posterior weight into two or three
// analogues on some states and spreads it uselessly flat on others; targeting
// ESS makes the effective sample comparable across states, and reports when the
// target could not be reached instead of pretending otherwise.

import type { MarketRegime } from './quant';
import type { QrmHorizon, QrmStateVector } from './qrm';

export interface QrmAnalogueRecord {
  time: number;
  state: QrmStateVector;
  forwardReturns: Record<QrmHorizon, number>;
  forwardMfe: Record<QrmHorizon, number>;
  forwardMae: Record<QrmHorizon, number>;
  /** Daily returns following the analogue, for the block bootstrap. */
  subsequentDailyReturns: number[];
}

/** Versioned research parameters, not immutable truths. Any change is a new
 *  model/config version and must be benchmarked. */
export const QRM_FEATURE_WEIGHTS = {
  return1Z: 0.5,
  return5Z: 0.75,
  return20Z: 1.0,
  realizedVol20Z: 1.0,
  volatilityRatio20To60: 1.0,
  volumeZ60: 0.5,
  ma20DistanceAtr: 0.75,
  ma50DistanceAtr: 0.75,
  distance52wHighZ: 0.5,
  spyResidual5Z: 1.0,
  spyResidual20Z: 1.0,
  relativeStrength126: 0.75,
} as const;

export type QrmFeatureKey = keyof typeof QRM_FEATURE_WEIGHTS;

/** Trend families, so compatibility is a named relationship rather than a
 *  number buried in the kernel. */
const TREND_UP: MarketRegime[] = ['trending-up', 'breakout-compression'];
const TREND_DOWN: MarketRegime[] = ['trending-down'];
const NEUTRAL: MarketRegime[] = ['range-bound', 'low-volatility', 'mean-reversion', 'choppy'];
const VOLATILE: MarketRegime[] = ['high-volatility'];

export const REGIME_COMPATIBILITY = {
  same: 1.0,
  compatibleFamily: 0.8,
  unrelated: 0.55,
  opposed: 0.3,
} as const;

function familyOf(regime: MarketRegime): 'up' | 'down' | 'neutral' | 'volatile' {
  if (TREND_UP.includes(regime)) return 'up';
  if (TREND_DOWN.includes(regime)) return 'down';
  if (VOLATILE.includes(regime)) return 'volatile';
  if (NEUTRAL.includes(regime)) return 'neutral';
  return 'neutral';
}

/** Explicit, deterministic compatibility multiplier. */
export function regimeCompatibility(current: MarketRegime, analogue: MarketRegime): number {
  if (current === analogue) return REGIME_COMPATIBILITY.same;
  const a = familyOf(current);
  const b = familyOf(analogue);
  if (a === b) return REGIME_COMPATIBILITY.compatibleFamily;
  // Up versus down is the one genuinely opposed pairing; everything else is
  // merely unrelated.
  if ((a === 'up' && b === 'down') || (a === 'down' && b === 'up')) {
    return REGIME_COMPATIBILITY.opposed;
  }
  return REGIME_COMPATIBILITY.unrelated;
}

/** Weighted squared Euclidean distance over the standardised features. */
export function stateDistanceSquared(
  current: QrmStateVector,
  analogue: QrmStateVector,
  weights: Record<QrmFeatureKey, number> = QRM_FEATURE_WEIGHTS,
): number {
  let total = 0;
  for (const key of Object.keys(weights) as QrmFeatureKey[]) {
    const a = current[key];
    const b = analogue[key];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    total += weights[key] * (a - b) ** 2;
  }
  return total;
}

export interface BuildAnalogueArgs {
  candles: import('./types').Candle[];
  spyCandles: import('./types').Candle[];
  /** Index of the inference bar. Candidates must fully realise their horizon
   *  strictly before this. */
  cutoffIndex: number;
  horizons: QrmHorizon[];
  stateBuilder: (
    candles: import('./types').Candle[],
    spy: import('./types').Candle[],
    index: number,
  ) => QrmStateVector | null;
  /** Stride between candidate origins. 1 evaluates every bar. */
  stride?: number;
  maximumCandidates?: number;
}

/**
 * Builds eligible analogue records.
 *
 * `maxHorizon` bars of realised future are required *before* the cutoff, which
 * is what makes the resulting distribution a genuine out-of-sample object.
 */
export function buildAnalogueRecords(args: BuildAnalogueArgs): QrmAnalogueRecord[] {
  const { candles, spyCandles, cutoffIndex, horizons, stateBuilder } = args;
  const stride = Math.max(1, args.stride ?? 1);
  const maxHorizon = Math.max(...horizons);
  const records: QrmAnalogueRecord[] = [];

  // The last eligible origin is `maxHorizon` bars before the cutoff, and
  // strictly earlier than it.
  const lastEligible = cutoffIndex - maxHorizon - 1;
  for (let i = lastEligible; i >= 0; i -= stride) {
    if (args.maximumCandidates !== undefined && records.length >= args.maximumCandidates) break;
    const state = stateBuilder(candles, spyCandles, i);
    if (!state) continue;

    const entry = candles[i].close;
    if (!Number.isFinite(entry) || entry <= 0) continue;

    const forwardReturns = {} as Record<QrmHorizon, number>;
    const forwardMfe = {} as Record<QrmHorizon, number>;
    const forwardMae = {} as Record<QrmHorizon, number>;
    let usable = true;

    for (const horizon of horizons) {
      const end = i + horizon;
      if (end > cutoffIndex - 1) {
        usable = false;
        break;
      }
      let high = -Infinity;
      let low = Infinity;
      for (let j = i + 1; j <= end; j++) {
        high = Math.max(high, candles[j].high);
        low = Math.min(low, candles[j].low);
      }
      if (!Number.isFinite(high) || !Number.isFinite(low)) {
        usable = false;
        break;
      }
      forwardReturns[horizon] = candles[end].close / entry - 1;
      forwardMfe[horizon] = Math.max(0, high / entry - 1);
      forwardMae[horizon] = Math.max(0, 1 - low / entry);
    }
    if (!usable) continue;

    const subsequentDailyReturns: number[] = [];
    for (let j = i + 1; j <= Math.min(cutoffIndex - 1, i + maxHorizon); j++) {
      const previous = candles[j - 1].close;
      if (previous > 0) subsequentDailyReturns.push(candles[j].close / previous - 1);
    }

    records.push({
      time: candles[i].time,
      state,
      forwardReturns,
      forwardMfe,
      forwardMae,
      subsequentDailyReturns,
    });
  }
  return records;
}

export interface WeightedAnalogue {
  record: QrmAnalogueRecord;
  distanceSquared: number;
  regimeMultiplier: number;
  weight: number;
}

/** Nearest `poolSize` candidates by weighted distance. */
export function nearestAnalogues(
  current: QrmStateVector,
  records: QrmAnalogueRecord[],
  poolSize: number,
  weights: Record<QrmFeatureKey, number> = QRM_FEATURE_WEIGHTS,
): Array<{ record: QrmAnalogueRecord; distanceSquared: number; regimeMultiplier: number }> {
  return records
    .map((record) => ({
      record,
      distanceSquared: stateDistanceSquared(current, record.state, weights),
      regimeMultiplier: regimeCompatibility(current.regime, record.state.regime),
    }))
    .sort((a, b) => a.distanceSquared - b.distanceSquared || a.record.time - b.record.time)
    .slice(0, Math.max(1, poolSize));
}

export interface KernelSolution {
  temperature: number;
  ess: number;
  reachable: boolean;
  iterations: number;
}

/** ESS of the normalised weights: `(Σw)² / Σw²`. */
export function effectiveSampleSize(rawWeights: number[]): number {
  let sum = 0;
  let sumSquares = 0;
  for (const weight of rawWeights) {
    if (!Number.isFinite(weight) || weight <= 0) continue;
    sum += weight;
    sumSquares += weight * weight;
  }
  if (!(sumSquares > 0)) return 0;
  return (sum * sum) / sumSquares;
}

function rawWeightsFor(
  distances: number[],
  regimeMultipliers: number[],
  temperature: number,
): number[] {
  // The minimum distance is subtracted before exponentiating. Mathematically it
  // cancels in the normalisation, but without it exp(-d²/tau) underflows to
  // zero for every analogue at small tau and the ESS becomes 0 instead of 1.
  const minDistance = Math.min(...distances);
  return distances.map((distance, index) => {
    const value = Math.exp(-(distance - minDistance) / Math.max(temperature, 1e-12));
    const multiplier = regimeMultipliers[index] ?? 1;
    const weight = value * multiplier;
    return Number.isFinite(weight) && weight > 0 ? weight : 0;
  });
}

/**
 * Solves kernel temperature for a target ESS by bisection on log(tau).
 *
 * ESS increases monotonically with temperature — a hotter kernel spreads weight
 * — which is what makes bisection valid, and is asserted in the tests rather
 * than assumed here.
 */
export function solveKernelTemperature(
  distances: number[],
  regimeMultipliers: number[],
  targetEss: number,
  maximumIterations = 24,
): KernelSolution {
  if (!distances.length) return { temperature: 1, ess: 0, reachable: false, iterations: 0 };
  if (distances.length === 1) {
    return { temperature: 1, ess: 1, reachable: targetEss <= 1, iterations: 0 };
  }

  const essAt = (temperature: number) =>
    effectiveSampleSize(rawWeightsFor(distances, regimeMultipliers, temperature));

  let lowLog = Math.log(1e-6);
  let highLog = Math.log(1e6);

  // The ceiling is the ESS of an infinitely hot kernel: regime multipliers
  // alone, since the distance term goes to 1 for every analogue.
  const maximumEss = effectiveSampleSize(
    regimeMultipliers.length === distances.length
      ? regimeMultipliers.map((multiplier) => (multiplier > 0 ? multiplier : 0))
      : distances.map(() => 1),
  );
  if (targetEss >= maximumEss) {
    const temperature = Math.exp(highLog);
    return { temperature, ess: essAt(temperature), reachable: false, iterations: 0 };
  }

  let iterations = 0;
  let temperature = Math.exp((lowLog + highLog) / 2);
  let ess = essAt(temperature);
  for (; iterations < maximumIterations; iterations++) {
    temperature = Math.exp((lowLog + highLog) / 2);
    ess = essAt(temperature);
    if (Math.abs(ess - targetEss) / targetEss < 0.005) break;
    if (ess < targetEss) lowLog = Math.log(temperature);
    else highLog = Math.log(temperature);
  }

  return { temperature, ess, reachable: Math.abs(ess - targetEss) / targetEss < 0.05, iterations };
}

/** Normalised analogue weights at a solved temperature. */
export function weightAnalogues(
  candidates: Array<{
    record: QrmAnalogueRecord;
    distanceSquared: number;
    regimeMultiplier: number;
  }>,
  temperature: number,
): WeightedAnalogue[] {
  const raw = rawWeightsFor(
    candidates.map((candidate) => candidate.distanceSquared),
    candidates.map((candidate) => candidate.regimeMultiplier),
    temperature,
  );
  const total = raw.reduce((sum, weight) => sum + weight, 0);
  if (!(total > 0)) {
    return candidates.map((candidate) => ({ ...candidate, weight: 1 / candidates.length }));
  }
  return candidates.map((candidate, index) => ({ ...candidate, weight: raw[index] / total }));
}

/**
 * Weighted quantile.
 *
 * Interpolates within the cumulative weight distribution rather than picking
 * the first crossing bucket, so equal weights reproduce the ordinary empirical
 * quantile.
 */
export function weightedQuantile(values: number[], weights: number[], q: number): number {
  if (!values.length) throw new RangeError('weightedQuantile requires at least one value');
  if (values.length !== weights.length) {
    throw new RangeError('values and weights must be the same length');
  }
  if (!Number.isFinite(q) || q < 0 || q > 1) {
    throw new RangeError('q must be within [0, 1]');
  }
  for (const weight of weights) {
    if (!Number.isFinite(weight) || weight <= 0) {
      throw new RangeError('weights must be finite and positive');
    }
  }

  const pairs = values
    .map((value, index) => ({ value, weight: weights[index] }))
    .filter((pair) => Number.isFinite(pair.value))
    .sort((a, b) => a.value - b.value);
  if (!pairs.length) throw new RangeError('weightedQuantile requires finite values');
  if (pairs.length === 1) return pairs[0].value;

  const total = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  // Midpoint cumulative positions: the convention that makes equal weights
  // match the standard interpolated empirical quantile exactly.
  let cumulative = 0;
  const positions = pairs.map((pair) => {
    const position = (cumulative + pair.weight / 2) / total;
    cumulative += pair.weight;
    return position;
  });

  if (q <= positions[0]) return pairs[0].value;
  if (q >= positions[positions.length - 1]) return pairs[pairs.length - 1].value;
  for (let i = 1; i < positions.length; i++) {
    if (q <= positions[i]) {
      const span = positions[i] - positions[i - 1];
      if (span <= 0) return pairs[i].value;
      const fraction = (q - positions[i - 1]) / span;
      return pairs[i - 1].value + fraction * (pairs[i].value - pairs[i - 1].value);
    }
  }
  return pairs[pairs.length - 1].value;
}
