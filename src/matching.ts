/**
 * Entry matching and clustering logic
 */

import { IndexedEntry, EntryCluster, EntryVariant } from './types';

/**
 * Find entries that match a given entry
 * Uses DOI for high-confidence matching, title+author for fuzzy matching
 */
export function findMatches(
  entry: IndexedEntry,
  allEntries: IndexedEntry[],
  threshold: number = 0.85
): IndexedEntry[] {
  const matches: IndexedEntry[] = [];

  for (const candidate of allEntries) {
    // Skip self
    if (candidate.file === entry.file && candidate.key === entry.key) {
      continue;
    }

    // DOI match = high confidence
    if (entry.doi && candidate.doi && entry.doi === candidate.doi) {
      matches.push(candidate);
      continue;
    }

    // Title + Author similarity
    const titleSim = similarity(entry.titleFilter, candidate.titleFilter);
    const authorSim = similarity(entry.authorNorm, candidate.authorNorm);

    // Both title and author should be similar
    if (titleSim >= threshold && authorSim >= threshold) {
      matches.push(candidate);
    }
  }

  return matches;
}

/**
 * Group matching entries into clusters
 * Entries in the same cluster represent the same bibliographic work
 */
export function clusterMatches(
  currentEntry: IndexedEntry,
  matches: IndexedEntry[]
): EntryCluster | null {
  if (matches.length === 0) {
    return null;
  }

  // All entries in the cluster (including current)
  const allEntries = [currentEntry, ...matches];

  // Group into variants based on titleCluster (preserves braces) and field set
  const variantMap = new Map<string, IndexedEntry[]>();

  for (const entry of allEntries) {
    const variantKey = computeVariantKey(entry);
    const existing = variantMap.get(variantKey) ?? [];
    existing.push(entry);
    variantMap.set(variantKey, existing);
  }

  const variants: EntryVariant[] = [];
  for (const entries of variantMap.values()) {
    const representative = entries[0];
    const fieldSet = Object.keys(representative.fields).sort();

    variants.push({
      files: entries.map(e => e.file),
      representative,
      fieldSet,
      titleCluster: representative.titleCluster,
    });
  }

  // Use first match for display info (or current entry)
  const displayEntry = matches[0] ?? currentEntry;

  return {
    displayTitle: displayEntry.fields.title ?? '(untitled)',
    displayAuthor: displayEntry.fields.author ?? displayEntry.fields.editor ?? '(unknown)',
    year: displayEntry.fields.year,
    doi: displayEntry.doi ?? currentEntry.doi,
    entries: allEntries,
    variants,
  };
}

/**
 * Compute a key that identifies a variant
 * Same key = same variant (modulo file)
 */
function computeVariantKey(entry: IndexedEntry): string {
  // Variant key includes:
  // - Normalized title with braces (titleCluster)
  // - Sorted list of fields present

  const fieldList = Object.keys(entry.fields).sort().join(',');
  return `${entry.titleCluster}|${fieldList}`;
}

/**
 * Calculate similarity between two strings using normalized Levenshtein distance
 * Returns a value between 0 and 1 (1 = identical)
 */
export function similarity(a: string, b: string): number {
  if (a === b) {return 1;}
  if (a.length === 0 || b.length === 0) {return 0;}

  const distance = levenshteinDistance(a, b);
  const maxLen = Math.max(a.length, b.length);

  return 1 - distance / maxLen;
}

/**
 * Compute Levenshtein edit distance between two strings
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;

  // Use two-row approach for memory efficiency
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);

  // Initialize first row
  for (let j = 0; j <= n; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= m; i++) {
    curr[0] = i;

    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,      // deletion
        curr[j - 1] + 1,  // insertion
        prev[j - 1] + cost // substitution
      );
    }

    [prev, curr] = [curr, prev];
  }

  return prev[n];
}

/**
 * Compare two entries and return the fields that differ
 */
export function compareFields(
  current: IndexedEntry,
  other: IndexedEntry
): FieldComparison[] {
  const comparisons: FieldComparison[] = [];
  const allFields = new Set([
    ...Object.keys(current.fields),
    ...Object.keys(other.fields),
  ]);

  for (const field of allFields) {
    const currentValue = current.fields[field];
    const otherValue = other.fields[field];

    if (currentValue === otherValue) {
      // Same value - no action needed
      comparisons.push({
        field,
        current: currentValue,
        other: otherValue,
        status: 'same',
      });
    } else if (!currentValue && otherValue) {
      // Missing in current, present in other
      comparisons.push({
        field,
        current: undefined,
        other: otherValue,
        status: 'missing',
      });
    } else if (currentValue && !otherValue) {
      // Present in current, missing in other
      comparisons.push({
        field,
        current: currentValue,
        other: undefined,
        status: 'extra',
      });
    } else {
      // Both have values but they differ
      comparisons.push({
        field,
        current: currentValue,
        other: otherValue,
        status: 'different',
      });
    }
  }

  return comparisons;
}

export interface FieldComparison {
  field: string;
  current?: string;
  other?: string;
  status: 'same' | 'missing' | 'extra' | 'different';
}
