// The QRM Research Lab.
//
// Every label here says experimental, because that is what QRM is in 3.0 until
// the promotion gates pass. The page shows the sampled distribution even when
// the decision layer declines — a distribution and a decision are different
// objects, and hiding the first because the second said wait would remove the
// research value.

import React, { useCallback, useEffect, useState } from 'react';
import type { QrmForecastSnapshot, QrmHorizonDistribution } from '../../../shared/qrm';
import type { QrmProgressEvent } from '../../../shared/types';
import {
  QRM_BAND_LABEL,
  QRM_MEDIAN_LABEL,
  qrmCoverageLabel,
} from '../../../shared/qrmForecast';
import { QRM_DECISION_RESEARCH_V1, decideQrm } from '../../../shared/qrmDecision';
import { api } from '../../api';

interface ResearchLabPageProps {
  initialSymbol?: string;
}

function percent(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(digits)}%`;
}

function plain(value: number | null | undefined, digits = 2): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

function DistributionRow({
  distribution,
}: {
  distribution: QrmHorizonDistribution;
}): React.ReactElement {
  const decision = decideQrm(distribution);
  return (
    <tr>
      <th scope="row">{distribution.horizon}d</th>
      <td className="num">{percent(distribution.terminalReturn.p50)}</td>
      <td className="num">
        {percent(distribution.terminalReturn.p10)} … {percent(distribution.terminalReturn.p90)}
      </td>
      <td className="num">{percent(distribution.probabilityPositive, 0)}</td>
      <td className="num">{percent(distribution.mfe.p50)}</td>
      <td className="num">{percent(distribution.mae.p50)}</td>
      <td className="num">
        {distribution.probabilityLoss5PercentBeforeGain5Percent === null
          ? '—'
          : percent(distribution.probabilityLoss5PercentBeforeGain5Percent, 0)}
      </td>
      <td>
        <span className="lab-decision">{decision.decision}</span>
        {decision.reasons.length ? (
          <ul className="lab-refusals">
            {decision.reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : null}
      </td>
    </tr>
  );
}

export function ResearchLabPage({ initialSymbol = 'SPY' }: ResearchLabPageProps): React.ReactElement {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [mode, setMode] = useState<'research' | 'lab'>('research');
  const [snapshot, setSnapshot] = useState<QrmForecastSnapshot | null>(null);
  const [reason, setReason] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [progress, setProgress] = useState<QrmProgressEvent | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    const unsubscribe = api.onQrmProgress((event) => setProgress(event));
    return unsubscribe;
  }, []);

  const run = useCallback(async () => {
    setRunning(true);
    setReason(null);
    setProgress(null);
    try {
      const response = await api.runQrm({ symbol: symbol.trim().toUpperCase(), mode });
      setSnapshot(response.snapshot);
      setWarnings(response.warnings);
      setReason(response.reason ?? null);
    } catch (error) {
      setReason(error instanceof Error ? error.message : 'The QRM run failed.');
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [symbol, mode]);

  const diagnostics = snapshot?.diagnostics;

  return (
    <div className="lab-page">
      <header className="lab-head">
        <div>
          <h2>Research Lab</h2>
          <p className="lab-subtitle">
            QRM-3 is experimental. It is not an authoritative Quant decision, and it is not
            merged with Signal Engine V2 or Kronos.
          </p>
        </div>
        <div className="lab-actions">
          <label>
            <span>Symbol</span>
            <input
              value={symbol}
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              spellCheck={false}
            />
          </label>
          <label>
            <span>Precision</span>
            <select value={mode} onChange={(event) => setMode(event.target.value as 'research' | 'lab')}>
              <option value="research">Standard</option>
              <option value="lab">High precision</option>
            </select>
          </label>
          <button type="button" className="lab-primary" onClick={() => void run()} disabled={running}>
            {running ? 'Running…' : 'Run QRM'}
          </button>
        </div>
      </header>

      {progress ? (
        <p className="lab-progress" aria-live="polite">
          {progress.symbol}: {progress.completed} / {progress.total} paths
        </p>
      ) : null}

      {reason ? (
        <p className="lab-reason" role="status">
          {reason}
        </p>
      ) : null}

      {warnings.length ? (
        <ul className="lab-warnings" role="status">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}

      {snapshot ? (
        <>
          <section aria-label="Sampled distribution">
            <h3>Sampled forward distribution</h3>
            <p className="lab-note">
              {QRM_MEDIAN_LABEL} and {QRM_BAND_LABEL}.{' '}
              {qrmCoverageLabel(null)}. Sampled quantiles are shown as generated; they are never
              narrowed for presentation.
            </p>
            <div className="lab-table-wrap">
              <table className="lab-table">
                <thead>
                  <tr>
                    <th scope="col">Horizon</th>
                    <th scope="col" className="num">Median</th>
                    <th scope="col" className="num">P10–P90</th>
                    <th scope="col" className="num">Share positive</th>
                    <th scope="col" className="num">Median MFE</th>
                    <th scope="col" className="num">Median MAE</th>
                    <th scope="col" className="num">−5% first</th>
                    <th scope="col">Experimental decision</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.distributions.map((distribution) => (
                    <DistributionRow key={distribution.horizon} distribution={distribution} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section aria-label="Diagnostics">
            <h3>Diagnostics</h3>
            <dl className="lab-rows">
              <div className="lab-row">
                <dt>Eligible analogues</dt>
                <dd>{diagnostics?.analogueCount.toLocaleString() ?? '—'}</dd>
              </div>
              <div className="lab-row">
                <dt>Effective sample size</dt>
                <dd>{plain(diagnostics?.effectiveSampleSize, 1)}</dd>
              </div>
              <div className="lab-row">
                <dt>Kernel temperature</dt>
                <dd>{plain(diagnostics?.kernelTemperature, 4)}</dd>
              </div>
              <div className="lab-row">
                <dt>Nearest / median distance</dt>
                <dd>
                  {plain(diagnostics?.nearestDistance, 3)} / {plain(diagnostics?.medianDistance, 3)}
                </dd>
              </div>
              <div className="lab-row">
                <dt>Same-regime analogues</dt>
                <dd>{plain(diagnostics?.regimeMatchPercent, 0)}%</dd>
              </div>
              <div className="lab-row">
                <dt>Data cutoff</dt>
                <dd>
                  {diagnostics
                    ? new Date(diagnostics.dataCutoffTime * 1000).toLocaleDateString()
                    : '—'}
                </dd>
              </div>
              <div className="lab-row">
                <dt>Compute time</dt>
                <dd>{diagnostics ? `${diagnostics.computationMs} ms` : '—'}</dd>
              </div>
              <div className="lab-row">
                <dt>Paths</dt>
                <dd>{snapshot.config.paths.toLocaleString()}</dd>
              </div>
              <div className="lab-row">
                <dt>Model / seed</dt>
                <dd>
                  {snapshot.config.modelVersion} / {snapshot.config.seed}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-label="Decision thresholds">
            <h3>Decision thresholds</h3>
            <p className="lab-note">
              Research values from <code>{QRM_DECISION_RESEARCH_V1.configVersion}</code>. Lab
              benchmarks decide whether they survive; they are not production constants.
            </p>
            <dl className="lab-rows">
              <div className="lab-row">
                <dt>Min signal to noise</dt>
                <dd>{QRM_DECISION_RESEARCH_V1.minimumSignalToNoise}</dd>
              </div>
              <div className="lab-row">
                <dt>Min directional probability</dt>
                <dd>{QRM_DECISION_RESEARCH_V1.minimumDirectionalProbability}</dd>
              </div>
              <div className="lab-row">
                <dt>Min reward to risk</dt>
                <dd>{QRM_DECISION_RESEARCH_V1.minimumRewardToRisk}</dd>
              </div>
            </dl>
          </section>
        </>
      ) : (
        <p className="dc-empty">
          Run QRM for a symbol with at least three years of daily history.
        </p>
      )}
    </div>
  );
}
