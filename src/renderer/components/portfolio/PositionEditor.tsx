// Add and edit positions, accounts and cash.
//
// Validation shown here is for immediate feedback only; the main process
// validates again and its errors are what get displayed on failure.

import React, { useState } from 'react';
import type { PortfolioAccountType, PortfolioDocumentV3 } from '../../../shared/portfolio';
import { money, quantity } from './format';

interface PositionEditorProps {
  document: PortfolioDocumentV3;
  onAddAccount: (name: string, type: PortfolioAccountType) => Promise<string[] | null>;
  onAddLot: (input: {
    symbol: string;
    quantity: number;
    costPerShare: number;
    accountId: string;
    acquiredAt?: string | null;
  }) => Promise<string[] | null>;
  onRemoveLot: (id: string) => Promise<string[] | null>;
  onSetCash: (accountId: string, amount: number) => Promise<string[] | null>;
}

const ACCOUNT_TYPES: PortfolioAccountType[] = ['taxable', 'ira', 'roth-ira', '401k', 'other'];

export function PositionEditor({
  document,
  onAddAccount,
  onAddLot,
  onRemoveLot,
  onSetCash,
}: PositionEditorProps): React.ReactElement {
  const [errors, setErrors] = useState<string[]>([]);
  const [accountName, setAccountName] = useState('');
  const [accountType, setAccountType] = useState<PortfolioAccountType>('taxable');
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [cost, setCost] = useState('');
  const [acquiredAt, setAcquiredAt] = useState('');
  const [accountId, setAccountId] = useState(document.accounts[0]?.id ?? '');
  const [cashAccountId, setCashAccountId] = useState(document.accounts[0]?.id ?? '');
  const [cashAmount, setCashAmount] = useState('');

  const report = (result: string[] | null) => setErrors(result ?? []);

  const submitAccount = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = await onAddAccount(accountName, accountType);
    if (!result) setAccountName('');
    report(result);
  };

  const submitLot = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsedQty = Number(qty);
    const parsedCost = Number(cost);
    const result = await onAddLot({
      symbol,
      quantity: Number.isFinite(parsedQty) ? parsedQty : Number.NaN,
      costPerShare: Number.isFinite(parsedCost) ? parsedCost : Number.NaN,
      accountId,
      acquiredAt: acquiredAt || null,
    });
    if (!result) {
      setSymbol('');
      setQty('');
      setCost('');
      setAcquiredAt('');
    }
    report(result);
  };

  const submitCash = async (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = Number(cashAmount);
    report(await onSetCash(cashAccountId, Number.isFinite(parsed) ? parsed : Number.NaN));
  };

  return (
    <section className="pf-panel" aria-label="Edit positions">
      <h3>Add</h3>

      {errors.length ? (
        <ul className="pf-errors" role="alert">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      {/* An empty portfolio needs an account first, so that form leads. */}
      <form className="pf-form" onSubmit={submitAccount}>
        <h4>Account</h4>
        <label>
          <span>Name</span>
          <input
            value={accountName}
            onChange={(event) => setAccountName(event.target.value)}
            placeholder="Taxable"
            required
          />
        </label>
        <label>
          <span>Type</span>
          <select
            value={accountType}
            onChange={(event) => setAccountType(event.target.value as PortfolioAccountType)}
          >
            {ACCOUNT_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <button type="submit">Add account</button>
      </form>

      {document.accounts.length ? (
        <>
          <form className="pf-form" onSubmit={submitLot}>
            <h4>Position</h4>
            <label>
              <span>Symbol</span>
              <input
                value={symbol}
                onChange={(event) => setSymbol(event.target.value.toUpperCase())}
                placeholder="NVDA"
                required
              />
            </label>
            <label>
              <span>Quantity</span>
              <input
                value={qty}
                onChange={(event) => setQty(event.target.value)}
                inputMode="decimal"
                required
              />
            </label>
            <label>
              <span>Cost per share</span>
              <input
                value={cost}
                onChange={(event) => setCost(event.target.value)}
                inputMode="decimal"
                required
              />
            </label>
            <label>
              <span>Acquired</span>
              <input
                type="date"
                value={acquiredAt}
                onChange={(event) => setAcquiredAt(event.target.value)}
              />
            </label>
            <label>
              <span>Account</span>
              <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
                {document.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </select>
            </label>
            <button type="submit">Add position</button>
          </form>

          <form className="pf-form" onSubmit={submitCash}>
            <h4>Cash</h4>
            <label>
              <span>Account</span>
              <select
                value={cashAccountId}
                onChange={(event) => setCashAccountId(event.target.value)}
              >
                {document.accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({money(document.cashByAccount[account.id] ?? 0)})
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Amount</span>
              <input
                value={cashAmount}
                onChange={(event) => setCashAmount(event.target.value)}
                inputMode="decimal"
                required
              />
            </label>
            <button type="submit">Set cash</button>
          </form>
        </>
      ) : null}

      {document.lots.length ? (
        <>
          <h4>Lots</h4>
          <ul className="pf-lots">
            {document.lots.map((lot) => {
              const account = document.accounts.find((item) => item.id === lot.accountId);
              return (
                <li key={lot.id}>
                  <span className="pf-lot-text">
                    {lot.symbol} · {quantity(lot.quantity)} @ {money(lot.costPerShare)}
                    {account ? ` · ${account.name}` : ''}
                    {lot.acquiredAt ? ` · ${new Date(lot.acquiredAt).toLocaleDateString()}` : ''}
                  </span>
                  <button
                    type="button"
                    className="pf-remove"
                    onClick={() => void onRemoveLot(lot.id).then(report)}
                    aria-label={`Remove ${quantity(lot.quantity)} ${lot.symbol}`}
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
