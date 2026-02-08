/**
 * Utility functions for inserting BibTeX entries into files
 */

import { IndexedEntry, CANONICAL_FIELD_ORDER } from './types';

/**
 * Find the line number where a new entry should be inserted.
 *
 * @param lines - The lines of the current file
 * @param currentEntry - The entry at the cursor position (if any)
 * @returns The 0-indexed line number where the entry should be inserted
 */
export function findEntryInsertionPoint(lines: string[], currentEntry: { endLine?: number } | null): number {
  // If we have a current entry, insert after it
  if (currentEntry && currentEntry.endLine) {
    return currentEntry.endLine; // endLine is 1-indexed, so this gives us the line after
  }

  // Otherwise, find the last entry in the file and insert after it
  let lastEntryEnd = -1;
  let inEntry = false;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for entry start
    if (!inEntry && /^\s*@\w+\s*\{/i.test(line)) {
      inEntry = true;
      braceDepth = 0;
    }

    if (inEntry) {
      // Count braces
      for (const char of line) {
        if (char === '{') braceDepth++;
        if (char === '}') braceDepth--;
      }

      // Entry ends when braces are balanced
      if (braceDepth <= 0) {
        lastEntryEnd = i + 1; // Line after the closing brace
        inEntry = false;
      }
    }
  }

  // If we found entries, insert after the last one
  if (lastEntryEnd >= 0) {
    return lastEntryEnd;
  }

  // Otherwise, insert at end of file
  return lines.length;
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
