// Stationary block bootstrap over weighted analogues.
//
// Independent daily draws destroy volatility clustering: real markets have
// quiet weeks and violent weeks, and a path assembled from unrelated single
// days has neither. The stationary bootstrap preserves it by continuing along
// consecutive historical sessions with probability `c = 1 - 1/L`, restarting
// from a freshly-weighted analogue otherwise — so the expected block length is
// L sessions and the resulting series is stationary by construction.
//
// The generator is seeded and deterministic. `Math.random()` would make a run
// unreproducible, which the reproducibility gates in docs/quant-v3/05 forbid.

import { mulberry32, stringToSeed } from './signalStatistics';
import type { QrmHorizon } from './qrm';
import type { WeightedAnalogue } from './qrmAnalogue';

export const DEFAULT_BLOCK_LENGTH = 5;

export const QRM_PATH_COUNTS = {
  discovery: 500,
  research: 1_000,
  lab: 2_000,
} as const;

export interface QrmSimulatedPath {
  /** Cumulative return factor per simulated session, starting after entry. */
  closes: number[];
  terminalReturns: Record<QrmHorizon, number>;
  mfe: Record<QrmHorizon, number>;
  mae: Record<QrmHorizon, number>;
  /** Which of -5% / +5% was breached first, when either was. */
  firstHit: 'loss' | 'gain' | null;
}

export interface BootstrapArgs {
  analogues: WeightedAnalogue[];
  horizons: QrmHorizon[];
  paths: number;
  seed: number;
  /** Mean block length in sessions. */
  blockLength?: number;
  symbol?: string;
  /** Checked between path batches so a long run can be cancelled. */
  isCancelled?: () => boolean;
  onProgress?: (completed: number, total: number) => void;
  progressEvery?: number;
}

/** Cumulative weights for O(log n) weighted selection. */
function cumulativeWeights(analogues: WeightedAnalogue[]): number[] {
  const out: number[] = [];
  let total = 0;
  for (const analogue of analogues) {
    total += Math.max(0, analogue.weight);
    out.push(total);
  }
  return out;
}

function selectIndex(cumulative: number[], random: number): number {
  const target = random * cumulative[cumulative.length - 1];
  let low = 0;
  let high = cumulative.length - 1;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

export class QrmCancelledError extends Error {
  constructor() {
    super('The QRM run was cancelled.');
    this.name = 'QrmCancelledError';
  }
}

/**
 * Simulates forward paths.
 *
 * Each step either continues the current analogue's next historical session or
 * jumps to a newly-weighted analogue. When an analogue runs out of subsequent
 * sessions the walk restarts rather than padding with zeros, which would inject
 * artificial calm exactly where data ran out.
 */
export function simulateQrmPaths(args: BootstrapArgs): QrmSimulatedPath[] {
  const { analogues, horizons, paths } = args;
  if (!analogues.length) return [];
  const blockLength = Math.max(1, args.blockLength ?? DEFAULT_BLOCK_LENGTH);
  const continuationProbability = 1 - 1 / blockLength;
  const maxHorizon = Math.max(...horizons);
  const progressEvery = Math.max(1, args.progressEvery ?? 50);

  // Seeded from both the configured seed and the symbol, so two symbols in one
  // run do not share an identical path set.
  const random = mulberry32((args.seed ^ stringToSeed(args.symbol ?? 'qrm')) >>> 0);
  const cumulative = cumulativeWeights(analogues);

  const out: QrmSimulatedPath[] = [];
  for (let pathIndex = 0; pathIndex < paths; pathIndex++) {
    if (pathIndex % progressEvery === 0) {
      if (args.isCancelled?.()) throw new QrmCancelledError();
      args.onProgress?.(pathIndex, paths);
    }

    let analogueIndex = selectIndex(cumulative, random());
    let step = 0;
    let factor = 1;
    let high = 1;
    let low = 1;
    const closes: number[] = [];
    let firstHit: 'loss' | 'gain' | null = null;

    for (let session = 0; session < maxHorizon; session++) {
      const source = analogues[analogueIndex].record.subsequentDailyReturns;
      if (step >= source.length) {
        // Out of realised sessions: restart from a new analogue rather than
        // padding with a zero return.
        analogueIndex = selectIndex(cumulative, random());
        step = 0;
        if (!analogues[analogueIndex].record.subsequentDailyReturns.length) {
          closes.push(factor);
          continue;
        }
      }
      const dailyReturn = analogues[analogueIndex].record.subsequentDailyReturns[step] ?? 0;
      factor *= 1 + dailyReturn;
      high = Math.max(high, factor);
      low = Math.min(low, factor);
      closes.push(factor);

      if (firstHit === null) {
        if (factor - 1 <= -0.05) firstHit = 'loss';
        else if (factor - 1 >= 0.05) firstHit = 'gain';
      }

      step += 1;
      if (random() >= continuationProbability) {
        analogueIndex = selectIndex(cumulative, random());
        step = 0;
      }
    }

    const terminalReturns = {} as Record<QrmHorizon, number>;
    const mfe = {} as Record<QrmHorizon, number>;
    const mae = {} as Record<QrmHorizon, number>;
    for (const horizon of horizons) {
      const upTo = closes.slice(0, horizon);
      const terminal = upTo.length ? upTo[upTo.length - 1] : 1;
      terminalReturns[horizon] = terminal - 1;
      mfe[horizon] = Math.max(0, Math.max(1, ...upTo) - 1);
      mae[horizon] = Math.max(0, 1 - Math.min(1, ...upTo));
    }

    out.push({ closes, terminalReturns, mfe, mae, firstHit });
  }

  args.onProgress?.(paths, paths);
  return out;
}

/** Unweighted quantiles of a simulated path set, per horizon. */
export function pathQuantiles(values: number[]): {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
} {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => {
    if (!sorted.length) return 0;
    const index = (sorted.length - 1) * q;
    const low = Math.floor(index);
    const high = Math.ceil(index);
    if (low === high) return sorted[low];
    return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
  };
  return { p10: at(0.1), p25: at(0.25), p50: at(0.5), p75: at(0.75), p90: at(0.9) };
}
