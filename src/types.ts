/**
 * Core type definitions for Too Many Bibs
 */

/**
 * Represents a parsed author/editor name
 */
export interface ParsedName {
  literal?: string;       // For institutional names like "{World Health Organization}"
  lastName?: string;      // Family name
  firstName?: string;     // Given name (may include middle names/initials)
  prefix?: string;        // "von", "van der", etc.
  suffix?: string;        // "Jr.", "III", etc.
}

/**
 * Represents a parsed and indexed BibTeX entry
 */
export interface IndexedEntry {
  // Source location
  file: string;           // Absolute path to .bib file
  key: string;            // Citation key (e.g., "arrow1951")
  entryType: string;      // article, book, inproceedings, etc.
  startLine: number;      // 1-indexed line where entry begins
  endLine: number;        // 1-indexed line where entry ends

  // Raw field values (preserved exactly for display/merging)
  fields: Record<string, string>;

  // Parsed creator information
  creators: {
    author?: ParsedName[];
    editor?: ParsedName[];
  };

  // Normalized values for matching
  titleFilter: string;    // Lowercase, no braces/punctuation (for filtering)
  titleCluster: string;   // Lowercase, keeps braces (for clustering)
  authorNorm: string;     // Last names only, sorted alphabetically
  doi?: string;           // Exact DOI if present
}

/**
 * Metadata about an indexed file
 */
export interface IndexedFile {
  path: string;
  mtime: number;          // Last modified time when indexed (ms since epoch)
  entryCount: number;     // Number of entries in this file
  parseErrors?: string[]; // Any parsing errors/warnings encountered
}

/**
 * The complete index stored to disk
 */
export interface BibIndex {
  version: number;
  folders: string[];              // User-specified folders to scan
  individualFiles: string[];      // Individual files added by user (not from folders)
  excludedFiles: string[];        // Files explicitly removed by user (won't be re-added by folder scan)
  files: Record<string, IndexedFile>;
  entries: IndexedEntry[];
}

/**
 * A merged "super card": the union of compatible entries within a cluster.
 * Two entries are compatible if every field they both have has identical values.
 */
export interface SuperCard {
  fields: Record<string, string>;       // Union of merged fields
  entryType: string;                    // From seed entry
  key: string;                          // From seed entry
  creators: { author?: ParsedName[]; editor?: ParsedName[] };
  sourceEntries: IndexedEntry[];        // All contributing entries (seed first)
  qualityScore: number;
}

/**
 * A cluster of entries representing the same paper, containing one or more super cards.
 */
export interface PaperCluster {
  displayTitle: string;
  displayAuthor: string;
  year?: string;
  doi?: string;
  superCards: SuperCard[];
  totalEntries: number;
}

/**
 * Canonical field order for insertion
 */
export const CANONICAL_FIELD_ORDER = [
  'author',
  'editor',
  'title',
  'booktitle',
  'journal',
  'volume',
  'number',
  'pages',
  'year',
  'month',
  'publisher',
  'address',
  'edition',
  'doi',
  'url',
  'isbn',
  'issn',
  'note',
  'abstract',
  'keywords',
];
