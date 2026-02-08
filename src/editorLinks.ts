import * as vscode from 'vscode';

export type BibLinkField = 'url' | 'doi' | 'arxiv';

export interface DetectedBibLink {
  field: BibLinkField;
  line: number;
  startCharacter: number;
  endCharacter: number;
  target: string;
}

interface ParsedValue {
  rawValue: string;
  startCharacter: number;
  endCharacter: number;
  nextIndex: number;
}

interface PendingEprint {
  line: number;
  startCharacter: number;
  endCharacter: number;
  rawValue: string;
}

const DOI_REGEX = /^10\.\d{4,9}\/\S+$/i;
const ARXIV_NEW_STYLE_REGEX = /^\d{4}\.\d{4,5}(v\d+)?$/i;
const ARXIV_OLD_STYLE_REGEX = /^[a-z-]+(?:\.[a-z-]+)?\/\d{7}(v\d+)?$/i;

export class BibDocumentLinkProvider implements vscode.DocumentLinkProvider {
  provideDocumentLinks(document: vscode.TextDocument): vscode.DocumentLink[] {
    const matches = detectBibFieldLinks(document.getText());

    return matches.map(match => {
      const range = new vscode.Range(
        new vscode.Position(match.line, match.startCharacter),
        new vscode.Position(match.line, match.endCharacter)
      );
      const link = new vscode.DocumentLink(range, vscode.Uri.parse(match.target));
      link.tooltip = getTooltipForField(match.field);
      return link;
    });
  }
}

export function detectBibFieldLinks(text: string): DetectedBibLink[] {
  const links: DetectedBibLink[] = [];
  const lines = text.split(/\r?\n/);
  let previousFieldName: string | null = null;
  let previousFieldValue: string | null = null;
  let pendingEprint: PendingEprint | null = null;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%')) {
      previousFieldName = null;
      previousFieldValue = null;
      pendingEprint = null;
      continue;
    }

    const fieldMatch = line.match(/^\s*([A-Za-z][\w:-]*)\s*=\s*/);
    if (!fieldMatch) {
      previousFieldName = null;
      previousFieldValue = null;
      pendingEprint = null;
      continue;
    }

    const field = fieldMatch[1].toLowerCase();
    const valueStart = fieldMatch[0].length;
    const parsedValue = parseSingleLineValue(line, valueStart);
    if (!parsedValue) {
      previousFieldName = null;
      previousFieldValue = null;
      pendingEprint = null;
      continue;
    }

    const tail = line.slice(parsedValue.nextIndex);
    if (!isValidTail(tail)) {
      previousFieldName = null;
      previousFieldValue = null;
      pendingEprint = null;
      continue;
    }

    if (field === 'url' || field === 'doi') {
      const normalized = field === 'url'
        ? normalizeUrlValue(parsedValue.rawValue)
        : normalizeDoiValue(parsedValue.rawValue);

      if (normalized) {
        links.push({
          field,
          line: lineIndex,
          startCharacter: parsedValue.startCharacter,
          endCharacter: parsedValue.endCharacter,
          target: normalized,
        });
      }
    }

    if (field === 'eprint') {
      pendingEprint = {
        line: lineIndex,
        startCharacter: parsedValue.startCharacter,
        endCharacter: parsedValue.endCharacter,
        rawValue: parsedValue.rawValue,
      };

      if (previousFieldName === 'archiveprefix' && isArxivPrefix(previousFieldValue)) {
        const arxivTarget = normalizeArxivValue(parsedValue.rawValue);
        if (arxivTarget) {
          links.push({
            field: 'arxiv',
            line: lineIndex,
            startCharacter: parsedValue.startCharacter,
            endCharacter: parsedValue.endCharacter,
            target: arxivTarget,
          });
          pendingEprint = null;
        }
      }
    } else if (field === 'archiveprefix') {
      if (pendingEprint && previousFieldName === 'eprint' && isArxivPrefix(parsedValue.rawValue)) {
        const arxivTarget = normalizeArxivValue(pendingEprint.rawValue);
        if (arxivTarget) {
          links.push({
            field: 'arxiv',
            line: pendingEprint.line,
            startCharacter: pendingEprint.startCharacter,
            endCharacter: pendingEprint.endCharacter,
            target: arxivTarget,
          });
        }
      }
      pendingEprint = null;
    } else {
      pendingEprint = null;
    }

    previousFieldName = field;
    previousFieldValue = parsedValue.rawValue;
  }

  return links;
}

export function normalizeUrlValue(raw: string): string | null {
  const value = raw.trim();
  if (!/^https?:\/\//i.test(value)) {
    return null;
  }

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function normalizeDoiValue(raw: string): string | null {
  let value = raw.trim();

  if (/^doi:/i.test(value)) {
    value = value.replace(/^doi:\s*/i, '');
  }

  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (!/^(?:www\.)?(?:dx\.)?doi\.org$/i.test(parsed.hostname)) {
        return null;
      }
      value = parsed.pathname.replace(/^\/+/, '');
    } catch {
      return null;
    }
  }

  value = value.trim();
  if (!DOI_REGEX.test(value)) {
    return null;
  }

  return `https://doi.org/${value}`;
}

export function normalizeArxivValue(raw: string): string | null {
  let value = raw.trim();
  value = value.replace(/^arxiv:\s*/i, '');
  value = value.trim();

  if (!ARXIV_NEW_STYLE_REGEX.test(value) && !ARXIV_OLD_STYLE_REGEX.test(value)) {
    return null;
  }

  return `https://arxiv.org/abs/${value}`;
}

function isArxivPrefix(raw: string | null): boolean {
  return raw?.trim().toLowerCase() === 'arxiv';
}

function parseSingleLineValue(line: string, startIndex: number): ParsedValue | null {
  let index = startIndex;
  while (index < line.length && /\s/.test(line[index])) {
    index++;
  }

  if (index >= line.length) {
    return null;
  }

  if (line[index] === '{') {
    return parseBracedValue(line, index);
  }

  if (line[index] === '"') {
    return parseQuotedValue(line, index);
  }

  return parseBareValue(line, index);
}

function parseBracedValue(line: string, openBraceIndex: number): ParsedValue | null {
  let depth = 1;
  for (let i = openBraceIndex + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return {
          rawValue: line.slice(openBraceIndex + 1, i),
          startCharacter: openBraceIndex + 1,
          endCharacter: i,
          nextIndex: i + 1,
        };
      }
    }
  }
  return null;
}

function parseQuotedValue(line: string, openQuoteIndex: number): ParsedValue | null {
  for (let i = openQuoteIndex + 1; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && line[i - 1] !== '\\') {
      return {
        rawValue: line.slice(openQuoteIndex + 1, i),
        startCharacter: openQuoteIndex + 1,
        endCharacter: i,
        nextIndex: i + 1,
      };
    }
  }
  return null;
}

function parseBareValue(line: string, startIndex: number): ParsedValue | null {
  let endIndex = startIndex;
  while (endIndex < line.length && !/[\s,]/.test(line[endIndex])) {
    endIndex++;
  }

  if (endIndex === startIndex) {
    return null;
  }

  return {
    rawValue: line.slice(startIndex, endIndex),
    startCharacter: startIndex,
    endCharacter: endIndex,
    nextIndex: endIndex,
  };
}

function isValidTail(tail: string): boolean {
  return /^\s*,?\s*(%.*)?$/.test(tail);
}

function getTooltipForField(field: BibLinkField): string {
  if (field === 'url') {
    return 'Open URL';
  }
  if (field === 'doi') {
    return 'Open DOI';
  }
  return 'Open arXiv';
}
