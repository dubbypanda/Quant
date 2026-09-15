import type {
  MarketRegime,
  RiskRewardPlan,
  SetupType,
  SignalComponent,
  TradeDecision,
  TradeDirection,
} from './quant';
import type { UnifiedSignalSummary } from './unifiedSignal';

export type {
  MarketRegime,
  RiskRewardPlan,
  SetupType,
  SignalComponent,
  TradeDecision,
  TradeDirection,
};
export type { UnifiedSignalSummary };

export const SIGNAL_ENGINE_V2 = {
  strategyVersion: 'QuantDeskSignal_v2',
  timeframe: '1d',
  historyRange: '5y',
  executionModelVersion: 'DailyOHLC_Conservative_v1',
  maxHoldBars: 10,
  minWarmupBars: 140,
  entrySlippageBps: 5,
  exitSlippageBps: 5,
  commissionBpsPerSide: 0,
  minHistoricalTrades: 30,
  bootstrapSamples: 2000,
} as const;

export type SignalEvidenceStrength =
  | 'unavailable'
  | 'insufficient'
  | 'thin'
  | 'usable'
  | 'large-sample';

export type TradeExitReason =
  | 'target1'
  | 'stop'
  | 'timeout'
  | 'gap-invalidated'
  | 'gap-beyond-target'
  | 'rr-invalidated';

export interface SignalCoreEvaluation {
  symbol: string;
  timeframe: '1d';
  signalBarTime: number;
  setupType: SetupType;
  decision: TradeDecision;
  direction: TradeDirection;
  regime: MarketRegime;
  setupQuality: number;
  components: SignalComponent[];
  noTradeReasons: string[];
  reason: string;
  risk: RiskRewardPlan;
  strategyVersion: string;
}

export interface SimulatedTrade {
  strategyVersion: string;
  setupType: SetupType;
  direction: Exclude<TradeDirection, 'none'>;
  regime: MarketRegime;
  signalIndex: number;
  signalBarTime: number;
  entryIndex: number;
  entryTime: number;
  entryFill: number;
  stop: number;
  target1: number;
  initialRiskPerUnit: number;
  exitIndex: number;
  exitTime: number;
  exitFill: number;
  exitReason: 'target1' | 'stop' | 'timeout';
  holdingBars: number;
  grossR: number;
  feeR: number;
  netR: number;
}

export interface SkippedSignal {
  signalIndex: number;
  signalBarTime: number;
  reason: 'gap-invalidated' | 'gap-beyond-target' | 'rr-invalidated';
}

export interface ConfidenceInterval {
  lower: number;
  upper: number;
}

export interface HistoricalValidationSummary {
  status: 'ready' | 'unavailable';
  unavailableReason?: string;
  strategyVersion: string;
  executionModelVersion: string;
  setupType: SetupType;
  direction: TradeDirection;
  timeframe: '1d';
  historyStart?: string;
  historyEnd?: string;
  totalBars: number;
  totalMatchingSignals: number;
  eligibleTrades: number;
  skippedSignals: number;
  targetHits: number;
  stopHits: number;
  timeouts: number;
  winRatePercent: number;
  targetHitRatePercent: number;
  averageWinR: number;
  averageLossR: number;
  expectancyR: number;
  medianR: number;
  profitFactor: number;
  maxDrawdownR: number;
  bestTradeR: number;
  worstTradeR: number;
  expectancyCi95: ConfidenceInterval | null;
  winRateCi95: ConfidenceInterval | null;
  evidenceStrength: SignalEvidenceStrength;
  regimeMatched?: {
    regime: MarketRegime;
    trades: number;
    expectancyR: number;
    winRatePercent: number;
  };
}

export interface ForwardRecordSummary {
  resolvedSignals: number;
  activeSignals: number;
  targetHits: number;
  stopHits: number;
  timeouts: number;
  winRatePercent: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  expectancyCi95: ConfidenceInterval | null;
  firstSignalAt?: string;
  lastResolvedAt?: string;
}

export interface SignalDeskResult {
  status: 'ready' | 'unavailable';
  symbol: string;
  timeframe: '1d';
  asOf?: string;
  source: 'live' | 'unavailable';
  evaluation: SignalCoreEvaluation | null;
  historical: HistoricalValidationSummary | null;
  forward: ForwardRecordSummary | null;
  /**
   * The single BUY / WAIT / SELL conclusion every user-facing surface should
   * read, with the evidence that explains it. `evaluation` remains the raw
   * deterministic output for the harness, the journal and the replay; a surface
   * that renders both is showing the user two scales to reconcile.
   */
  unified: UnifiedSignalSummary | null;
  warnings: string[];
}
