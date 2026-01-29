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
 * A cluster of similar entries (same bibliographic work across files)
 */
export interface EntryCluster {
  // Representative info for display
  displayTitle: string;
  displayAuthor: string;
  year?: string;
  doi?: string;

  // All entries in this cluster
  entries: IndexedEntry[];

  // Distinct variants (entries with different field sets or brace usage)
  variants: EntryVariant[];
}

/**
 * A variant within a cluster (distinct version of the same work)
 */
export interface EntryVariant {
  // Which files contain this exact variant
  files: string[];

  // Representative entry (one of the files)
  representative: IndexedEntry;

  // What makes this variant distinct
  fieldSet: string[];     // Sorted list of field names
  titleCluster: string;   // Normalized title with braces preserved
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
