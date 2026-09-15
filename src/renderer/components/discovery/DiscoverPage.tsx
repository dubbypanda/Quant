// The Discover page: what is statistically or structurally interesting now.
//
// A scan is explicitly requested, never triggered on mount: it walks the
// hydrated universe and runs the signal core over hundreds of symbols, which is
// not something to do because a tab was opened.

import React, { useState } from 'react';
import type { DiscoveryEligibilitySettings } from '../../../shared/discovery';
import {
  DEFAULT_ELIGIBILITY_SETTINGS,
  DISCOVERY_OUTPUT_LABEL,
} from '../../../shared/discovery';
import { useDiscovery } from './useDiscovery';
import { DiscoveryCoverageBar } from './DiscoveryCoverageBar';
import { CandidateTable } from './CandidateTable';
import { DiscoveryFilters } from './DiscoveryFilters';

interface DiscoverPageProps {
  onOpenSymbol: (symbol: string) => void;
}

type AssetFilter = 'all' | 'stock' | 'etf';

export function DiscoverPage({ onOpenSymbol }: DiscoverPageProps): React.ReactElement {
  const discovery = useDiscovery();
  const [settings, setSettings] = useState<DiscoveryEligibilitySettings>(
    DEFAULT_ELIGIBILITY_SETTINGS,
  );
  const [assetFilter, setAssetFilter] = useState<AssetFilter>('all');

  const candidates = (discovery.result?.candidates ?? []).filter((candidate) =>
    assetFilter === 'all' ? true : candidate.assetType === assetFilter,
  );

  return (
    <div className="dc-page">
      <header className="dc-page-head">
        <div>
          <h2>Discover</h2>
          <p className="dc-subtitle">
            {DISCOVERY_OUTPUT_LABEL}s ranked by what changed, not by conviction.
          </p>
        </div>
        <div className="dc-actions">
          <div className="dc-segment" role="group" aria-label="Instrument type">
            {(['all', 'stock', 'etf'] as AssetFilter[]).map((option) => (
              <button
                key={option}
                type="button"
                className={`dc-segment-item${assetFilter === option ? ' is-active' : ''}`}
                aria-pressed={assetFilter === option}
                onClick={() => setAssetFilter(option)}
              >
                {option === 'all' ? 'All' : option === 'stock' ? 'Stocks' : 'ETFs'}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="dc-primary"
            onClick={() => void discovery.run(settings)}
            disabled={discovery.running}
          >
            {discovery.running ? 'Scanning…' : 'Run scan'}
          </button>
        </div>
      </header>

      <DiscoveryFilters
        settings={settings}
        onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
        disabled={discovery.running}
      />

      <DiscoveryCoverageBar
        coverage={discovery.result?.coverage ?? null}
        hydration={discovery.hydration}
        onStartHydration={() => void discovery.startHydration()}
        onStopHydration={() => void discovery.stopHydration()}
      />

      {discovery.error ? (
        <p className="dc-error" role="status">
          {discovery.error}
        </p>
      ) : null}

      {discovery.loading ? (
        <p className="dc-empty">Loading…</p>
      ) : (
        <>
          {discovery.result ? (
            <p className="dc-note">
              {discovery.result.preliminaryCount.toLocaleString()} preliminary candidates,{' '}
              {discovery.result.deepCount} deep-analysed. Scan completed{' '}
              {new Date(discovery.result.completedAt).toLocaleString()}.
            </p>
          ) : null}
          <CandidateTable candidates={candidates} onOpenSymbol={onOpenSymbol} />
        </>
      )}
    </div>
  );
}
