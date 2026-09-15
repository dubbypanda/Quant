// QRM worker thread.
//
// Node `worker_threads` rather than Python: QRM 3.0 is pure numeric TypeScript
// and adding a Python dependency for it would drag the whole forecast-engine
// setup burden into a feature that does not need it.
//
// One job per message, isolated. A crash here fails that job and the pool
// replaces the worker; it never takes the app down.

import { parentPort } from 'node:worker_threads';
import type { Candle } from '../../shared/types';
import type { QrmConfig } from '../../shared/qrm';
import { buildQrmForecast } from '../../shared/qrmForecast';

export interface QrmWorkerJob {
  jobId: string;
  symbol: string;
  candles: Candle[];
  spyCandles: Candle[];
  config: Partial<QrmConfig>;
  minimumHistoryBars?: number;
  analogueStride?: number;
}

export type QrmWorkerMessage =
  | { type: 'job'; job: QrmWorkerJob }
  | { type: 'cancel'; jobId: string };

export type QrmWorkerResponse =
  | { type: 'progress'; jobId: string; completed: number; total: number }
  | { type: 'result'; jobId: string; result: ReturnType<typeof buildQrmForecast> }
  | { type: 'error'; jobId: string; message: string };

const cancelled = new Set<string>();

parentPort?.on('message', (message: QrmWorkerMessage) => {
  if (message.type === 'cancel') {
    cancelled.add(message.jobId);
    return;
  }
  if (message.type !== 'job') return;

  const { job } = message;
  try {
    const result = buildQrmForecast({
      symbol: job.symbol,
      candles: job.candles,
      spyCandles: job.spyCandles,
      config: job.config,
      minimumHistoryBars: job.minimumHistoryBars,
      analogueStride: job.analogueStride,
      // Checked between path batches by the simulator.
      isCancelled: () => cancelled.has(job.jobId),
      onProgress: (completed, total) => {
        parentPort?.postMessage({
          type: 'progress',
          jobId: job.jobId,
          completed,
          total,
        } satisfies QrmWorkerResponse);
      },
    });
    cancelled.delete(job.jobId);
    // The result is posted only after the assembler validated it.
    parentPort?.postMessage({ type: 'result', jobId: job.jobId, result } satisfies QrmWorkerResponse);
  } catch (error) {
    cancelled.delete(job.jobId);
    parentPort?.postMessage({
      type: 'error',
      jobId: job.jobId,
      message: error instanceof Error ? error.message : 'The QRM job failed.',
    } satisfies QrmWorkerResponse);
  }
});
