/**
 * FlexSearch-based search index for fast search and duplicate detection
 */

import FlexSearch from 'flexsearch';
import { IndexedEntry } from './types';

/**
 * Search result from FlexSearch with enrichment
 */
interface SearchResult {
  id: number;
  doc: IndexedEntry;
}

/**
 * Extended entry type with combined search field
 */
interface SearchableEntry extends IndexedEntry {
  id: number;
  searchText: string; // Combined field for cross-field AND matching
}

/**
 * Manages a FlexSearch index for fast full-text search across bibliography entries
 */
export class SearchIndexManager {
  private index: FlexSearch.Document<SearchableEntry, true>;
  private entries: IndexedEntry[] = [];
  private entryIdMap: Map<string, number> = new Map(); // file:key -> id
  private doiMap: Map<string, number[]> = new Map(); // doi -> entry indices

  constructor() {
    this.index = this.createIndex();
  }

  private createIndex(): FlexSearch.Document<SearchableEntry, true> {
    return new FlexSearch.Document<SearchableEntry, true>({
      document: {
        id: 'id',
        index: ['searchText', 'titleFilter'], // searchText for general search, titleFilter for duplicate detection
        store: true,
      },
      tokenize: 'forward',
      cache: 100,
      resolution: 9,
    });
  }

  /**
   * Rebuild the entire index from a list of entries
   * Called after loading index from disk or after full reindex
   */
  rebuild(entries: IndexedEntry[]): void {
    this.index = this.createIndex();
    this.entries = entries;
    this.entryIdMap.clear();
    this.doiMap.clear();

    // Add all entries with numeric IDs
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const year = entry.fields.year ?? '';
      const journal = (entry.fields.journal ?? '').toLowerCase();
      const booktitle = (entry.fields.booktitle ?? '').toLowerCase();
      // Combined searchable text for cross-field AND matching
      const searchText = [
        entry.titleFilter,
        entry.authorNorm,
        entry.key.toLowerCase(),
        year,
        journal,
        booktitle,
      ].join(' ');

      const searchableEntry: SearchableEntry = {
        ...entry,
        id: i,
        searchText,
      };
      this.index.add(searchableEntry);
      this.entryIdMap.set(`${entry.file}:${entry.key}`, i);

      // Build DOI lookup map
      if (entry.doi) {
        const existing = this.doiMap.get(entry.doi) ?? [];
        existing.push(i);
        this.doiMap.set(entry.doi, existing);
      }
    }
  }

  /**
   * Search for entries matching a query (for the search box)
   * Uses AND semantics: all terms must match (via combined searchText field)
   * Returns entries sorted by relevance
   */
  search(query: string, limit: number = 200): IndexedEntry[] {
    if (!query || query.length < 2) {
      return [];
    }

    // Search the combined searchText field with AND semantics
    const results = this.index.search(query, {
      limit,
      enrich: true,
      bool: 'and',
      index: ['searchText'], // Search combined field for cross-field AND
    });

    // Collect all unique entry IDs
    const seenIds = new Set<number>();
    const matchedEntries: IndexedEntry[] = [];

    for (const fieldResult of results) {
      if (fieldResult.result) {
        for (const item of fieldResult.result) {
          const searchItem = item as unknown as SearchResult;
          const id = typeof searchItem === 'number' ? searchItem : searchItem.id;
          if (!seenIds.has(id) && id < this.entries.length) {
            seenIds.add(id);
            matchedEntries.push(this.entries[id]);
          }
        }
      }
    }

    return matchedEntries;
  }

  /**
   * Find candidate entries that might be duplicates of the given entry
   * Uses FlexSearch for fast candidate retrieval, then caller should apply precise matching
   */
  findDuplicateCandidates(entry: IndexedEntry, limit: number = 300): IndexedEntry[] {
    // Search by title (most discriminative for finding duplicates)
    // We want a loose search to not miss any potential duplicates
    const titleQuery = entry.titleFilter;

    if (!titleQuery || titleQuery.length < 3) {
      // Title too short for meaningful search, return empty
      // The precise matcher will still check DOI matches against all entries
      return [];
    }

    // Take first several words of the title for the query
    // This helps with prefix matching
    const queryWords = titleQuery.split(/\s+/).slice(0, 6).join(' ');

    const results = this.index.search(queryWords, {
      limit,
      enrich: true,
      index: ['titleFilter'], // Search only in title for duplicate detection
    });

    const seenIds = new Set<number>();
    const candidates: IndexedEntry[] = [];

    // Get the ID of the current entry so we can exclude it
    const currentId = this.entryIdMap.get(`${entry.file}:${entry.key}`);

    for (const fieldResult of results) {
      if (fieldResult.result) {
        for (const item of fieldResult.result) {
          const searchItem = item as unknown as SearchResult;
          const id = typeof searchItem === 'number' ? searchItem : searchItem.id;
          // Skip the entry itself and any we've already seen
          if (id !== currentId && !seenIds.has(id) && id < this.entries.length) {
            seenIds.add(id);
            candidates.push(this.entries[id]);
          }
        }
      }
    }

    return candidates;
  }

  /**
   * Get all entries that have the same DOI as the given entry
   * Uses a pre-built DOI map for O(1) lookup
   */
  findDoiMatches(entry: IndexedEntry): IndexedEntry[] {
    if (!entry.doi) {
      return [];
    }

    const indices = this.doiMap.get(entry.doi);
    if (!indices) {
      return [];
    }

    const matches: IndexedEntry[] = [];
    for (const idx of indices) {
      const candidate = this.entries[idx];
      // Exclude the entry itself
      if (!(candidate.file === entry.file && candidate.key === entry.key)) {
        matches.push(candidate);
      }
    }
    return matches;
  }
}
