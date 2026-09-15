// Local, validated, atomically written portfolio storage.
//
// Recovery policy, in order:
//   1. read the primary document and validate the whole thing;
//   2. on failure, try the backup;
//   3. on failure of both, surface a recoverable error and start empty.
//
// Step 3 explicitly does NOT seed a demo portfolio. A fabricated position would
// be indistinguishable from a real one the user had entered and lost, which is
// the worst possible failure for this particular file.
//
// No brokerage login, OAuth or order placement exists anywhere in this module.

import { app } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  PortfolioAccount,
  PortfolioDocumentV3,
  PortfolioLot,
} from '../../shared/portfolio';
import { emptyPortfolioDocument, validatePortfolioDocument } from '../../shared/portfolio';

export const PORTFOLIO_FILE = 'portfolio-v3.json';
export const PORTFOLIO_BACKUP_FILE = 'portfolio-v3.backup.json';

export class PortfolioValidationError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Portfolio update rejected: ${errors.join(' ')}`);
    this.name = 'PortfolioValidationError';
    this.errors = errors;
  }
}

let rootOverride: string | null = null;

/** Test seam; production always resolves under `userData`. */
export function setPortfolioRoot(root: string | null): void {
  rootOverride = root;
}

function portfolioRoot(): string {
  return rootOverride ?? app.getPath('userData');
}

function primaryPath(): string {
  return path.join(portfolioRoot(), PORTFOLIO_FILE);
}

function backupPath(): string {
  return path.join(portfolioRoot(), PORTFOLIO_BACKUP_FILE);
}

/** Last read that fell back to the backup or to an empty document. Exposed so
 *  the UI can tell the user their primary file was unreadable rather than
 *  quietly showing them an empty portfolio. */
let lastRecoveryWarning: string | null = null;

export function consumePortfolioRecoveryWarning(): string | null {
  const warning = lastRecoveryWarning;
  lastRecoveryWarning = null;
  return warning;
}

function readValidated(filePath: string): PortfolioDocumentV3 | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    const validation = validatePortfolioDocument(parsed);
    if (!validation.ok) return null;
    return parsed as PortfolioDocumentV3;
  } catch {
    return null;
  }
}

export function getPortfolioDocument(): PortfolioDocumentV3 {
  const primary = readValidated(primaryPath());
  if (primary) return primary;

  const backup = readValidated(backupPath());
  if (backup) {
    lastRecoveryWarning =
      'The portfolio file could not be read, so the previous good version was restored.';
    return backup;
  }

  if (fs.existsSync(primaryPath()) || fs.existsSync(backupPath())) {
    lastRecoveryWarning =
      'The portfolio file and its backup could not be read. No positions were loaded; nothing was deleted.';
  }
  return emptyPortfolioDocument();
}

function writeAtomic(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp`;
  const handle = fs.openSync(temp, 'w');
  try {
    fs.writeFileSync(handle, contents);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temp, filePath);
}

/**
 * Validates, backs up the current good version, then commits.
 *
 * The backup is taken from the file on disk rather than from memory, so it is
 * a copy of something known to have parsed.
 */
export function replacePortfolioDocument(candidate: PortfolioDocumentV3): PortfolioDocumentV3 {
  const next: PortfolioDocumentV3 = { ...candidate, updatedAt: new Date().toISOString() };
  const validation = validatePortfolioDocument(next);
  if (!validation.ok) throw new PortfolioValidationError(validation.errors);

  const existing = readValidated(primaryPath());
  if (existing) {
    try {
      writeAtomic(backupPath(), JSON.stringify(existing, null, 2));
    } catch {
      // A failed backup must not block the write; the primary is still atomic.
    }
  }
  writeAtomic(primaryPath(), JSON.stringify(next, null, 2));
  return next;
}

function normalizePortfolioSymbol(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const symbol = raw.trim().toUpperCase();
  return /^[A-Z0-9.\-^]{1,12}$/.test(symbol) ? symbol : null;
}

export function addPortfolioAccount(
  input: Omit<PortfolioAccount, 'id' | 'createdAt'>,
): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  const account: PortfolioAccount = {
    ...input,
    name: input.name.trim(),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
  };
  return replacePortfolioDocument({ ...doc, accounts: [...doc.accounts, account] });
}

export function addPortfolioLot(input: Omit<PortfolioLot, 'id'>): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  const symbol = normalizePortfolioSymbol(input.symbol);
  if (!symbol) throw new PortfolioValidationError([`Invalid symbol: ${String(input.symbol)}`]);
  const lot: PortfolioLot = {
    ...input,
    symbol,
    id: crypto.randomUUID(),
    acquiredAt: input.acquiredAt ?? null,
  };
  return replacePortfolioDocument({ ...doc, lots: [...doc.lots, lot] });
}

export function addPortfolioLots(inputs: Array<Omit<PortfolioLot, 'id'>>): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  const lots: PortfolioLot[] = [];
  for (const input of inputs) {
    const symbol = normalizePortfolioSymbol(input.symbol);
    if (!symbol) throw new PortfolioValidationError([`Invalid symbol: ${String(input.symbol)}`]);
    lots.push({ ...input, symbol, id: crypto.randomUUID(), acquiredAt: input.acquiredAt ?? null });
  }
  // One write for the whole batch: a CSV import that half-applied would leave
  // the user reconciling by hand.
  return replacePortfolioDocument({ ...doc, lots: [...doc.lots, ...lots] });
}

export function updatePortfolioLot(
  id: string,
  patch: Partial<Pick<PortfolioLot, 'quantity' | 'costPerShare' | 'acquiredAt' | 'accountId' | 'note'>>,
): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  const index = doc.lots.findIndex((lot) => lot.id === id);
  if (index < 0) throw new PortfolioValidationError([`No lot with id ${id}.`]);
  const lots = [...doc.lots];
  lots[index] = { ...lots[index], ...patch };
  return replacePortfolioDocument({ ...doc, lots });
}

export function removePortfolioLot(id: string): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  const lots = doc.lots.filter((lot) => lot.id !== id);
  if (lots.length === doc.lots.length) throw new PortfolioValidationError([`No lot with id ${id}.`]);
  return replacePortfolioDocument({ ...doc, lots });
}

export function setAccountCash(accountId: string, amount: number): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  if (!doc.accounts.some((account) => account.id === accountId)) {
    throw new PortfolioValidationError([`No account with id ${accountId}.`]);
  }
  if (!Number.isFinite(amount) || amount < 0) {
    throw new PortfolioValidationError(['Cash must be a finite amount of zero or greater.']);
  }
  return replacePortfolioDocument({
    ...doc,
    cashByAccount: { ...doc.cashByAccount, [accountId]: amount },
  });
}

export function removePortfolioAccount(accountId: string): PortfolioDocumentV3 {
  const doc = getPortfolioDocument();
  if (doc.lots.some((lot) => lot.accountId === accountId)) {
    // Removing the account would orphan its lots, which validation forbids —
    // so the refusal is explicit rather than a confusing validation error.
    throw new PortfolioValidationError([
      'Remove or reassign this account’s positions before deleting it.',
    ]);
  }
  const cashByAccount = { ...doc.cashByAccount };
  delete cashByAccount[accountId];
  return replacePortfolioDocument({
    ...doc,
    accounts: doc.accounts.filter((account) => account.id !== accountId),
    cashByAccount,
  });
}
