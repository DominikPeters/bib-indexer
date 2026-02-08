/**
 * Entry matching, clustering, and super card merging logic
 */

import { IndexedEntry, ParsedName, SuperCard, PaperCluster } from './types';

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

    if (entriesMatch(entry, candidate, threshold)) {
      matches.push(candidate);
    }
  }

  return matches;
}

/**
 * Check if two entries represent the same paper
 */
function entriesMatch(a: IndexedEntry, b: IndexedEntry, threshold: number): boolean {
  // DOI match = high confidence
  if (a.doi && b.doi && a.doi === b.doi) {
    return true;
  }

  // Title + Author similarity
  const titleSim = similarity(a.titleFilter, b.titleFilter);
  const authorSim = similarity(a.authorNorm, b.authorNorm);

  return titleSim >= threshold && authorSim >= threshold;
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

// ── Quality scoring ──────────────────────────────────────────────

/**
 * Compute a quality score for an entry (higher = better).
 * Used to determine which entry seeds a super card.
 */
export function computeQualityScore(entry: IndexedEntry): number {
  let score = 0;

  // +1 point per field
  score += Object.keys(entry.fields).length;

  // +2 extra points for DOI
  if (entry.fields.doi) {
    score += 2;
  }

  // +1 extra point for URL
  if (entry.fields.url) {
    score += 1;
  }

  // +2 points for full first names (not just initials)
  const creators = entry.creators?.author ?? entry.creators?.editor ?? [];
  if (hasFullFirstNames(creators)) {
    score += 2;
  }

  // +0.5 * year to prioritize newer versions
  const year = parseInt(entry.fields.year ?? '', 10);
  if (!isNaN(year)) {
    score += 0.5 * year;
  }

  return score;
}

export function hasFullFirstNames(creators: { firstName?: string; literal?: string }[]): boolean {
  if (creators.length === 0) return false;

  for (const creator of creators) {
    // Skip institutional names (literal)
    if (creator.literal) continue;

    const firstName = creator.firstName ?? '';
    if (!firstName) return false;

    // Check if firstName looks like initials only
    const parts = firstName.split(/[\s.]+/).filter(p => p.length > 0);
    const allInitials = parts.every(part => {
      const cleaned = part.replace(/[{}]/g, '');
      return cleaned.length <= 2;
    });

    if (allInitials) {
      return false;
    }
  }

  return true;
}

// ── Super card merging ───────────────────────────────────────────

/**
 * Check if an entry's fields are compatible with a super card's fields.
 * Compatible means: for every field present in both, values are identical.
 */
export function areFieldsCompatible(
  cardFields: Record<string, string>,
  entryFields: Record<string, string>
): boolean {
  for (const key of Object.keys(entryFields)) {
    if (key in cardFields && cardFields[key] !== entryFields[key]) {
      return false;
    }
  }
  return true;
}

/**
 * Build super cards from a list of entries by greedy merging.
 * Entries are processed in quality-score order (best first).
 * Compatible entries (no conflicting field values) are merged into a single card
 * with the union of their fields.
 */
export function buildSuperCards(entries: IndexedEntry[]): SuperCard[] {
  if (entries.length === 0) return [];

  // Sort by quality score descending
  const sorted = [...entries].sort(
    (a, b) => computeQualityScore(b) - computeQualityScore(a)
  );

  const superCards: SuperCard[] = [];

  for (const entry of sorted) {
    let merged = false;

    for (const card of superCards) {
      // Only merge entries of the same BibTeX type.
      if (card.entryType === entry.entryType && areFieldsCompatible(card.fields, entry.fields)) {
        // Merge: add entry's unique fields to the card
        for (const [key, value] of Object.entries(entry.fields)) {
          if (!(key in card.fields)) {
            card.fields[key] = value;
          }
        }
        card.sourceEntries.push(entry);
        merged = true;
        break;
      }
    }

    if (!merged) {
      // Seed a new super card
      superCards.push({
        fields: { ...entry.fields },
        entryType: entry.entryType,
        key: entry.key,
        creators: entry.creators,
        sourceEntries: [entry],
        qualityScore: computeQualityScore(entry),
      });
    }
  }

  return superCards;
}

// ── Paper identity clustering ────────────────────────────────────

/**
 * Cluster entries by paper identity using union-find.
 * Two entries are in the same cluster if they share a DOI or have
 * title+author similarity >= threshold.
 */
export function clusterByPaperIdentity(
  entries: IndexedEntry[],
  threshold: number = 0.85
): IndexedEntry[][] {
  if (entries.length === 0) return [];

  const n = entries.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const rank = new Array(n).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(x: number, y: number): void {
    const rx = find(x);
    const ry = find(y);
    if (rx === ry) return;
    if (rank[rx] < rank[ry]) { parent[rx] = ry; }
    else if (rank[rx] > rank[ry]) { parent[ry] = rx; }
    else { parent[ry] = rx; rank[rx]++; }
  }

  // First pass: group by DOI (O(n))
  const doiMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const doi = entries[i].doi;
    if (doi) {
      const existing = doiMap.get(doi);
      if (existing !== undefined) {
        union(i, existing);
      } else {
        doiMap.set(doi, i);
      }
    }
  }

  // Second pass: pairwise title+author similarity (O(n^2))
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (find(i) === find(j)) continue; // already clustered
      if (entriesMatch(entries[i], entries[j], threshold)) {
        union(i, j);
      }
    }
  }

  // Collect clusters
  const clusters = new Map<number, IndexedEntry[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const cluster = clusters.get(root) ?? [];
    cluster.push(entries[i]);
    clusters.set(root, cluster);
  }

  return Array.from(clusters.values());
}

/**
 * Top-level: cluster entries by paper identity, then build super cards within each cluster.
 */
export function buildPaperClusters(
  entries: IndexedEntry[],
  threshold: number = 0.85
): PaperCluster[] {
  const clusters = clusterByPaperIdentity(entries, threshold);

  return clusters.map(clusterEntries => {
    const superCards = buildSuperCards(clusterEntries);
    const best = superCards[0]; // highest quality score
    return {
      displayTitle: best.fields.title ?? '(untitled)',
      displayAuthor: best.fields.author ?? best.fields.editor ?? '(unknown)',
      year: best.fields.year,
      doi: clusterEntries.find(e => e.doi)?.doi,
      superCards,
      totalEntries: clusterEntries.length,
    };
  });
}
