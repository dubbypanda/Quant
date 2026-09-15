// Portfolio data hooks. Writes go through the main process, which re-validates
// everything — renderer validation here is usability only.

import { useCallback, useEffect, useState } from 'react';
import type {
  PortfolioAccountType,
  PortfolioActionContext,
  PortfolioDocumentV3,
  PortfolioSnapshot,
  SymbolPortfolioContext,
} from '../../../shared/portfolio';
import type { PortfolioRiskReport } from '../../../shared/portfolioRisk';
import type { PortfolioExposureReport } from '../../../shared/portfolioExposure';
import { api } from '../../api';

export interface PortfolioState {
  document: PortfolioDocumentV3 | null;
  snapshot: PortfolioSnapshot | null;
  risk: PortfolioRiskReport | null;
  exposure: PortfolioExposureReport | null;
  loading: boolean;
  error: string | null;
}

export interface PortfolioActions {
  refresh: () => Promise<void>;
  addAccount: (name: string, type: PortfolioAccountType) => Promise<string[] | null>;
  addLot: (input: {
    symbol: string;
    quantity: number;
    costPerShare: number;
    accountId: string;
    acquiredAt?: string | null;
    note?: string;
  }) => Promise<string[] | null>;
  updateLot: (
    id: string,
    patch: Partial<{ quantity: number; costPerShare: number; acquiredAt: string | null; accountId: string; note: string }>,
  ) => Promise<string[] | null>;
  removeLot: (id: string) => Promise<string[] | null>;
  setCash: (accountId: string, amount: number) => Promise<string[] | null>;
  importCsv: (text: string, accountId: string) => Promise<string[] | null>;
}

export function usePortfolio(): PortfolioState & PortfolioActions {
  const [state, setState] = useState<PortfolioState>({
    document: null,
    snapshot: null,
    risk: null,
    exposure: null,
    loading: true,
    error: null,
  });

  const refresh = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      // The document and snapshot paint the page; risk and exposure are
      // heavier and must not block it, so they settle independently.
      const [document, snapshot] = await Promise.all([
        api.getPortfolio(),
        api.getPortfolioSnapshot(),
      ]);
      setState((current) => ({ ...current, document, snapshot, loading: false }));
      const [risk, exposure] = await Promise.all([
        api.getPortfolioRisk().catch(() => null),
        api.getPortfolioExposure().catch(() => null),
      ]);
      setState((current) => ({ ...current, risk, exposure }));
    } catch (error) {
      setState((current) => ({
        ...current,
        loading: false,
        error: error instanceof Error ? error.message : 'The portfolio could not be loaded.',
      }));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** Returns the main process's validation errors, or null on success. */
  const write = useCallback(
    async (run: () => Promise<{ ok: boolean; errors?: string[] }>): Promise<string[] | null> => {
      const result = await run();
      if (!result.ok) return result.errors ?? ['The portfolio update was rejected.'];
      await refresh();
      return null;
    },
    [refresh],
  );

  return {
    ...state,
    refresh,
    addAccount: (name, type) => write(() => api.addPortfolioAccount({ name, type })),
    addLot: (input) => write(() => api.addPortfolioLot(input)),
    updateLot: (id, patch) => write(() => api.updatePortfolioLot(id, patch)),
    removeLot: (id) => write(() => api.removePortfolioLot(id)),
    setCash: (accountId, amount) => write(() => api.setPortfolioCash(accountId, amount)),
    importCsv: (text, accountId) => write(() => api.importPortfolioCsv(text, accountId)),
  };
}

export interface SymbolPortfolioState {
  context: SymbolPortfolioContext | null;
  action: PortfolioActionContext | null;
  loading: boolean;
}

/** Portfolio context for one symbol, for the chart's Position tab. Kept in its
 *  own hook so `ChartStage` never reaches into the portfolio store. */
export function useSymbolPortfolioContext(symbol: string): SymbolPortfolioState {
  const [state, setState] = useState<SymbolPortfolioState>({
    context: null,
    action: null,
    loading: true,
  });

  useEffect(() => {
    if (!symbol) {
      setState({ context: null, action: null, loading: false });
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    api
      .getSymbolPortfolioContext(symbol)
      .then((result) => {
        if (cancelled) return;
        setState({ context: result.context, action: result.action, loading: false });
      })
      .catch(() => {
        if (!cancelled) setState({ context: null, action: null, loading: false });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return state;
}
