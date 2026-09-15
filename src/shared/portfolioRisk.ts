// Portfolio risk from realised daily returns.
//
// Three decisions shape this module:
//
//   * **Date intersection, never forward-fill.** A symbol that did not trade on
//     a date is excluded from that date, not carried at its last price.
//     Forward-filling manufactures zero returns, which drags measured
//     volatility and correlation toward zero — i.e. it makes the portfolio look
//     safer than it is.
//   * **No normality assumption for VaR/CVaR.** Both are empirical: the 5th
//     percentile of the realised return distribution and the mean of the tail
//     at or below it. A parametric VaR on financial returns understates the
//     tail, which is the one number nobody should understate.
//   * **Explicit unavailability.** Insufficient overlap produces nulls plus a
//     warning naming the excluded symbols, never a confident-looking zero.

import type { Candle } from './types';
import type { PortfolioPosition } from './portfolio';

export interface PositionRiskContribution {
  symbol: string;
  weightPercent: number;
  annualizedVolatilityPercent: number | null;
  betaToSpy: number | null;
  marginalRiskContribution: number | null;
  componentRiskPercent: number | null;
}

export interface PortfolioRiskReport {
  asOf: string;
  lookbackTradingDays: number;
  annualizedVolatilityPercent: number | null;
  betaToSpy: number | null;
  maxDrawdownPercent: number | null;
  oneDayVaR95Percent: number | null;
  oneDayCVaR95Percent: number | null;
  diversificationRatio: number | null;
  contributions: PositionRiskContribution[];
  warnings: string[];
}

export const DEFAULT_RISK_LOOKBACK_DAYS = 252;
export const MINIMUM_RISK_OVERLAP_DAYS = 60;
const TRADING_DAYS_PER_YEAR = 252;
/** Above this share of non-cash value excluded, the report is `partial`. */
const MAX_EXCLUDED_VALUE_FRACTION = 0.2;

export interface PortfolioRiskInput {
  positions: PortfolioPosition[];
  /** Daily candles per symbol. Raw closes are acceptable; the limitation is
   *  recorded in `warnings`. */
  historyBySymbol: Record<string, Candle[]>;
  benchmark: Candle[];
  benchmarkSymbol?: string;
  totalCash?: number;
  lookbackTradingDays?: number;
  /** True when the supplied histories are split/dividend adjusted. */
  adjusted?: boolean;
  asOf?: string;
}

/** Bar-over-bar simple returns keyed by UTC day, so two series can be
 *  intersected by date rather than by array position. */
function returnsByDay(candles: Candle[]): Map<number, number> {
  const usable = candles
    .filter((candle) => Number.isFinite(candle.close) && candle.close > 0 && Number.isFinite(candle.time))
    .sort((a, b) => a.time - b.time);
  const out = new Map<number, number>();
  for (let i = 1; i < usable.length; i++) {
    const previous = usable[i - 1].close;
    const current = usable[i].close;
    if (previous <= 0) continue;
    out.set(Math.floor(usable[i].time / 86_400), current / previous - 1);
  }
  return out;
}

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample (n−1) variance: these are samples of a process, not a population. */
function variance(values: number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
}

function covariance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const meanA = mean(a.slice(0, n));
  const meanB = mean(b.slice(0, n));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - meanA) * (b[i] - meanB);
  return sum / (n - 1);
}

/** Empirical quantile with linear interpolation, on an ascending sample. */
function quantile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const index = (sorted.length - 1) * Math.min(1, Math.max(0, p));
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Largest peak-to-trough decline of the compounded return path, as a positive
 *  percentage. */
export function maxDrawdownPercent(returns: number[]): number | null {
  if (returns.length < 2) return null;
  let equity = 1;
  let peak = 1;
  let worst = 0;
  for (const value of returns) {
    equity *= 1 + value;
    if (equity > peak) peak = equity;
    if (peak > 0) worst = Math.max(worst, (peak - equity) / peak);
  }
  return worst * 100;
}

function emptyReport(
  asOf: string,
  lookback: number,
  warnings: string[],
): PortfolioRiskReport {
  return {
    asOf,
    lookbackTradingDays: lookback,
    annualizedVolatilityPercent: null,
    betaToSpy: null,
    maxDrawdownPercent: null,
    oneDayVaR95Percent: null,
    oneDayCVaR95Percent: null,
    diversificationRatio: null,
    contributions: [],
    warnings,
  };
}

/**
 * Computes the risk report.
 *
 * Cash is carried as a zero-volatility, zero-return sleeve rather than removed:
 * holding 50% cash genuinely halves portfolio volatility, and renormalising the
 * risky weights to 100% would hide that.
 */
export function calculatePortfolioRisk(input: PortfolioRiskInput): PortfolioRiskReport {
  const asOf = input.asOf ?? new Date().toISOString();
  const lookback = input.lookbackTradingDays ?? DEFAULT_RISK_LOOKBACK_DAYS;
  const benchmarkSymbol = input.benchmarkSymbol ?? 'SPY';
  const warnings: string[] = [];
  const cash = Math.max(0, input.totalCash ?? 0);

  if (input.adjusted === false) {
    warnings.push(
      'Risk is computed from raw closes, so splits and dividends are not adjusted for.',
    );
  }

  const priced = input.positions.filter(
    (position) => position.marketValue !== null && (position.marketValue ?? 0) > 0,
  );
  const nonCashValue = priced.reduce((sum, position) => sum + (position.marketValue ?? 0), 0);

  if (!priced.length) {
    if (cash > 0) {
      // An all-cash portfolio has zero measured risk, and that is a real
      // answer rather than missing data.
      return {
        ...emptyReport(asOf, lookback, warnings),
        annualizedVolatilityPercent: 0,
        betaToSpy: 0,
        maxDrawdownPercent: 0,
        oneDayVaR95Percent: 0,
        oneDayCVaR95Percent: 0,
        diversificationRatio: null,
        contributions: [],
      };
    }
    warnings.push('No priced positions, so portfolio risk cannot be measured.');
    return emptyReport(asOf, lookback, warnings);
  }

  const benchmarkReturns = returnsByDay(input.benchmark);

  // Per-symbol returns, then the intersection of dates every included symbol
  // actually traded on.
  const seriesBySymbol = new Map<string, Map<number, number>>();
  const excluded: string[] = [];
  for (const position of priced) {
    const history = input.historyBySymbol[position.symbol] ?? [];
    const series = returnsByDay(history);
    if (series.size < MINIMUM_RISK_OVERLAP_DAYS) {
      excluded.push(position.symbol);
      continue;
    }
    seriesBySymbol.set(position.symbol, series);
  }

  if (!seriesBySymbol.size) {
    warnings.push(
      `No symbol has at least ${MINIMUM_RISK_OVERLAP_DAYS} daily returns, so risk is unavailable.`,
    );
    if (excluded.length) {
      warnings.push(`Excluded for insufficient history: ${excluded.join(', ')}.`);
    }
    return emptyReport(asOf, lookback, warnings);
  }

  const included = [...seriesBySymbol.keys()];
  let commonDays: number[] = [...(seriesBySymbol.get(included[0]) as Map<number, number>).keys()];
  for (const symbol of included.slice(1)) {
    const series = seriesBySymbol.get(symbol) as Map<number, number>;
    commonDays = commonDays.filter((day) => series.has(day));
  }
  commonDays.sort((a, b) => a - b);
  const days = commonDays.slice(-lookback);

  if (days.length < MINIMUM_RISK_OVERLAP_DAYS) {
    warnings.push(
      `Only ${days.length} overlapping trading days across positions; ${MINIMUM_RISK_OVERLAP_DAYS} are required.`,
    );
    if (excluded.length) {
      warnings.push(`Excluded for insufficient history: ${excluded.join(', ')}.`);
    }
    return emptyReport(asOf, lookback, warnings);
  }

  const includedValue = included.reduce((sum, symbol) => {
    const position = priced.find((item) => item.symbol === symbol);
    return sum + (position?.marketValue ?? 0);
  }, 0);
  const excludedValue = nonCashValue - includedValue;

  if (excluded.length) {
    warnings.push(`Excluded for insufficient history: ${excluded.join(', ')}.`);
  }
  if (nonCashValue > 0 && excludedValue / nonCashValue > MAX_EXCLUDED_VALUE_FRACTION) {
    warnings.push(
      `Positions without usable history are ${((excludedValue / nonCashValue) * 100).toFixed(1)}% of non-cash value, so this report is partial.`,
    );
  }

  // Weights against total value including cash, so the cash sleeve dilutes risk
  // exactly as it does in reality.
  const totalValue = nonCashValue + cash;
  const weights = included.map((symbol) => {
    const position = priced.find((item) => item.symbol === symbol);
    return totalValue > 0 ? (position?.marketValue ?? 0) / totalValue : 0;
  });

  const returnMatrix = included.map((symbol) => {
    const series = seriesBySymbol.get(symbol) as Map<number, number>;
    return days.map((day) => series.get(day) ?? 0);
  });

  // Covariance matrix over the intersected dates.
  const size = included.length;
  const covMatrix: number[][] = Array.from({ length: size }, () => new Array(size).fill(0));
  for (let i = 0; i < size; i++) {
    for (let j = i; j < size; j++) {
      const value = i === j ? variance(returnMatrix[i]) : covariance(returnMatrix[i], returnMatrix[j]);
      covMatrix[i][j] = value;
      covMatrix[j][i] = value;
    }
  }

  // portfolio variance = wᵀ Σ w
  const sigmaW = covMatrix.map((row) => row.reduce((sum, value, j) => sum + value * weights[j], 0));
  const portfolioVariance = weights.reduce((sum, weight, i) => sum + weight * sigmaW[i], 0);
  const dailyVolatility = portfolioVariance > 0 ? Math.sqrt(portfolioVariance) : 0;
  const annualizedVolatilityPercent = dailyVolatility * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100;

  // Portfolio return path over the intersected dates, used for beta, drawdown,
  // VaR and CVaR — all from the same realised series, so they are consistent.
  const portfolioReturns = days.map((_, dayIndex) =>
    weights.reduce((sum, weight, i) => sum + weight * returnMatrix[i][dayIndex], 0),
  );

  // Benchmark alignment is by date, like everything else here: comparing by
  // array position would silently pair different days whenever one series is
  // missing a bar.
  const betaDayIndices: number[] = [];
  for (let d = 0; d < days.length; d++) {
    if (typeof benchmarkReturns.get(days[d]) === 'number') betaDayIndices.push(d);
  }
  let betaToSpy: number | null = null;
  if (betaDayIndices.length >= MINIMUM_RISK_OVERLAP_DAYS) {
    const benchmarkSeries = betaDayIndices.map((d) => benchmarkReturns.get(days[d]) as number);
    const benchmarkVariance = variance(benchmarkSeries);
    betaToSpy =
      benchmarkVariance > 0
        ? covariance(betaDayIndices.map((d) => portfolioReturns[d]), benchmarkSeries) /
          benchmarkVariance
        : null;
    if (betaToSpy === null) {
      warnings.push(`${benchmarkSymbol} returns have no variance over this window.`);
    }
  } else {
    warnings.push(
      `Fewer than ${MINIMUM_RISK_OVERLAP_DAYS} overlapping ${benchmarkSymbol} returns, so beta is unavailable.`,
    );
  }

  // Empirical VaR/CVaR, reported as positive loss magnitudes.
  const sortedReturns = [...portfolioReturns].sort((a, b) => a - b);
  const varQuantile = quantile(sortedReturns, 0.05);
  const oneDayVaR95Percent = Math.max(0, -varQuantile) * 100;
  const tail = sortedReturns.filter((value) => value <= varQuantile);
  const oneDayCVaR95Percent =
    tail.length > 0 ? Math.max(0, -mean(tail)) * 100 : oneDayVaR95Percent;

  // Diversification ratio: weighted average standalone volatility over
  // portfolio volatility. Above 1 means correlation is doing work.
  const standaloneVolatility = returnMatrix.map((series) => Math.sqrt(Math.max(0, variance(series))));
  const weightedStandalone = weights.reduce(
    (sum, weight, i) => sum + weight * standaloneVolatility[i],
    0,
  );
  const diversificationRatio =
    dailyVolatility > 0 ? weightedStandalone / dailyVolatility : null;

  // Which of the intersected days also have a benchmark return. Computed once:
  // doing it per contribution meant an indexOf lookup inside a map, which is
  // quadratic in the lookback.
  const benchmarkDayIndices: number[] = [];
  for (let d = 0; d < days.length; d++) {
    if (typeof benchmarkReturns.get(days[d]) === 'number') benchmarkDayIndices.push(d);
  }
  const benchmarkAlignedReturns = benchmarkDayIndices.map(
    (d) => benchmarkReturns.get(days[d]) as number,
  );
  const benchmarkAlignedVariance = variance(benchmarkAlignedReturns);

  // Component contributions sum to the portfolio volatility by construction:
  //   sum_i w_i * (Σw)_i / σ  =  wᵀΣw / σ  =  σ² / σ  =  σ
  // so each component over σ is its share of total risk.
  const contributions: PositionRiskContribution[] = included.map((symbol, i) => {
    const marginal = dailyVolatility > 0 ? sigmaW[i] / dailyVolatility : null;
    const component = marginal === null ? null : weights[i] * marginal;
    return {
      symbol,
      weightPercent: weights[i] * 100,
      annualizedVolatilityPercent:
        standaloneVolatility[i] > 0
          ? standaloneVolatility[i] * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100
          : 0,
      betaToSpy:
        benchmarkDayIndices.length >= MINIMUM_RISK_OVERLAP_DAYS && benchmarkAlignedVariance > 0
          ? covariance(
              benchmarkDayIndices.map((d) => returnMatrix[i][d]),
              benchmarkAlignedReturns,
            ) / benchmarkAlignedVariance
          : null,
      marginalRiskContribution: marginal,
      componentRiskPercent:
        component === null || dailyVolatility <= 0 ? null : (component / dailyVolatility) * 100,
    };
  });

  return {
    asOf,
    lookbackTradingDays: days.length,
    annualizedVolatilityPercent,
    betaToSpy,
    maxDrawdownPercent: maxDrawdownPercent(portfolioReturns),
    oneDayVaR95Percent,
    oneDayCVaR95Percent,
    diversificationRatio,
    contributions,
    warnings,
  };
}
