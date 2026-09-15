// Eligibility controls.
//
// Stocks and ETFs stay separately filterable, and the leveraged/inverse/
// single-stock toggles are explicit metadata policy rather than a guess from
// ticker names. Relaxing the liquidity floor is allowed — the resulting rows
// are flagged rather than hidden.

import React from 'react';
import type { DiscoveryEligibilitySettings } from '../../../shared/discovery';
import { DEFAULT_ELIGIBILITY_SETTINGS } from '../../../shared/discovery';

interface DiscoveryFiltersProps {
  settings: DiscoveryEligibilitySettings;
  onChange: (patch: Partial<DiscoveryEligibilitySettings>) => void;
  disabled: boolean;
}

export function DiscoveryFilters({
  settings,
  onChange,
  disabled,
}: DiscoveryFiltersProps): React.ReactElement {
  const toggle = (
    key: keyof DiscoveryEligibilitySettings,
    label: string,
    title?: string,
  ): React.ReactElement => (
    <button
      type="button"
      className={`dc-toggle${settings[key] ? ' is-on' : ''}`}
      aria-pressed={Boolean(settings[key])}
      onClick={() => onChange({ [key]: !settings[key] } as Partial<DiscoveryEligibilitySettings>)}
      disabled={disabled}
      title={title}
    >
      {label}
    </button>
  );

  return (
    <div className="dc-filters">
      <label>
        <span>Min price</span>
        <input
          type="number"
          min={0}
          step={0.5}
          value={settings.minimumPrice}
          onChange={(event) => onChange({ minimumPrice: Number(event.target.value) })}
          disabled={disabled}
        />
      </label>
      <label>
        <span>Min median $ volume</span>
        <input
          type="number"
          min={0}
          step={500_000}
          value={settings.minimumMedianDollarVolume20}
          onChange={(event) =>
            onChange({ minimumMedianDollarVolume20: Number(event.target.value) })
          }
          disabled={disabled}
        />
      </label>
      <label>
        <span>Min bars</span>
        <input
          type="number"
          min={30}
          step={10}
          value={settings.minimumHistoryBars}
          onChange={(event) => onChange({ minimumHistoryBars: Number(event.target.value) })}
          disabled={disabled}
        />
      </label>

      <div className="dc-toggle-group" role="group" aria-label="Instrument types">
        {toggle('includeEtfs', 'ETFs')}
        {toggle(
          'includeLeveragedEtfs',
          'Leveraged',
          'Uses explicit fund metadata, not ticker-name patterns',
        )}
        {toggle('includeInverseEtfs', 'Inverse', 'Uses explicit fund metadata')}
        {toggle('includeSingleStockEtfs', 'Single-stock', 'Uses explicit fund metadata')}
      </div>

      {settings.minimumMedianDollarVolume20 <
      DEFAULT_ELIGIBILITY_SETTINGS.minimumMedianDollarVolume20 ? (
        <p className="dc-note">
          Liquidity floor is below the default. Thin candidates will be shown and flagged.
        </p>
      ) : null}
    </div>
  );
}
