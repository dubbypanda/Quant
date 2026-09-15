// CSV import with mapping preview and explicit confirmation.
//
// The flow is fixed by section 8: parse locally, show the detected mapping,
// list every row that will be added AND every row that will not with its
// reason, then require an explicit Import press. Nothing is skipped silently,
// and nothing is written before the user confirms.

import React, { useState } from 'react';
import type { PortfolioDocumentV3 } from '../../../shared/portfolio';
import type { PortfolioCsvPreview } from '../../../main/services/portfolioImport';
import { api } from '../../api';
import { money, quantity } from './format';

interface CsvImportDialogProps {
  document: PortfolioDocumentV3;
  onImport: (text: string, accountId: string) => Promise<string[] | null>;
  onClose: () => void;
}

export function CsvImportDialog({
  document,
  onImport,
  onClose,
}: CsvImportDialogProps): React.ReactElement {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<PortfolioCsvPreview | null>(null);
  const [accountId, setAccountId] = useState(document.accounts[0]?.id ?? '');
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const readFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const contents = await file.text();
    setText(contents);
    setPreview(await api.previewPortfolioCsv(contents));
    setErrors([]);
  };

  const parsePasted = async () => {
    setPreview(await api.previewPortfolioCsv(text));
    setErrors([]);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await onImport(text, accountId);
      if (result) setErrors(result);
      else onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pf-dialog" role="dialog" aria-modal="true" aria-label="Import positions from CSV">
      <div className="pf-dialog-body">
        <header className="pf-dialog-head">
          <h3>Import positions from CSV</h3>
          <button type="button" onClick={onClose} aria-label="Close import">
            Close
          </button>
        </header>

        <p className="pf-note">
          Accepted columns: symbol, quantity, cost per share or total cost, and optionally account
          and acquired date. Nothing is saved until you press Import.
        </p>

        <label className="pf-file">
          <span>Choose a CSV file</span>
          <input type="file" accept=".csv,text/csv" onChange={readFile} />
        </label>

        <label className="pf-paste">
          <span>…or paste CSV</span>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={4}
            spellCheck={false}
          />
        </label>
        <button type="button" onClick={parsePasted} disabled={!text.trim()}>
          Parse
        </button>

        {errors.length ? (
          <ul className="pf-errors" role="alert">
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        ) : null}

        {preview ? (
          <section className="pf-preview" aria-label="Import preview">
            {preview.warnings.length ? (
              <ul className="pf-warnings" role="status">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}

            <h4>Detected columns</h4>
            <ul className="pf-mapping">
              {Object.entries(preview.detectedMapping).map(([column, index]) =>
                index === undefined ? null : (
                  <li key={column}>
                    <code>{column}</code> → {preview.header[index] ?? `column ${index + 1}`}
                  </li>
                ),
              )}
            </ul>

            <p className="pf-preview-counts">
              {preview.validRowCount} row{preview.validRowCount === 1 ? '' : 's'} will be added
              {preview.invalidRowCount
                ? `, ${preview.invalidRowCount} will not`
                : ''}
              .
            </p>

            <div className="pf-table-wrap">
              <table className="pf-table pf-table-compact">
                <thead>
                  <tr>
                    <th scope="col">Row</th>
                    <th scope="col">Symbol</th>
                    <th scope="col" className="num">Qty</th>
                    <th scope="col" className="num">Cost</th>
                    <th scope="col">Account</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber} className={row.valid ? '' : 'pf-row-invalid'}>
                      <td className="num">{row.rowNumber}</td>
                      <td>{row.symbol ?? '—'}</td>
                      <td className="num">{row.quantity === null ? '—' : quantity(row.quantity)}</td>
                      <td className="num">{money(row.costPerShare)}</td>
                      <td>{row.accountName ?? '—'}</td>
                      {/* Every rejection carries its reason, on its own row. */}
                      <td>{row.valid ? 'Will import' : row.errors.join('; ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <label>
              <span>Import into</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {document.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              className="pf-primary"
              onClick={confirm}
              disabled={busy || !preview.validRowCount || !accountId}
            >
              {busy ? 'Importing…' : `Import ${preview.validRowCount} position${preview.validRowCount === 1 ? '' : 's'}`}
            </button>
            {!document.accounts.length ? (
              <p className="pf-note">Add an account before importing.</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>
  );
}
