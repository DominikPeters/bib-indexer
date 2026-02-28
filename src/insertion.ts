/**
 * Utility functions for inserting BibTeX entries into files
 */

import { IndexedEntry, CANONICAL_FIELD_ORDER } from './types';

/**
 * Find the line number where a new entry should be inserted.
 *
 * @param lines - The lines of the current file
 * @param currentEntry - The entry at the cursor position (if any)
 * @param cursorLine - The active cursor line (0-indexed) as fallback anchor
 * @returns The 0-indexed line number where the entry should be inserted
 */
export function findEntryInsertionPoint(
  lines: string[],
  currentEntry: { endLine?: number } | null,
  cursorLine?: number
): number {
  // If we have a current entry, insert after it
  if (currentEntry && currentEntry.endLine) {
    return currentEntry.endLine; // endLine is 1-indexed, so this gives us the line after
  }

  if (typeof cursorLine === 'number') {
    const clampedCursorLine = Math.max(0, Math.min(cursorLine, Math.max(0, lines.length - 1)));
    const entryRanges = findEntryRanges(lines);

    const containingEntry = entryRanges.find(
      (entry) => clampedCursorLine >= entry.start && clampedCursorLine <= entry.end
    );
    if (containingEntry) {
      return containingEntry.end + 1;
    }

    const nextEntry = entryRanges.find((entry) => entry.start > clampedCursorLine);
    if (nextEntry) {
      return nextEntry.start;
    }

    const previousEntry = [...entryRanges].reverse().find((entry) => entry.end < clampedCursorLine);
    if (previousEntry) {
      return previousEntry.end + 1;
    }

    return Math.max(0, Math.min(clampedCursorLine, lines.length));
  }

  // Otherwise, find the last entry in the file and insert after it
  const entryRanges = findEntryRanges(lines);
  const lastEntry = entryRanges[entryRanges.length - 1];

  // If we found entries, insert after the last one
  if (lastEntry) {
    return lastEntry.end + 1;
  }

  // Otherwise, insert at end of file
  return lines.length;
}

function findEntryRanges(lines: string[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let inEntry = false;
  let braceDepth = 0;
  let currentStart = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inEntry && /^\s*@\w+\s*\{/i.test(line)) {
      inEntry = true;
      braceDepth = 0;
      currentStart = i;
    }

    if (!inEntry) {
      continue;
    }

    for (const char of line) {
      if (char === '{') {
        braceDepth++;
      }
      if (char === '}') {
        braceDepth--;
      }
    }

    if (braceDepth <= 0) {
      ranges.push({ start: currentStart, end: i });
      inEntry = false;
      currentStart = -1;
    }
  }

  return ranges;
}

/**
 * Format an IndexedEntry as a BibTeX string.
 * Fields are sorted according to CANONICAL_FIELD_ORDER.
 *
 * @param entry - The entry to format
 * @returns The formatted BibTeX string
 */
export function formatBibtex(entry: IndexedEntry): string {
  const lines: string[] = [];
  lines.push(`@${entry.entryType}{${entry.key},`);

  const sortedFields = Object.entries(entry.fields).sort(([a], [b]) => {
    const aIdx = CANONICAL_FIELD_ORDER.indexOf(a);
    const bIdx = CANONICAL_FIELD_ORDER.indexOf(b);
    const aOrder = aIdx === -1 ? 999 : aIdx;
    const bOrder = bIdx === -1 ? 999 : bIdx;
    return aOrder - bOrder;
  });

  for (const [key, value] of sortedFields) {
    lines.push(`  ${key} = ${formatFieldValue(value)},`);
  }

  lines.push('}');
  return lines.join('\n');
}

/**
 * Format a field value for output.
 * Most values are wrapped in braces, but BibTeX concatenation expressions
 * should stay raw (e.g., proc # {39th} # aaai).
 */
export function formatFieldValue(value: string): string {
  if (isConcatenationExpression(value)) {
    return value;
  }
  return `{${value}}`;
}

function isConcatenationExpression(value: string): boolean {
  // Conservative detection to avoid false positives like "C# tutorial".
  return /\s#\s/.test(value);
}

/**
 * Determine if blank lines are needed around the insertion point.
 *
 * @param lines - The lines of the file
 * @param insertLine - The line number where insertion will occur
 * @returns Object indicating whether blank lines are needed before/after
 */
export function determineBlankLines(lines: string[], insertLine: number): { needsBlankBefore: boolean; needsBlankAfter: boolean } {
  const needsBlankBefore = insertLine > 0 && lines[insertLine - 1].trim() !== '';
  const needsBlankAfter = insertLine < lines.length && lines[insertLine]?.trim() !== '';
  return { needsBlankBefore, needsBlankAfter };
}
