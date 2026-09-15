// Normalized CSV import with a mapping preview.
//
// Two rules from docs/quant-v3/03 section 8 drive the design:
//
//   * **No broker-specific parsers in the core domain.** One normalized
//     importer plus column detection, so a new broker is a mapping rather than
//     a code path.
//   * **Never silently skip an invalid row.** Every rejection is reported with
//     its 1-based row number and a reason. A silent skip means the user
//     believes they imported a position they did not.
//
// The parser is hand-written and dependency-free: it handles quoted commas,
// escaped quotes, CRLF and a UTF-8 BOM, which is the whole of what broker
// exports actually need.

import type { PortfolioDocumentV3, PortfolioLot } from '../../shared/portfolio';

export type PortfolioCsvColumn =
  | 'symbol'
  | 'quantity'
  | 'cost_per_share'
  | 'total_cost'
  | 'account'
  | 'acquired_at'
  | 'note';

export interface PortfolioCsvMapping {
  /** Semantic column → zero-based index in the CSV header. */
  [column: string]: number | undefined;
}

export interface PortfolioCsvRowPreview {
  /** 1-based data row number as the user sees it in a spreadsheet, header
   *  excluded. */
  rowNumber: number;
  symbol: string | null;
  quantity: number | null;
  costPerShare: number | null;
  accountName: string | null;
  acquiredAt: string | null;
  note: string | null;
  valid: boolean;
  errors: string[];
}

export interface PortfolioCsvPreview {
  header: string[];
  detectedMapping: PortfolioCsvMapping;
  rows: PortfolioCsvRowPreview[];
  validRowCount: number;
  invalidRowCount: number;
  warnings: string[];
}

/**
 * Splits CSV text into rows of fields.
 *
 * A character-wise scan rather than a split on commas: a quoted field may
 * contain commas, newlines and doubled quotes, and every broker export
 * eventually contains one.
 */
export function parseCsv(text: string): string[][] {
  // Strip a UTF-8 BOM, which otherwise becomes part of the first header cell
  // and breaks column detection in a way that is invisible on screen.
  const input = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (inQuotes) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      row.push(field);
      field = '';
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      continue;
    }
    field += char;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((candidate) => candidate.some((cell) => cell.trim().length > 0));
}

const COLUMN_PATTERNS: Array<{ column: PortfolioCsvColumn; patterns: RegExp[] }> = [
  { column: 'symbol', patterns: [/^symbol$/i, /^ticker$/i, /^security$/i, /symbol/i] },
  { column: 'quantity', patterns: [/^quantity$/i, /^qty$/i, /^shares$/i, /quantity|shares/i] },
  {
    column: 'cost_per_share',
    patterns: [/cost.*per.*share/i, /^price$/i, /average.*cost/i, /^unit.*cost$/i, /cost.*basis.*share/i],
  },
  { column: 'total_cost', patterns: [/total.*cost/i, /^cost.*basis$/i, /^book.*value$/i] },
  { column: 'account', patterns: [/^account$/i, /account.*name/i, /account/i] },
  { column: 'acquired_at', patterns: [/acquired/i, /purchase.*date/i, /^date$/i, /trade.*date/i] },
  { column: 'note', patterns: [/^note[s]?$/i, /description/i] },
];

/**
 * Guesses which CSV column carries which semantic field.
 *
 * Patterns are ordered from exact to loose so `cost_per_share` is not claimed
 * by a header like "Total Cost Basis" that a loose `cost` pattern would match
 * first. The guess is only ever a starting point — the user confirms the
 * mapping before anything is imported.
 */
export function detectCsvMapping(header: string[]): PortfolioCsvMapping {
  const mapping: PortfolioCsvMapping = {};
  const used = new Set<number>();
  for (const { column, patterns } of COLUMN_PATTERNS) {
    for (const pattern of patterns) {
      const index = header.findIndex(
        (cell, position) => !used.has(position) && pattern.test(cell.trim()),
      );
      if (index >= 0) {
        mapping[column] = index;
        used.add(index);
        break;
      }
    }
  }
  return mapping;
}

function cell(row: string[], index: number | undefined): string | null {
  if (index === undefined || index < 0 || index >= row.length) return null;
  const value = row[index].trim();
  return value.length ? value : null;
}

/** Parses a number tolerating currency symbols, thousands separators and
 *  parenthesised negatives, all of which appear in real exports. */
export function parseCsvNumber(raw: string | null): number | null {
  if (raw === null) return null;
  const negative = /^\(.*\)$/.test(raw.trim());
  const cleaned = raw.replace(/[()$,\s]/g, '').replace(/[^0-9.\-]/g, '');
  if (!cleaned || cleaned === '-' || cleaned === '.') return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

function parseCsvDate(raw: string | null): { iso: string | null; error: string | null } {
  if (raw === null) return { iso: null, error: null };
  const stamp = Date.parse(raw);
  if (!Number.isFinite(stamp)) return { iso: null, error: `Unrecognised date: ${raw}` };
  return { iso: new Date(stamp).toISOString(), error: null };
}

export interface BuildCsvPreviewArgs {
  text: string;
  mapping?: PortfolioCsvMapping;
}

export function buildCsvPreview(args: BuildCsvPreviewArgs): PortfolioCsvPreview {
  const parsed = parseCsv(args.text);
  const warnings: string[] = [];
  if (!parsed.length) {
    return {
      header: [],
      detectedMapping: {},
      rows: [],
      validRowCount: 0,
      invalidRowCount: 0,
      warnings: ['The file contained no rows.'],
    };
  }

  const header = parsed[0].map((cellValue) => cellValue.trim());
  const detectedMapping = args.mapping ?? detectCsvMapping(header);

  if (detectedMapping.symbol === undefined) warnings.push('No symbol column was detected.');
  if (detectedMapping.quantity === undefined) warnings.push('No quantity column was detected.');
  if (detectedMapping.cost_per_share === undefined && detectedMapping.total_cost === undefined) {
    warnings.push('No cost column was detected; either cost per share or total cost is required.');
  }

  const rows: PortfolioCsvRowPreview[] = parsed.slice(1).map((raw, index) => {
    const errors: string[] = [];
    const rowNumber = index + 1;

    const rawSymbol = cell(raw, detectedMapping.symbol);
    const symbol = rawSymbol ? rawSymbol.toUpperCase() : null;
    if (!symbol) errors.push('Missing symbol.');
    else if (!/^[A-Z0-9.\-^]{1,12}$/.test(symbol)) errors.push(`Invalid symbol: ${symbol}`);

    const quantity = parseCsvNumber(cell(raw, detectedMapping.quantity));
    if (quantity === null) errors.push('Missing or unreadable quantity.');
    else if (quantity <= 0) errors.push(`Quantity must be greater than zero, got ${quantity}.`);

    // Per-share cost is preferred; a total is divided by quantity, which is
    // only meaningful once quantity is known to be valid.
    let costPerShare = parseCsvNumber(cell(raw, detectedMapping.cost_per_share));
    if (costPerShare === null) {
      const totalCost = parseCsvNumber(cell(raw, detectedMapping.total_cost));
      if (totalCost !== null && quantity !== null && quantity > 0) {
        costPerShare = totalCost / quantity;
      }
    }
    if (costPerShare === null) errors.push('Missing or unreadable cost.');
    else if (costPerShare < 0) errors.push(`Cost cannot be negative, got ${costPerShare}.`);

    const { iso: acquiredAt, error: dateError } = parseCsvDate(cell(raw, detectedMapping.acquired_at));
    if (dateError) errors.push(dateError);

    return {
      rowNumber,
      symbol,
      quantity,
      costPerShare,
      accountName: cell(raw, detectedMapping.account),
      acquiredAt,
      note: cell(raw, detectedMapping.note),
      valid: errors.length === 0,
      errors,
    };
  });

  return {
    header,
    detectedMapping,
    rows,
    validRowCount: rows.filter((row) => row.valid).length,
    invalidRowCount: rows.filter((row) => !row.valid).length,
    warnings,
  };
}

/**
 * Turns a confirmed preview into lots for one account.
 *
 * Only valid rows become lots, and the caller already has the invalid ones
 * listed by row number — nothing is dropped without having been shown.
 */
export function csvPreviewToLots(
  preview: PortfolioCsvPreview,
  defaultAccountId: string,
  doc: PortfolioDocumentV3,
): Array<Omit<PortfolioLot, 'id'>> {
  const accountByName = new Map(
    doc.accounts.map((account) => [account.name.trim().toLowerCase(), account.id]),
  );
  return preview.rows
    .filter((row) => row.valid && row.symbol && row.quantity !== null && row.costPerShare !== null)
    .map((row) => ({
      symbol: row.symbol as string,
      quantity: row.quantity as number,
      costPerShare: row.costPerShare as number,
      acquiredAt: row.acquiredAt,
      // An unrecognised account name falls back to the chosen account rather
      // than creating accounts implicitly from a spreadsheet.
      accountId: accountByName.get((row.accountName ?? '').trim().toLowerCase()) ?? defaultAccountId,
      ...(row.note ? { note: row.note } : {}),
    }));
}
