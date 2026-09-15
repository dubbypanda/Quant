// The coverage funnel.
//
// This component exists because of the 2.1 behaviour it replaces: a scan of the
// first 120 directory rows described as "US stocks". Every stage of the funnel
// is shown with its count, and the universe is labelled "Quant U.S. universe"
// so no reading of this bar implies full-market coverage that did not happen.

import React from 'react';
import type { UniverseCoverage, UniverseHydrationStatus } from '../../../shared/discovery';
import { UNIVERSE_LABEL } from '../../../shared/discovery';

interface DiscoveryCoverageBarProps {
  coverage: UniverseCoverage | null;
  hydration: UniverseHydrationStatus | null;
  onStartHydration: () => void;
  onStopHydration: () => void;
}

export function DiscoveryCoverageBar({
  coverage,
  hydration,
  onStartHydration,
  onStopHydration,
}: DiscoveryCoverageBarProps): React.ReactElement {
  const stages = coverage
    ? [
        { label: UNIVERSE_LABEL, value: coverage.universeCount },
        { label: 'Hydrated', value: coverage.hydratedCount },
        { label: 'Scanned', value: coverage.scannedCount },
        { label: 'Eligible', value: coverage.eligibleCount },
        { label: 'Current session', value: coverage.currentSessionCount },
        { label: 'Stale', value: coverage.staleCount },
        { label: 'Failed', value: coverage.failedCount },
      ]
    : [];

  const hydrationPercent =
    hydration && hydration.total > 0
      ? Math.min(100, (hydration.complete / hydration.total) * 100)
      : 0;

  return (
    <section className="dc-coverage" aria-label="Scan coverage">
      {coverage ? (
        <>
          <ul className="dc-funnel">
            {stages.map((stage) => (
              <li key={stage.label}>
                <span className="dc-funnel-value">{stage.value.toLocaleString()}</span>
                <span className="dc-funnel-label">{stage.label}</span>
              </li>
            ))}
          </ul>
          <p className="dc-note">
            As of {new Date(coverage.asOf).toLocaleString()}. Counts describe what this scan
            actually covered.
          </p>
        </>
      ) : (
        <p className="dc-note">No scan has completed yet.</p>
      )}

      <div className="dc-hydration">
        <span className="dc-hydration-label">
          History cache{' '}
          {hydration
            ? `${hydration.complete.toLocaleString()} / ${hydration.total.toLocaleString()}`
            : '—'}
          {hydration?.failed ? ` · ${hydration.failed} failed` : ''}
        </span>
        <span className="dc-hydration-track" aria-hidden="true">
          <span className="dc-hydration-fill" style={{ width: `${hydrationPercent}%` }} />
        </span>
        {hydration?.running ? (
          <button type="button" onClick={onStopHydration}>
            Pause caching
          </button>
        ) : (
          <button type="button" onClick={onStartHydration}>
            Resume caching
          </button>
        )}
      </div>
      {hydration?.running && hydration.current.length ? (
        <p className="dc-note" aria-live="polite">
          Caching {hydration.current.join(', ')}…
        </p>
      ) : null}
    </section>
  );
}
