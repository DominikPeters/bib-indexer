/**
 * BibTeX parsing wrapper using @retorquere/bibtex-parser
 */

import * as vscode from 'vscode';
import * as bibtexParser from '@retorquere/bibtex-parser';
import { IndexedEntry, ParsedName } from './types';

/**
 * Get the list of ignored field patterns from settings
 */
function getIgnoredFieldPatterns(): string[] {
  const config = vscode.workspace.getConfiguration('tooManyBibs');
  return config.get<string[]>('ignoredFields', [
    'keywords', 'abstract', 'month', 'date-added', 'date-modified', 'bdsk-file-*'
  ]);
}

/**
 * Check if a field name matches any of the ignored patterns
 * Supports wildcards (e.g., 'bdsk-file-*' matches 'bdsk-file-1', 'bdsk-file-2', etc.)
 */
function isFieldIgnored(fieldName: string, patterns: string[]): boolean {
  const lowerField = fieldName.toLowerCase();
  for (const pattern of patterns) {
    const lowerPattern = pattern.toLowerCase();
    if (lowerPattern.includes('*')) {
      // Convert glob pattern to regex
      const regexPattern = lowerPattern
        .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
        .replace(/\*/g, '.*'); // Convert * to .*
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(lowerField)) {
        return true;
      }
    } else {
      if (lowerField === lowerPattern) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Normalize page ranges by converting en-dashes to --
 */
function normalizePages(value: string): string {
  // Replace en-dash (U+2013) and em-dash (U+2014) with --
  return value.replace(/[\u2013\u2014]/g, '--');
}


export interface ParseResult {
  entries: IndexedEntry[];
  errors: string[];
}

/**
 * Parse a BibTeX file and return indexed entries plus any errors
 */
export function parseBibFile(content: string, filePath: string): ParseResult {
  const entries: IndexedEntry[] = [];
  const errors: string[] = [];

  try {
    const result = bibtexParser.parse(content, {
      // Use raw mode to preserve LaTeX commands, math mode, braces, etc.
      // This is important for round-tripping BibTeX through the extension
      // Trade-off: institutional authors like {WHO} won't be parsed as literals,
      // but the raw author string is preserved correctly
      raw: true,
      // Override default verbatimFields to fix DOI parsing with raw mode
      verbatimFields: [],
      // Handle parsing errors gracefully (collect them)
      errorHandler: (err) => {
        errors.push(err.message);
      },
    });

    // Also collect errors from the parser result
    if (result.errors && result.errors.length > 0) {
      for (const err of result.errors) {
        const location = err.line ? ` (line ${err.line})` : '';
        errors.push(`${err.message}${location}`);
      }
    }

    // Build a map of entry key to line positions
    const entryPositions = findEntryPositions(content);
    const rawFieldExpressions = buildRawFieldExpressionMap(content);
    const ignoredPatterns = getIgnoredFieldPatterns();

    for (const entry of result.entries) {
      const position = entryPositions.get(entry.key.toLowerCase()) ?? { start: 0, end: 0 };
      const rawExpressionsForEntry = rawFieldExpressions.get(entry.key.toLowerCase());

      // Convert fields from string[] to string
      // Some fields (like author) may be split into arrays by the parser
      const fields: Record<string, string> = {};
      for (const [key, values] of Object.entries(entry.fields ?? {})) {
        // Skip ignored fields
        if (isFieldIgnored(key, ignoredPatterns)) {
          continue;
        }

        // Preserve original BibTeX expressions for concatenated fields
        // (e.g., proc # {38th} # neurips) because parser output flattens away '#'
        const rawExpression = rawExpressionsForEntry?.get(key.toLowerCase());
        if (rawExpression) {
          fields[key] = rawExpression;
          continue;
        }

        if (values.length > 0) {
          // Join multiple values - for author this preserves "A and B and C"
          let value = values.join(' and ');
          // Normalize page ranges (en-dash to --)
          if (key.toLowerCase() === 'pages') {
            value = normalizePages(value);
          }
          fields[key] = value;
        }
      }

      // Extract parsed creator information
      const creators: { author?: ParsedName[]; editor?: ParsedName[] } = {};
      if (entry.creators?.author && entry.creators.author.length > 0) {
        creators.author = entry.creators.author.map(convertName);
      }
      if (entry.creators?.editor && entry.creators.editor.length > 0) {
        creators.editor = entry.creators.editor.map(convertName);
      }

      // Extract key fields for normalization
      const title = fields.title ?? '';
      const doi = fields.doi?.trim();

      // Use parsed creators for author normalization (more reliable than string parsing)
      const authorNorm = normalizeAuthorsFromCreators(creators.author ?? creators.editor ?? []);

      const indexed: IndexedEntry = {
        file: filePath,
        key: entry.key,
        entryType: entry.type.toLowerCase(),
        startLine: position.start,
        endLine: position.end,
        fields,
        creators,
        titleFilter: normalizeForFilter(title),
        titleCluster: normalizeForCluster(title),
        authorNorm,
        doi: doi || undefined,
      };

      entries.push(indexed);
    }
  } catch (error) {
    // Capture fatal parsing errors
    const errorMessage = error instanceof Error ? error.message : String(error);
    errors.push(`Fatal error: ${errorMessage}`);
  }

  return { entries, errors };
}

/**
 * Find the start and end line numbers of each entry in the file
 */
function findEntryPositions(content: string): Map<string, { start: number; end: number }> {
  const positions = new Map<string, { start: number; end: number }>();
  const lines = content.split('\n');

  // Regex to match entry start: @type{key, or @type{key (with optional whitespace)
  const entryStartRegex = /^\s*@\w+\s*\{\s*([^,\s]+)/i;

  let currentKey: string | null = null;
  let currentStart = 0;
  let braceDepth = 0;
  let inEntry = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1; // 1-indexed

    if (!inEntry) {
      const match = line.match(entryStartRegex);
      if (match) {
        currentKey = match[1].toLowerCase();
        currentStart = lineNum;
        inEntry = true;
        // Count braces on this line
        braceDepth = countBraces(line);
      }
    } else {
      braceDepth += countBraces(line);

      if (braceDepth <= 0) {
        // Entry ended
        if (currentKey) {
          positions.set(currentKey, { start: currentStart, end: lineNum });
        }
        inEntry = false;
        currentKey = null;
        braceDepth = 0;
      }
    }
  }

  // Handle unclosed entry at end of file
  if (inEntry && currentKey) {
    positions.set(currentKey, { start: currentStart, end: lines.length });
  }

  return positions;
}

/**
 * Count net braces in a line (opening minus closing)
 */
function countBraces(line: string): number {
  let count = 0;
  let inString = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    // Handle string literals (simplified - doesn't handle all edge cases)
    if (char === '"' && (i === 0 || line[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '{') {count++;}
      else if (char === '}') {count--;}
    }
  }

  return count;
}

/**
 * Normalize title for filtering (lenient matching)
 * - Lowercase
 * - Remove braces
 * - Remove punctuation
 */
export function normalizeForFilter(title: string): string {
  return title
    .toLowerCase()
    .replace(/[{}]/g, '')           // Remove braces
    .replace(/[^\w\s]/g, ' ')       // Replace punctuation with space
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim();
}

/**
 * Normalize title for clustering (stricter - preserves braces)
 * - Lowercase
 * - Keep braces (they affect capitalization in output)
 * - Remove other punctuation
 */
export function normalizeForCluster(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s{}]/g, ' ')     // Keep braces, replace other punctuation
    .replace(/\s+/g, ' ')           // Collapse whitespace
    .trim();
}

/**
 * Extract plain name from potentially braced/accented text
 */
function extractPlainName(name: string): string {
  return name
    .replace(/[{}\\]/g, '')           // Remove braces and backslashes
    .replace(/['"`^~=.]/g, '')        // Remove accent markers
    .replace(/[^\w\s-]/g, '')         // Keep only word chars, spaces, hyphens
    .trim();
}

/**
 * Convert bibtex-parser Name to our ParsedName type
 */
function convertName(name: bibtexParser.Name): ParsedName {
  return {
    literal: name.literal,
    lastName: name.lastName,
    firstName: name.firstName,
    prefix: name.prefix,
    suffix: name.suffix,
  };
}

/**
 * Normalize authors using parsed creator data (more reliable than string parsing)
 * Returns sorted last names for matching
 */
export function normalizeAuthorsFromCreators(creators: ParsedName[]): string {
  if (creators.length === 0) return '';

  const lastNames = creators.map(c => {
    if (c.literal) {
      // Institutional name - use as-is but cleaned
      return extractPlainName(c.literal);
    }
    if (c.lastName) {
      return extractPlainName(c.lastName);
    }
    return '';
  });

  return lastNames
    .filter(n => n.length > 0)
    .map(n => n.toLowerCase())
    .sort()
    .join(' ');
}

function buildRawFieldExpressionMap(content: string): Map<string, Map<string, string>> {
  const expressionMap = new Map<string, Map<string, string>>();
  const lines = content.split('\n');
  const entryStartRegex = /^\s*@\w+\s*\{\s*([^,\s]+)/i;
  const fieldStartRegex = /^\s*([A-Za-z][\w:-]*)\s*=\s*(.+),\s*$/;

  let inEntry = false;
  let entryKey: string | null = null;
  let braceDepth = 0;

  for (const line of lines) {
    if (!inEntry) {
      const match = line.match(entryStartRegex);
      if (!match) {
        continue;
      }
      inEntry = true;
      entryKey = match[1].toLowerCase();
      braceDepth = countBraces(line);
      if (braceDepth <= 0) {
        inEntry = false;
        entryKey = null;
        braceDepth = 0;
      }
      continue;
    }

    if (entryKey) {
      const fieldMatch = line.match(fieldStartRegex);
      if (fieldMatch && hasTopLevelConcatenation(fieldMatch[2])) {
        const fieldName = fieldMatch[1].toLowerCase();
        const rawValue = fieldMatch[2].trim();
        const fields = expressionMap.get(entryKey) ?? new Map<string, string>();
        fields.set(fieldName, rawValue);
        expressionMap.set(entryKey, fields);
      }
    }

    braceDepth += countBraces(line);
    if (braceDepth <= 0) {
      inEntry = false;
      entryKey = null;
      braceDepth = 0;
    }
  }

  return expressionMap;
}

function hasTopLevelConcatenation(value: string): boolean {
  let braceDepth = 0;
  let inString = false;

  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '"' && (i === 0 || value[i - 1] !== '\\')) {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      continue;
    }
    if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      continue;
    }
    if (ch === '#' && braceDepth === 0) {
      return true;
    }
  }

  return false;
}
