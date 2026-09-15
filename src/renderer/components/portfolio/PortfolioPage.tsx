// The Portfolio page.
//
// An empty portfolio is a first-run state with two actions, not an error: a
// user who has entered nothing yet has done nothing wrong.

import React, { useState } from 'react';
import { usePortfolio } from './usePortfolio';
import { PortfolioSummary } from './PortfolioSummary';
import { PositionsTable } from './PositionsTable';
import { RiskPanel } from './RiskPanel';
import { ExposurePanel } from './ExposurePanel';
import { PositionEditor } from './PositionEditor';
import { CsvImportDialog } from './CsvImportDialog';

interface PortfolioPageProps {
  onOpenSymbol?: (symbol: string) => void;
}

export function PortfolioPage({ onOpenSymbol }: PortfolioPageProps): React.ReactElement {
  const portfolio = usePortfolio();
  const [showEditor, setShowEditor] = useState(false);
  const [showImport, setShowImport] = useState(false);

  const document = portfolio.document;
  const isEmpty = Boolean(document && !document.lots.length && !document.accounts.length);

  return (
    <div className="pf-page">
      <header className="pf-page-head">
        <h2>Portfolio</h2>
        <div className="pf-actions">
          <button type="button" onClick={() => setShowEditor((value) => !value)}>
            {showEditor ? 'Hide editor' : 'Add position'}
          </button>
          <button type="button" onClick={() => setShowImport(true)} disabled={!document}>
            Import CSV
          </button>
          <button type="button" onClick={() => void portfolio.refresh()}>
            Refresh
          </button>
        </div>
      </header>

      {portfolio.error ? (
        <p className="pf-errors" role="alert">
          {portfolio.error}
        </p>
      ) : null}

      {isEmpty && !showEditor ? (
        <section className="pf-first-run">
          <h3>No positions yet</h3>
          <p>
            Add positions by hand or import a CSV. Quant stores your portfolio locally and never
            connects to a brokerage.
          </p>
          <div className="pf-actions">
            <button type="button" className="pf-primary" onClick={() => setShowEditor(true)}>
              Add position
            </button>
            <button type="button" onClick={() => setShowImport(true)}>
              Import CSV
            </button>
          </div>
        </section>
      ) : (
        <>
          <PortfolioSummary
            snapshot={portfolio.snapshot}
            coveragePercent={portfolio.exposure?.coveragePercent ?? null}
          />

          <section className="pf-positions" aria-label="Positions">
            <h3>Positions</h3>
            <PositionsTable
              positions={portfolio.snapshot?.positions ?? []}
              risk={portfolio.risk}
              onOpenSymbol={onOpenSymbol}
            />
          </section>

          <div className="pf-columns">
            <RiskPanel risk={portfolio.risk} loading={portfolio.loading} />
            <ExposurePanel exposure={portfolio.exposure} loading={portfolio.loading} />
          </div>
        </>
      )}

      {showEditor && document ? (
        <PositionEditor
          document={document}
          onAddAccount={portfolio.addAccount}
          onAddLot={portfolio.addLot}
          onRemoveLot={portfolio.removeLot}
          onSetCash={portfolio.setCash}
        />
      ) : null}

      {showImport && document ? (
        <CsvImportDialog
          document={document}
          onImport={portfolio.importCsv}
          onClose={() => setShowImport(false)}
        />
      ) : null}
    </div>
  );
}
