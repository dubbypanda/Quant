// Chooses the at most two reasons a collapsed signal row is allowed to show.
// Ported from the Quantactic iOS model (`SignalReasonPrioritizer.swift`).
//
// The constraint is the product decision: a card that lists six reasons is a
// card nobody reads. Two well-chosen reasons carry the conclusion, and the
// detail view still shows every category.

import {
  CATEGORY_LEAN_SENTENCES,
  isMeasured,
  type EvidenceLean,
  type SignalEvidence,
  type SignalEvidenceCategory,
  type SignalReason,
  type UnifiedSignal,
} from './unifiedSignal';

export const MAXIMUM_REASONS = 2;

/** Which category earns the scarce second line, when several qualify. */
const CATEGORY_PRIORITY: SignalEvidenceCategory[] = [
  'price-acceptance',
  'trend',
  'momentum',
  'relative-strength',
  'volume',
  'market-context',
];

function priorityIndex(category: SignalEvidenceCategory): number {
  const index = CATEGORY_PRIORITY.indexOf(category);
  return index < 0 ? CATEGORY_PRIORITY.length : index;
}

function ordered(evidence: SignalEvidence[]): SignalEvidence[] {
  return [...evidence].sort((a, b) => priorityIndex(a.category) - priorityIndex(b.category));
}

/** Keyed on the lean: the row says what price is doing, so it reads correctly
 *  under a SELL as well as a BUY. */
function reasonText(evidence: SignalEvidence): string {
  if (evidence.category === 'risk-plan') return '';
  return CATEGORY_LEAN_SENTENCES[evidence.category][evidence.lean];
}

/** The arrow follows price, not the conclusion, so a weakening trend points
 *  down on a SELL card too. */
function reasonDirection(lean: EvidenceLean): SignalReason['direction'] {
  if (lean === 'bullish') return 'positive';
  if (lean === 'bearish') return 'negative';
  return 'neutral';
}

export function prioritizeSignalReasons(
  signal: UnifiedSignal,
  evidence: SignalEvidence[],
  changedCategories: ReadonlySet<SignalEvidenceCategory> = new Set(),
): SignalReason[] {
  const measured = evidence.filter(isMeasured);

  // A reason that explains a *change* is the most useful thing a row can say,
  // so it outranks a statically stronger one.
  const changed = measured.filter((item) => changedCategories.has(item.category));
  const agreeing = measured.filter((item) => item.state === 'supports');
  const conflicting = measured.filter((item) => item.state === 'weakens');
  const unresolved = measured.filter((item) => item.state === 'mixed');

  const ranked =
    signal === 'wait'
      ? // A wait is only useful if it says what is missing, so the conflict or
        // the unresolved category leads.
        [...ordered(changed), ...ordered(conflicting), ...ordered(unresolved), ...ordered(agreeing)]
      : // Lead with what carries the conclusion; a live conflict still earns the
        // second line, because hiding it would be dishonest.
        [...ordered(changed), ...ordered(agreeing), ...ordered(conflicting)];

  const chosen: SignalReason[] = [];
  const usedCategories = new Set<SignalEvidenceCategory>();
  const usedText = new Set<string>();

  for (const item of ranked) {
    if (chosen.length >= MAXIMUM_REASONS) break;
    // Market context is a contributor, not a headline: it only earns a line
    // when nothing about the symbol itself is worth saying.
    if (item.category === 'market-context' && !chosen.length && ranked.length > 1) continue;
    if (usedCategories.has(item.category)) continue;
    const text = reasonText(item);
    // Two categories phrased identically read as a mistake, so keep the
    // stronger one and move on.
    if (!text || usedText.has(text)) continue;
    usedCategories.add(item.category);
    usedText.add(text);
    chosen.push({ category: item.category, direction: reasonDirection(item.lean), text });
  }
  return chosen;
}
