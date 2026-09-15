// QRM-3 contracts — Quant Research Model, version 3 research track.
// Shapes defined by docs/quant-v3/05-qrm-research-model-and-lab.md section 2.
//
// QRM is NOT a score layered onto Signal Engine V2. It is a separate
// point-in-time research pipeline, and it is experimental in 3.0 until the
// promotion gates in that document are passed. Signal Engine V2 remains the
// independent deterministic authority until then.
//
// This module is types plus pure helpers only. The analogue matcher, stationary
// block bootstrap and walk-forward harness (that document's Tasks 1-11) are not
// implemented here; `kronosDistribution.ts` supplies a `QrmHorizonDistribution`
// from the existing Kronos ensemble so the decision functional and its tests
// have a real distribution to read in the meantime.
//
// Per section 18, QRM and Kronos are never merged by averaging: they are
// different models with different assumptions, and a disagreement between them
// is research context rather than something to average away.

import type { DataSource } from './types';
import type { MarketRegime } from './quant';

export type QrmHorizon = 1 | 5 | 10;

export interface QrmConfig {
  modelVersion: string;
  historyYears: number;
  analoguePoolSize: number;
  targetEss: number;
  minEss: number;
  paths: number;
  stationaryBlockMean: number;
  horizons: QrmHorizon[];
  seed: number;
}

/** Point-in-time normalized market state. Every field is a function of bars at
 *  or before `asOf`; nothing here may read a later observation. */
export interface QrmStateVector {
  asOf: number;
  return1Z: number;
  return5Z: number;
  return20Z: number;
  realizedVol20Z: number;
  volatilityRatio20To60: number;
  volumeZ60: number;
  ma20DistanceAtr: number;
  ma50DistanceAtr: number;
  distance52wHighZ: number;
  spyResidual5Z: number;
  spyResidual20Z: number;
  relativeStrength126: number;
  regime: MarketRegime;
}

export interface QrmQuantiles {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface QrmHorizonDistribution {
  horizon: QrmHorizon;
  /** Terminal return over the horizon, as a fraction. */
  terminalReturn: QrmQuantiles;
  probabilityPositive: number;
  /** Maximum favourable excursion, as a positive fraction. */
  mfe: QrmQuantiles;
  /** Maximum adverse excursion. Sign is not assumed; consumers take magnitudes. */
  mae: QrmQuantiles;
  probabilityLoss5PercentBeforeGain5Percent: number | null;
}

export interface QrmDiagnostics {
  analogueCount: number;
  effectiveSampleSize: number;
  kernelTemperature: number;
  nearestDistance: number;
  medianDistance: number;
  regimeMatchPercent: number;
  dataCutoffTime: number;
  computationMs: number;
  warnings: string[];
}

export interface QrmForecastSnapshot {
  id: string;
  symbol: string;
  createdAt: string;
  config: QrmConfig;
  state: QrmStateVector;
  distributions: QrmHorizonDistribution[];
  diagnostics: QrmDiagnostics;
  /** May be omitted from persisted records if size becomes excessive; the
   *  quantiles and reproducibility metadata are mandatory. */
  sampledPaths?: number[][];
  source: DataSource;
}

/**
 * UI-neutral adapter so future models can coexist (section 19).
 *
 * Deliberately not a shared numeric confidence score: each model keeps its
 * native semantics, and the labels are strings because "WAIT" and "sampled
 * median positive" are not points on one scale.
 */
export interface ResearchModelView {
  modelId: string;
  modelVersion: string;
  status: 'ready' | 'running' | 'unavailable' | 'failed';
  directionalView: 'bullish' | 'bearish' | 'neutral' | 'none';
  decisionLabel: string;
  horizonLabel: string;
  reliabilityLabel: string;
  diagnostics: Array<{ label: string; value: string }>;
}

/** Sorted-sample quantile with linear interpolation. */
export function quantileOf(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Builds the five-point summary the contracts use. Input need not be sorted. */
export function quantilesOf(values: number[]): QrmQuantiles {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    p10: quantileOf(sorted, 0.1),
    p25: quantileOf(sorted, 0.25),
    p50: quantileOf(sorted, 0.5),
    p75: quantileOf(sorted, 0.75),
    p90: quantileOf(sorted, 0.9),
  };
}
