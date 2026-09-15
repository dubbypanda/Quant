// Today: of what changed, what deserves attention first given what I own.
//
// Deliberately not a re-sorted copy of Discover. Discover answers "what is
// interesting"; Today answers "what should I look at, and why me". The grouping
// and the deduplication are what make that a different question rather than the
// same table with a different order.

import React, { useMemo } from 'react';
import type { DiscoveryCandidate } from '../../../shared/discovery';
import { DISCOVERY_FUNNEL } from '../../../shared/discovery';
import { useDiscovery } from './useDiscovery';
import { usePortfolio } from '../portfolio/usePortfolio';
import { TodaySection, type TodayItem } from './TodaySection';

interface TodayPageProps {
  onOpenSymbol: (symbol: string) => void;
}

const GROUPS = {
  portfolio: 'YOUR PORTFOLIO',
  opportunities: 'NEW OPPORTUNITIES',
  regime: 'REGIME CHANGES',
  unusual: 'UNUSUAL MOVES',
} as const;

type GroupKey = keyof typeof GROUPS;

/** Group membership tests, in priority order. A symbol's primary group is the
 *  first it matches; the rest become chips. */
function groupsFor(candidate: DiscoveryCandidate, ownedSymbols: Set<string>): GroupKey[] {
  const groups: GroupKey[] = [];
  if (ownedSymbols.has(candidate.symbol)) groups.push('portfolio');
  if (
    candidate.decision === 'buy-candidate' ||
    candidate.decision === 'short-candidate'
  ) {
    groups.push('opportunities');
  }
  if (
    candidate.features.priorRegime !== null &&
    candidate.features.priorRegime !== candidate.features.regime
  ) {
    groups.push('regime');
  }
  if (
    (candidate.features.returnZ20 !== null && Math.abs(candidate.features.returnZ20) >= 2) ||
    (candidate.features.volumeZ60 !== null && candidate.features.volumeZ60 >= 2)
  ) {
    groups.push('unusual');
  }
  return groups;
}

export function TodayPage({ onOpenSymbol }: TodayPageProps): React.ReactElement {
  const discovery = useDiscovery();
  const portfolio = usePortfolio();

  const ownedSymbols = useMemo(
    () => new Set((portfolio.document?.lots ?? []).map((lot) => lot.symbol.toUpperCase())),
    [portfolio.document],
  );

  const sections = useMemo(() => {
    const candidates = [...(discovery.result?.candidates ?? [])].sort(
      (a, b) => b.attentionScore - a.attentionScore,
    );
    const assigned: Record<GroupKey, TodayItem[]> = {
      portfolio: [],
      opportunities: [],
      regime: [],
      unusual: [],
    };
    const claimed = new Set<string>();

    for (const candidate of candidates) {
      const groups = groupsFor(candidate, ownedSymbols);
      if (!groups.length) continue;
      // One primary card per symbol across the whole page.
      if (claimed.has(candidate.symbol)) continue;
      claimed.add(candidate.symbol);
      const [primary, ...secondary] = groups;
      assigned[primary].push({
        candidate,
        secondaryGroups: secondary.map((group) => GROUPS[group]),
      });
    }

    // A shortlist, not the whole table.
    const ceiling = DISCOVERY_FUNNEL.todayCeiling;
    let budget = ceiling;
    for (const key of Object.keys(assigned) as GroupKey[]) {
      const take = Math.max(0, Math.min(assigned[key].length, budget));
      assigned[key] = assigned[key].slice(0, take);
      budget -= take;
    }
    return assigned;
  }, [discovery.result, ownedSymbols]);

  const total = Object.values(sections).reduce((sum, items) => sum + items.length, 0);

  return (
    <div className="td-page">
      <header className="td-page-head">
        <h2>Today</h2>
        <p className="td-subtitle">
          What changed since the previous scan, ordered by what matters to your positions.
        </p>
      </header>

      {discovery.loading ? <p className="dc-empty">Loading…</p> : null}

      {!discovery.loading && !discovery.result ? (
        <p className="dc-empty">
          No scan has completed yet. Run a scan from Discover to populate Today.
        </p>
      ) : null}

      {discovery.result && total === 0 ? (
        <p className="dc-empty">
          Nothing changed enough to flag since the previous scan.
        </p>
      ) : null}

      <TodaySection
        title={GROUPS.portfolio}
        description="Symbols you hold that moved or changed state."
        items={sections.portfolio}
        onOpenSymbol={onOpenSymbol}
      />
      <TodaySection
        title={GROUPS.opportunities}
        description="Research candidates where the signal engine now sees a setup."
        items={sections.opportunities}
        onOpenSymbol={onOpenSymbol}
      />
      <TodaySection
        title={GROUPS.regime}
        description="Symbols whose market regime changed since the previous scan."
        items={sections.regime}
        onOpenSymbol={onOpenSymbol}
      />
      <TodaySection
        title={GROUPS.unusual}
        description="Moves or volume well outside each symbol's own normal range."
        items={sections.unusual}
        onOpenSymbol={onOpenSymbol}
      />
    </div>
  );
}
