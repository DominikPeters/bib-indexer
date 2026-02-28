/**
 * Unified sidebar webview provider
 */

import * as vscode from 'vscode';
import * as path from 'path';
import { BibIndexManager } from '../index';
import { IndexedEntry, SuperCard } from '../types';
import { findMatches, buildSuperCards, buildPaperClusters, computeQualityScore } from '../matching';
import { normalizeForFilter, parseBibFile } from '../parser';
import { CANONICAL_FIELD_ORDER } from '../types';
import { findEntryInsertionPoint, formatBibtex, determineBlankLines, formatFieldValue } from '../insertion';
import { computeDiff } from '../diff';
import { normalizeArxivValue, normalizeDoiValue, normalizeUrlValue } from '../editorLinks';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private currentEntry: IndexedEntry | null = null;
  private currentEditor: vscode.TextEditor | null = null;
  private documentChangeTimeout: NodeJS.Timeout | null = null;
  private parsedDocumentCache: Map<string, { version: number; entries: IndexedEntry[] }> = new Map();

  constructor(
    private extensionUri: vscode.Uri,
    private indexManager: BibIndexManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.onDidDispose(() => {
      if (this.documentChangeTimeout) {
        clearTimeout(this.documentChangeTimeout);
        this.documentChangeTimeout = null;
      }
      this._view = undefined;
    });

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlContent();

    webviewView.webview.onDidReceiveMessage(async (message) => {
      try {
        switch (message.command) {
          case 'search':
            this.handleSearch(message.query);
            break;

          case 'copyEntry':
            await this.handleCopyEntry(message.file, message.key);
            break;

          case 'insertField':
            await this.handleInsertField(message.file, message.key, message.field);
            break;

          case 'insertFieldValue':
            await this.handleInsertFieldValue(message.field, message.value);
            break;

          case 'insertEntry':
            await this.handleInsertEntry(message.file, message.key);
            break;

          case 'copySuperCard':
            await this.handleCopySuperCard(message.fields, message.entryType, message.key);
            break;

          case 'insertSuperCard':
            await this.handleInsertSuperCard(message.fields, message.entryType, message.key);
            break;

          case 'showManageFiles':
            this.sendFileManagementData();
            break;

          case 'hideManageFiles':
            this.updateMatches();
            break;

          case 'addFolder':
            await vscode.commands.executeCommand('tooManyBibs.addFolder');
            break;

          case 'addFile':
            const fileUri = await vscode.window.showOpenDialog({
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: false,
              filters: { 'BibTeX files': ['bib'] },
              openLabel: 'Add File to Index',
            });
            if (fileUri && fileUri.length > 0) {
              await this.indexManager.addFile(fileUri[0].fsPath);
              this.sendFileManagementData();
              this.refresh();
            }
            break;

          case 'reindex':
            await vscode.commands.executeCommand('tooManyBibs.reindex');
            break;

          case 'removeFile':
            this.indexManager.removeFile(message.file);
            this.sendFileManagementData();
            this.refresh();
            break;

          case 'removeFolder':
            await this.indexManager.removeFolder(message.folder);
            this.sendFileManagementData();
            this.refresh();
            break;

          case 'showFilesModal':
            this.sendFilesModalData(message.entries);
            break;

          case 'openFile':
            await this.handleOpenFile(message.file, message.line);
            break;

          case 'openExternal':
            await this.handleOpenExternal(message.url);
            break;

          case 'ready':
            this.sendStatus();
            this.updateMatches();
            break;
        }
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        vscode.window.showErrorMessage(`Too Many Bibs: ${messageText}`);
      }
    });
  }

  private async handleOpenFile(filePath: string, line?: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, { preview: true });

      if (line !== undefined && line > 0) {
        const position = new vscode.Position(line - 1, 0); // Convert 1-indexed to 0-indexed
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Could not open file: ${filePath}`);
    }
  }

  private async handleOpenExternal(url: string): Promise<void> {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
    } catch {
      // Ignore invalid external URL requests from the webview
    }
  }

  refresh(): void {
    this.sendStatus();
    this.updateMatches();
  }

  sendProgress(phase: string, current: number, total: number): void {
    if (!this._view) return;
    this._view.webview.postMessage({
      command: 'indexProgress',
      phase,
      current,
      total,
    });
  }

  getCurrentEntry(): IndexedEntry | null {
    return this.currentEntry;
  }

  clearCurrentEntry(): void {
    this.currentEntry = null;
    this.currentEditor = null;
    this.updateMatches();
  }

  onCursorMoved(editor: vscode.TextEditor): void {
    this.currentEditor = editor;
    const document = editor.document;
    const position = editor.selection.active;

    try {
      const uri = document.uri.toString();
      const cached = this.parsedDocumentCache.get(uri);
      let entries: IndexedEntry[];

      if (cached && cached.version === document.version) {
        entries = cached.entries;
      } else {
        const content = document.getText();
        const result = parseBibFile(content, document.uri.fsPath);
        entries = result.entries;
        this.parsedDocumentCache.set(uri, { version: document.version, entries });
      }

      const lineNum = position.line + 1;
      const entry = entries.find(e => lineNum >= e.startLine && lineNum <= e.endLine);

      if (entry?.key !== this.currentEntry?.key || entry?.file !== this.currentEntry?.file) {
        this.currentEntry = entry ?? null;
        this.updateMatches();
      }
    } catch (error) {
      console.error('Error parsing bib file for cursor tracking:', error);
    }
  }

  onDocumentChanged(document: vscode.TextDocument): void {
    if (this.documentChangeTimeout) {
      clearTimeout(this.documentChangeTimeout);
    }
    this.documentChangeTimeout = setTimeout(() => {
      if (this.currentEditor?.document === document) {
        this.onCursorMoved(this.currentEditor);
      }
    }, 500);
  }

  private sendStatus(): void {
    if (!this._view) return;

    const files = this.indexManager.getFiles();
    const folders = this.indexManager.getFolders();
    const entryCount = this.indexManager.getEntries().length;

    this._view.webview.postMessage({
      command: 'status',
      folders: folders.length,
      files: Object.keys(files).length,
      entries: entryCount,
    });
  }

  private sendFileManagementData(): void {
    if (!this._view) return;

    const folders = this.indexManager.getFolders();
    const files = this.indexManager.getFiles();
    const individualFiles = this.indexManager.getIndividualFiles();

    const filesByFolder: Record<string, { path: string; name: string; entryCount: number; parseErrors?: string[] }[]> = {};

    for (const folder of folders) {
      filesByFolder[folder] = [];
    }
    filesByFolder['_individual'] = [];

    for (const [filePath, fileInfo] of Object.entries(files)) {
      let assigned = false;
      for (const folder of folders) {
        if (filePath.startsWith(folder + path.sep)) {
          filesByFolder[folder].push({
            path: filePath,
            name: path.relative(folder, filePath),
            entryCount: fileInfo.entryCount,
            parseErrors: fileInfo.parseErrors,
          });
          assigned = true;
          break;
        }
      }
      if (!assigned || individualFiles.includes(filePath)) {
        filesByFolder['_individual'].push({
          path: filePath,
          name: path.basename(filePath),
          entryCount: fileInfo.entryCount,
          parseErrors: fileInfo.parseErrors,
        });
      }
    }

    this._view.webview.postMessage({
      command: 'fileManagementData',
      folders,
      filesByFolder,
    });
  }

  private sendFilesModalData(entryKeys: { file: string; key: string }[]): void {
    if (!this._view) return;

    const allEntries = this.indexManager.getEntries();
    const matchedEntries = entryKeys.map(ek =>
      allEntries.find(e => e.file === ek.file && e.key === ek.key)
    ).filter(Boolean) as IndexedEntry[];

    // Send full entry data for each file
    const data = matchedEntries.map(e => ({
      file: e.file,
      fileName: path.basename(e.file),
      key: e.key,
      entryType: e.entryType,
      startLine: e.startLine,
      fields: Object.entries(e.fields).map(([name, value]) => ({ name, value })),
    }));

    this._view.webview.postMessage({
      command: 'filesModalData',
      entries: data,
    });
  }

  private updateMatches(): void {
    if (!this._view) return;

    if (!this.currentEntry) {
      this._view.webview.postMessage({
        command: 'matches',
        currentEntry: null,
        matches: [],
      });
      return;
    }

    const config = vscode.workspace.getConfiguration('tooManyBibs');
    const threshold = config.get<number>('similarityThreshold') ?? 0.85;
    const searchIndex = this.indexManager.getSearchIndex();

    // Use FlexSearch to get candidate entries with similar titles
    const candidates = searchIndex.findDuplicateCandidates(this.currentEntry, 300);

    // Also get exact DOI matches (these might not be in the title-based candidates)
    const doiMatches = searchIndex.findDoiMatches(this.currentEntry);

    // Combine candidates and DOI matches, removing duplicates
    const candidateSet = new Set(candidates);
    for (const match of doiMatches) {
      candidateSet.add(match);
    }
    const allCandidates = Array.from(candidateSet);

    // Now apply precise matching on the pre-filtered candidates
    const matches = findMatches(this.currentEntry, allCandidates, threshold);

    // Build super cards from matches (greedy merge of compatible entries)
    const superCards = buildSuperCards(matches);
    const displayMatches = superCards.map(card =>
      this.formatSuperCardForDisplay(card, this.currentEntry)
    );

    this._view.webview.postMessage({
      command: 'matches',
      currentEntry: this.formatEntryForDisplay(this.currentEntry),
      matches: displayMatches,
    });
  }

  private handleSearch(query: string): void {
    if (!this._view) return;

    const MAX_INITIAL_CANDIDATES = 500;
    const MAX_CLUSTERING_CANDIDATES = 50;

    if (!query || query.length < 2) {
      this.updateMatches();
      return;
    }

    // Parse search query: extract quoted phrases and individual terms
    const { exactPhrases, terms } = this.parseSearchQuery(query);

    // Use FlexSearch to get initial candidates
    const searchIndex = this.indexManager.getSearchIndex();
    const candidates = searchIndex.search(query, MAX_INITIAL_CANDIDATES);

    // Filter candidates and score them
    const results: { entry: IndexedEntry; score: number }[] = [];

    for (const entry of candidates) {
      // Build searchable text from entry
      const searchText = [
        entry.titleFilter,
        entry.authorNorm,
        entry.key.toLowerCase(),
        entry.fields.year ?? '',
      ].join(' ');

      // Check if ALL exact phrases match (case-insensitive)
      const allPhrasesMatch = exactPhrases.every(phrase =>
        searchText.includes(phrase.toLowerCase())
      );
      if (!allPhrasesMatch) continue;

      // Check if ALL terms match (AND logic) and calculate scores
      const termScores: number[] = [];
      let allTermsMatch = true;

      for (const term of terms) {
        const normalizedTerm = normalizeForFilter(term);

        // Check different match types
        const titleContains = entry.titleFilter.includes(normalizedTerm);
        const authorContains = entry.authorNorm.includes(normalizedTerm);
        const keyContains = entry.key.toLowerCase().includes(term.toLowerCase());
        const yearMatch = entry.fields.year === term;

        if (titleContains || authorContains || keyContains || yearMatch) {
          // Calculate similarity score for this term
          const titleSim = titleContains ? 1 : 0.5;
          const authorSim = authorContains ? 1 : 0.5;
          const keySim = keyContains ? 0.9 : 0;
          const yearSim = yearMatch ? 1 : 0;
          termScores.push(Math.max(titleSim, authorSim, keySim, yearSim));
        } else {
          // Term not found in this entry
          allTermsMatch = false;
          break;
        }
      }

      if (!allTermsMatch) continue;

      // Calculate overall score as average of term scores
      const score = termScores.length > 0
        ? termScores.reduce((a, b) => a + b, 0) / termScores.length
        : 1; // No terms means just phrase match

      if (score > 0.3) {
        results.push({ entry, score });
      }
    }

    results.sort((a, b) => b.score - a.score);

    // Clustering is O(n^2); limit to top-ranked entries for responsive typing.
    const clusteringResults = results.slice(0, MAX_CLUSTERING_CANDIDATES);

    // Build a score map for sorting clusters by search relevance
    const scoreMap = new Map<IndexedEntry, number>();
    for (const r of clusteringResults) {
      scoreMap.set(r.entry, r.score);
    }

    // Cluster by paper identity, then build super cards within each cluster
    const config = vscode.workspace.getConfiguration('tooManyBibs');
    const threshold = config.get<number>('similarityThreshold') ?? 0.85;
    const paperClusters = buildPaperClusters(clusteringResults.map(r => r.entry), threshold);

    // Precompute each cluster's best relevance once before sorting.
    const clusterRanks: { cluster: typeof paperClusters[number]; bestScore: number }[] = [];
    for (const cluster of paperClusters) {
      let best = 0;
      for (const card of cluster.superCards) {
        for (const entry of card.sourceEntries) {
          best = Math.max(best, scoreMap.get(entry) ?? 0);
        }
      }
      clusterRanks.push({ cluster, bestScore: best });
    }

    // Sort clusters by best search relevance score, then quality score
    clusterRanks.sort((a, b) => {
      const aScore = a.bestScore;
      const bScore = b.bestScore;
      if (bScore !== aScore) return bScore - aScore;
      return (b.cluster.superCards[0]?.qualityScore ?? 0) - (a.cluster.superCards[0]?.qualityScore ?? 0);
    });

    // Flatten clusters into display entries with cluster boundaries
    const displayResults: DisplayEntry[] = [];
    let clusterId = 0;
    for (const { cluster } of clusterRanks) {
      if (displayResults.length >= 50) break;
      let isFirst = true;
      for (const card of cluster.superCards) {
        if (displayResults.length >= 50) break;
        const entry = this.formatSuperCardForDisplay(card, this.currentEntry);
        entry.clusterId = clusterId;
        entry.isFirstInCluster = isFirst;
        displayResults.push(entry);
        isFirst = false;
      }
      clusterId++;
    }

    this._view.webview.postMessage({
      command: 'searchResults',
      results: displayResults,
      canInsert: this.isCurrentEditorBibFile(),
    });
  }

  private parseSearchQuery(query: string): { exactPhrases: string[]; terms: string[] } {
    const exactPhrases: string[] = [];
    const terms: string[] = [];

    // Extract quoted phrases first
    const quoteRegex = /"([^"]+)"/g;
    let remaining = query;
    let match;

    while ((match = quoteRegex.exec(query)) !== null) {
      exactPhrases.push(match[1]);
      remaining = remaining.replace(match[0], ' ');
    }

    // Split remaining into individual terms
    const splitTerms = remaining.trim().split(/\s+/).filter(t => t.length > 0);
    terms.push(...splitTerms);

    return { exactPhrases, terms };
  }

  /**
   * Check if two creator lists are semantically equivalent
   * (same people, possibly formatted differently like "Edith Elkind" vs "Elkind, Edith")
   */
  private creatorsEqual(
    a: { lastName?: string; firstName?: string; literal?: string }[],
    b: { lastName?: string; firstName?: string; literal?: string }[]
  ): boolean {
    if (a.length !== b.length) return false;

    // Normalize and compare each creator
    const normalizeCreator = (c: { lastName?: string; firstName?: string; literal?: string }) => {
      if (c.literal) {
        return c.literal.toLowerCase().replace(/[{}\s]+/g, ' ').trim();
      }
      const last = (c.lastName ?? '').toLowerCase().replace(/[{}\s]+/g, ' ').trim();
      const first = (c.firstName ?? '').toLowerCase().replace(/[{}\s.]+/g, ' ').trim();
      return `${last}|${first}`;
    };

    const aNorm = a.map(normalizeCreator).sort();
    const bNorm = b.map(normalizeCreator).sort();

    for (let i = 0; i < aNorm.length; i++) {
      if (aNorm[i] !== bNorm[i]) return false;
    }

    return true;
  }

  private computeFieldLinkTargets(fields: Record<string, string>): Record<string, string> {
    const targets: Record<string, string> = {};
    const entries = Object.entries(fields);
    const archivePrefixValue = this.findFieldValueCaseInsensitive(fields, 'archiveprefix');
    const hasArxivPrefix = archivePrefixValue?.trim().toLowerCase() === 'arxiv';

    for (let i = 0; i < entries.length; i++) {
      const [fieldName, fieldValue] = entries[i];
      const fieldLower = fieldName.toLowerCase();

      if (fieldLower === 'url') {
        const target = normalizeUrlValue(fieldValue);
        if (target) {
          targets[fieldName] = target;
        }
        continue;
      }

      if (fieldLower === 'doi') {
        const target = normalizeDoiValue(fieldValue);
        if (target) {
          targets[fieldName] = target;
        }
        continue;
      }

      if (fieldLower === 'eprint') {
        if (!hasArxivPrefix) {
          continue;
        }

        const target = normalizeArxivValue(fieldValue);
        if (target) {
          targets[fieldName] = target;
        }
      }
    }

    return targets;
  }

  private findFieldValueCaseInsensitive(fields: Record<string, string>, fieldName: string): string | undefined {
    for (const [name, value] of Object.entries(fields)) {
      if (name.toLowerCase() === fieldName.toLowerCase()) {
        return value;
      }
    }
    return undefined;
  }

  private formatSuperCardForDisplay(
    card: SuperCard,
    currentEntry?: IndexedEntry | null
  ): DisplayEntry {
    const allFiles = card.sourceEntries.map(e => ({ file: e.file, key: e.key }));
    const fields: DisplayField[] = [];
    const linkTargets = this.computeFieldLinkTargets(card.fields);

    const allFieldNames = new Set([
      ...Object.keys(card.fields),
      ...(currentEntry ? Object.keys(currentEntry.fields) : []),
    ]);

    for (const fieldName of allFieldNames) {
      const theirValue = card.fields[fieldName];
      const yourValue = currentEntry?.fields[fieldName];

      let status: 'same' | 'only-theirs' | 'only-yours' | 'different' = 'same';
      let displayValue = theirValue ?? '';
      let diffHtml: string | null = null;

      if (!yourValue && theirValue) {
        status = 'only-theirs';
      } else if (yourValue && !theirValue) {
        status = 'only-yours';
      } else if (yourValue !== theirValue && yourValue && theirValue) {
        if ((fieldName === 'author' || fieldName === 'editor') && currentEntry) {
          const theirCreators = card.creators?.[fieldName as 'author' | 'editor'];
          const yourCreators = currentEntry.creators?.[fieldName as 'author' | 'editor'];
          if (theirCreators && yourCreators && this.creatorsEqual(theirCreators, yourCreators)) {
            status = 'same';
          } else {
            status = 'different';
            diffHtml = this.computeInlineDiff(yourValue, theirValue);
          }
        } else {
          status = 'different';
          diffHtml = this.computeInlineDiff(yourValue, theirValue);
        }
      }

      fields.push({
        name: fieldName,
        value: displayValue,
        status,
        canCopy: status === 'only-theirs' || status === 'different',
        diffHtml,
        linkTarget: linkTargets[fieldName],
      });
    }

    fields.sort((a, b) => {
      const aIdx = CANONICAL_FIELD_ORDER.indexOf(a.name);
      const bIdx = CANONICAL_FIELD_ORDER.indexOf(b.name);
      const aOrder = aIdx === -1 ? 999 : aIdx;
      const bOrder = bIdx === -1 ? 999 : bIdx;
      return aOrder - bOrder;
    });

    // Serialize merged fields for copy/insert of the super card
    const mergedFieldsJson = JSON.stringify(card.fields);

    return {
      key: card.key,
      file: card.sourceEntries[0].file,
      fileName: path.basename(card.sourceEntries[0].file),
      fileCount: card.sourceEntries.length,
      allFiles,
      entryType: card.entryType,
      title: card.fields.title ?? '(untitled)',
      author: card.fields.author ?? card.fields.editor ?? '',
      year: card.fields.year ?? '',
      fields,
      mergedFields: mergedFieldsJson,
    };
  }

  private formatEntryForDisplay(
    entry: IndexedEntry,
    currentEntry?: IndexedEntry | null,
    fileCount: number = 1,
    allFiles: { file: string; key: string }[] = []
  ): DisplayEntry {
    const fields: DisplayField[] = [];
    const linkTargets = this.computeFieldLinkTargets(entry.fields);

    const allFieldNames = new Set([
      ...Object.keys(entry.fields),
      ...(currentEntry ? Object.keys(currentEntry.fields) : []),
    ]);

    for (const fieldName of allFieldNames) {
      const theirValue = entry.fields[fieldName];
      const yourValue = currentEntry?.fields[fieldName];

      let status: 'same' | 'only-theirs' | 'only-yours' | 'different' = 'same';
      let displayValue = theirValue ?? '';
      let diffHtml: string | null = null;

      if (!yourValue && theirValue) {
        status = 'only-theirs';
      } else if (yourValue && !theirValue) {
        status = 'only-yours';
      } else if (yourValue !== theirValue && yourValue && theirValue) {
        // For author/editor fields, check if they're semantically equivalent
        if ((fieldName === 'author' || fieldName === 'editor') && currentEntry) {
          const theirCreators = entry.creators?.[fieldName as 'author' | 'editor'];
          const yourCreators = currentEntry.creators?.[fieldName as 'author' | 'editor'];
          if (theirCreators && yourCreators && this.creatorsEqual(theirCreators, yourCreators)) {
            // Semantically equivalent authors, just formatted differently
            status = 'same';
          } else {
            status = 'different';
            diffHtml = this.computeInlineDiff(yourValue, theirValue);
          }
        } else {
          status = 'different';
          diffHtml = this.computeInlineDiff(yourValue, theirValue);
        }
      }

      fields.push({
        name: fieldName,
        value: displayValue,
        status,
        canCopy: status === 'only-theirs' || status === 'different',
        diffHtml,
        linkTarget: linkTargets[fieldName],
      });
    }

    fields.sort((a, b) => {
      const aIdx = CANONICAL_FIELD_ORDER.indexOf(a.name);
      const bIdx = CANONICAL_FIELD_ORDER.indexOf(b.name);
      const aOrder = aIdx === -1 ? 999 : aIdx;
      const bOrder = bIdx === -1 ? 999 : bIdx;
      return aOrder - bOrder;
    });

    return {
      key: entry.key,
      file: entry.file,
      fileName: path.basename(entry.file),
      fileCount,
      allFiles,
      entryType: entry.entryType,
      title: entry.fields.title ?? '(untitled)',
      author: entry.fields.author ?? entry.fields.editor ?? '',
      year: entry.fields.year ?? '',
      fields,
    };
  }

  private computeInlineDiff(yours: string, theirs: string): string {
    const diff = computeDiff(yours, theirs);
    let result = '';

    for (const part of diff) {
      if (part.type === 'same') {
        result += this.escapeHtml(part.text);
      } else if (part.type === 'add') {
        result += `<mark>${this.escapeHtml(part.text)}</mark>`;
      }
    }

    return result;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private async handleCopyEntry(file: string, key: string): Promise<void> {
    const entry = this.findEntry(file, key);
    if (!entry) return;

    const bibtex = formatBibtex(entry);
    await vscode.env.clipboard.writeText(bibtex);
    // Visual feedback is handled in the webview
  }

  async handleInsertField(file: string, key: string, field: string): Promise<void> {
    const entry = this.findEntry(file, key);
    if (!entry || !this.currentEditor || !this.currentEntry) return;

    const value = entry.fields[field];
    if (!value) return;

    const document = this.currentEditor.document;
    const content = document.getText();
    const lines = content.split('\n');

    const entryStart = this.currentEntry.startLine - 1;
    const entryEnd = this.currentEntry.endLine - 1;

    // Detect indentation from existing fields
    const indent = this.detectFieldIndentation(lines, entryStart, entryEnd);

    const fieldRegex = new RegExp(`^\\s*${field}\\s*=`, 'i');
    let existingFieldLine = -1;

    for (let i = entryStart; i <= entryEnd; i++) {
      if (fieldRegex.test(lines[i])) {
        existingFieldLine = i;
        break;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    const fieldLine = `${indent}${field} = ${formatFieldValue(value)},`;

    if (existingFieldLine >= 0) {
      const existingFieldEndLine = this.findExistingFieldEndLine(lines, existingFieldLine, entryEnd);
      const lineRange = new vscode.Range(
        existingFieldLine, 0,
        existingFieldEndLine, lines[existingFieldEndLine].length
      );
      edit.replace(document.uri, lineRange, fieldLine);
    } else {
      const insertInfo = this.findInsertionPoint(lines, entryStart, entryEnd, field);

      // If inserting after the last field, ensure the previous line has a comma
      if (insertInfo.needsComma && insertInfo.previousFieldLine >= 0) {
        const prevLine = lines[insertInfo.previousFieldLine];
        const trimmed = prevLine.trimEnd();
        if (!trimmed.endsWith(',')) {
          const commaRange = new vscode.Range(
            insertInfo.previousFieldLine, trimmed.length,
            insertInfo.previousFieldLine, prevLine.length
          );
          edit.replace(document.uri, commaRange, ',');
        }
      }

      const insertPos = new vscode.Position(insertInfo.line, 0);
      edit.insert(document.uri, insertPos, fieldLine + '\n');
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(`Failed to insert ${field}`);
      return;
    }
    vscode.window.showInformationMessage(`Inserted ${field}`);
  }

  async handleInsertEntry(file: string, key: string): Promise<void> {
    const entry = this.findEntry(file, key);
    if (!entry) return;

    const editor = this.currentEditor ?? vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor to insert entry into');
      return;
    }

    const document = editor.document;
    const content = document.getText();
    const lines = content.split('\n');

    // Find a safe insertion point
    const insertLine = findEntryInsertionPoint(lines, this.currentEntry, editor.selection.active.line);

    const bibtex = formatBibtex(entry);
    const edit = new vscode.WorkspaceEdit();

    // Determine if blank lines are needed
    const { needsBlankBefore, needsBlankAfter } = determineBlankLines(lines, insertLine);

    let textToInsert = '';
    if (needsBlankBefore) {
      textToInsert += '\n';
    }
    textToInsert += bibtex;
    if (needsBlankAfter) {
      textToInsert += '\n';
    }
    textToInsert += '\n';

    const insertPos = new vscode.Position(insertLine, 0);
    edit.insert(document.uri, insertPos, textToInsert);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(`Failed to insert @${entry.entryType}{${entry.key}}`);
      return;
    }
    vscode.window.showInformationMessage(`Inserted @${entry.entryType}{${entry.key}}`);
  }

  async handleInsertFieldValue(field: string, value: string): Promise<void> {
    if (!this.currentEditor || !this.currentEntry) return;
    if (!value) return;

    const document = this.currentEditor.document;
    const content = document.getText();
    const lines = content.split('\n');

    const entryStart = this.currentEntry.startLine - 1;
    const entryEnd = this.currentEntry.endLine - 1;

    const indent = this.detectFieldIndentation(lines, entryStart, entryEnd);

    const fieldRegex = new RegExp(`^\\s*${field}\\s*=`, 'i');
    let existingFieldLine = -1;

    for (let i = entryStart; i <= entryEnd; i++) {
      if (fieldRegex.test(lines[i])) {
        existingFieldLine = i;
        break;
      }
    }

    const edit = new vscode.WorkspaceEdit();
    const fieldLine = `${indent}${field} = ${formatFieldValue(value)},`;

    if (existingFieldLine >= 0) {
      const existingFieldEndLine = this.findExistingFieldEndLine(lines, existingFieldLine, entryEnd);
      const lineRange = new vscode.Range(
        existingFieldLine, 0,
        existingFieldEndLine, lines[existingFieldEndLine].length
      );
      edit.replace(document.uri, lineRange, fieldLine);
    } else {
      const insertInfo = this.findInsertionPoint(lines, entryStart, entryEnd, field);

      if (insertInfo.needsComma && insertInfo.previousFieldLine >= 0) {
        const prevLine = lines[insertInfo.previousFieldLine];
        const trimmed = prevLine.trimEnd();
        if (!trimmed.endsWith(',')) {
          const commaRange = new vscode.Range(
            insertInfo.previousFieldLine, trimmed.length,
            insertInfo.previousFieldLine, prevLine.length
          );
          edit.replace(document.uri, commaRange, ',');
        }
      }

      const insertPos = new vscode.Position(insertInfo.line, 0);
      edit.insert(document.uri, insertPos, fieldLine + '\n');
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(`Failed to insert ${field}`);
      return;
    }
    vscode.window.showInformationMessage(`Inserted ${field}`);
  }

  private buildSyntheticEntry(fields: Record<string, string>, entryType: string, key: string): IndexedEntry {
    return {
      file: '',
      key,
      entryType,
      startLine: 0,
      endLine: 0,
      fields,
      creators: {},
      titleFilter: '',
      titleCluster: '',
      authorNorm: '',
    };
  }

  private async handleCopySuperCard(fields: Record<string, string>, entryType: string, key: string): Promise<void> {
    const synthetic = this.buildSyntheticEntry(fields, entryType, key);
    const bibtex = formatBibtex(synthetic);
    await vscode.env.clipboard.writeText(bibtex);
  }

  private async handleInsertSuperCard(fields: Record<string, string>, entryType: string, key: string): Promise<void> {
    const editor = this.currentEditor ?? vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showErrorMessage('No active editor to insert entry into');
      return;
    }

    const synthetic = this.buildSyntheticEntry(fields, entryType, key);
    const document = editor.document;
    const content = document.getText();
    const lines = content.split('\n');

    const insertLine = findEntryInsertionPoint(lines, this.currentEntry, editor.selection.active.line);
    const bibtex = formatBibtex(synthetic);
    const edit = new vscode.WorkspaceEdit();

    const { needsBlankBefore, needsBlankAfter } = determineBlankLines(lines, insertLine);

    let textToInsert = '';
    if (needsBlankBefore) {
      textToInsert += '\n';
    }
    textToInsert += bibtex;
    if (needsBlankAfter) {
      textToInsert += '\n';
    }
    textToInsert += '\n';

    const insertPos = new vscode.Position(insertLine, 0);
    edit.insert(document.uri, insertPos, textToInsert);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      vscode.window.showErrorMessage(`Failed to insert @${entryType}{${key}}`);
      return;
    }
    vscode.window.showInformationMessage(`Inserted @${entryType}{${key}}`);
  }

  private findExistingFieldEndLine(lines: string[], fieldStart: number, entryEnd: number): number {
    for (let i = fieldStart + 1; i <= entryEnd; i++) {
      if (/^\s*\w+\s*=/.test(lines[i])) {
        return i - 1;
      }
    }
    return Math.max(fieldStart, entryEnd - 1);
  }

  private detectFieldIndentation(lines: string[], entryStart: number, entryEnd: number): string {
    // Look for existing field lines to detect indentation
    for (let i = entryStart + 1; i <= entryEnd; i++) {
      const match = lines[i].match(/^(\s*)\w+\s*=/);
      if (match) {
        return match[1]; // Return the whitespace prefix
      }
    }
    return '  '; // Default to 2 spaces
  }

  private findInsertionPoint(
    lines: string[],
    entryStart: number,
    entryEnd: number,
    newField: string
  ): { line: number; needsComma: boolean; previousFieldLine: number } {
    const newFieldOrder = CANONICAL_FIELD_ORDER.indexOf(newField);
    const targetOrder = newFieldOrder === -1 ? 999 : newFieldOrder;

    let insertAfter = entryStart;
    let lastFieldLine = -1;

    for (let i = entryStart + 1; i <= entryEnd; i++) {
      const match = lines[i].match(/^\s*(\w+)\s*=/);
      if (match) {
        lastFieldLine = i;
        const fieldName = match[1].toLowerCase();
        const fieldOrder = CANONICAL_FIELD_ORDER.indexOf(fieldName);
        const order = fieldOrder === -1 ? 999 : fieldOrder;

        if (order < targetOrder) {
          insertAfter = i;
        }
      }
    }

    const insertLine = insertAfter + 1;
    // Check if we're inserting after the last field (before the closing brace)
    const needsComma = insertAfter === lastFieldLine && lastFieldLine >= 0;

    return { line: insertLine, needsComma, previousFieldLine: insertAfter };
  }

  private findEntry(file: string, key: string): IndexedEntry | undefined {
    return this.indexManager.getEntries().find(
      e => e.file === file && e.key === key
    );
  }

  private isCurrentEditorBibFile(): boolean {
    const editor = this.currentEditor ?? vscode.window.activeTextEditor;
    if (!editor) return false;
    return editor.document.fileName.endsWith('.bib');
  }

  private getHtmlContent(): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style nonce="${nonce}">
    * { box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 0;
      margin: 0;
      display: flex;
      flex-direction: column;
      height: 100vh;
    }

    .search-container {
      padding: 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      flex-shrink: 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      z-index: 10;
    }

    .search-wrapper {
      position: relative;
      display: flex;
      align-items: center;
    }

    .search-box {
      width: 100%;
      padding: 6px 28px 6px 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 2px;
    }

    .search-box:focus { outline: 1px solid var(--vscode-focusBorder); }

    .search-clear {
      position: absolute;
      right: 4px;
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px 6px;
      font-size: 1em;
      line-height: 1;
      display: none;
    }

    .search-clear:hover {
      color: var(--vscode-foreground);
    }

    .search-clear.visible {
      display: block;
    }

    .search-banner {
      display: none;
      padding: 4px 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.85em;
      align-items: center;
      justify-content: space-between;
      flex-shrink: 0;
    }

    .search-banner.visible {
      display: flex;
    }

    .search-banner a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .search-banner a:hover {
      text-decoration: underline;
    }

    .search-banner-dismiss {
      background: transparent;
      border: none;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 1em;
      line-height: 1;
      flex-shrink: 0;
      margin-left: 4px;
    }

    .search-banner-dismiss:hover {
      color: var(--vscode-foreground);
    }

    .content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .status-bar {
      padding: 6px 8px;
      border-top: 1px solid var(--vscode-panel-border);
      font-size: 0.9em;
      color: var(--vscode-descriptionForeground);
      display: flex;
      justify-content: space-between;
      align-items: center;
      flex-shrink: 0;
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      z-index: 10;
    }

    .status-bar a {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .status-bar a:hover { text-decoration: underline; }

    @keyframes spin {
      to { transform: rotate(360deg); }
    }

    .spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid var(--vscode-descriptionForeground);
      border-top-color: transparent;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 4px;
      vertical-align: middle;
    }

    .progress-text {
      display: none;
      align-items: center;
    }

    .progress-text.active {
      display: inline-flex;
    }

    .cluster-separator {
      border-top: 2px solid var(--vscode-panel-border);
      margin: 16px 0 10px;
    }

    .entry-card {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 10px;
      overflow: hidden;
    }

    .entry-header {
      padding: 8px 10px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .entry-title { font-weight: 500; margin-bottom: 2px; }
    .entry-meta { font-size: 0.9em; color: var(--vscode-descriptionForeground); }

    .entry-type {
      font-family: var(--vscode-editor-font-family);
      font-size: 0.85em;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      padding: 1px 4px;
      border-radius: 2px;
      margin-right: 4px;
    }

    .entry-source {
      font-size: 0.85em;
      color: var(--vscode-textLink-foreground);
      margin-top: 4px;
      cursor: pointer;
    }

    .entry-source:hover { text-decoration: underline; }

    .entry-fields { padding: 6px 10px; }

    .field-row {
      display: flex;
      padding: 3px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
      font-size: 0.85em;
      align-items: flex-start;
    }

    .field-row:last-child { border-bottom: none; }

    .field-name {
      width: 70px;
      flex-shrink: 0;
      font-family: var(--vscode-editor-font-family);
      font-weight: 500;
      padding-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .field-value {
      flex: 1;
      min-width: 0;
      word-break: break-word;
      padding-right: 6px;
      line-height: 1.4;
    }

    .field-value.expandable {
      cursor: pointer;
    }

    .field-value.only-theirs {
      background: var(--vscode-diffEditor-insertedLineBackground, rgba(0,200,0,0.15));
      padding: 2px 4px;
      border-radius: 2px;
    }

    .field-value.only-yours {
      color: var(--vscode-disabledForeground);
      font-style: italic;
    }

    .field-value mark {
      background: var(--vscode-diffEditor-insertedTextBackground, rgba(0,200,0,0.3));
      color: inherit;
    }

    .field-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: underline;
      cursor: pointer;
      word-break: break-word;
    }

    .field-link:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
    }

    .field-action {
      flex-shrink: 0;
      padding-top: 2px;
    }

    .field-action button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 6px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.85em;
    }

    .field-action button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .entry-actions {
      padding: 6px 10px;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .entry-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 12px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.9em;
    }

    .entry-actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 20px 10px;
      text-align: center;
    }

    .current-entry-info {
      padding: 8px 10px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      border-radius: 4px;
      margin-bottom: 10px;
      font-size: 0.9em;
    }

    .current-entry-info .label {
      color: var(--vscode-descriptionForeground);
      font-size: 0.85em;
      margin-bottom: 2px;
    }

    .section-header {
      font-size: 0.85em;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
      margin: 12px 0 6px 0;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .ellipsis {
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
    }

    .ellipsis:hover { text-decoration: underline; }

    /* File management view */
    .manage-view {
      display: none;
      flex-direction: column;
      height: 100%;
    }

    .manage-view.active { display: flex; }
    .main-view {
      display: flex;
      flex-direction: column;
      height: 100%;
    }

    .main-view.hidden { display: none; }

    .manage-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .manage-header h3 { margin: 0; font-size: 1em; }
    .manage-header a { color: var(--vscode-textLink-foreground); cursor: pointer; }

    .manage-content {
      flex: 1;
      overflow-y: auto;
      padding: 8px;
    }

    .manage-actions {
      display: flex;
      gap: 6px;
      margin-bottom: 10px;
    }

    .manage-actions button {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 4px 10px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.85em;
    }

    .manage-actions button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .manage-section { margin-bottom: 8px; }

    .manage-section h4 {
      margin: 0 0 4px 0;
      font-size: 0.85em;
      color: var(--vscode-descriptionForeground);
    }

    .manage-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 4px 6px;
      background: var(--vscode-editor-background);
      border-radius: 3px;
      margin-bottom: 2px;
      font-size: 0.85em;
    }

    .manage-item-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .manage-item-name.file-link {
      cursor: pointer;
      color: var(--vscode-textLink-foreground);
    }

    .manage-item-name.file-link:hover {
      text-decoration: underline;
    }

    .manage-item-count {
      font-size: 0.8em;
      color: var(--vscode-descriptionForeground);
      margin: 0 6px;
    }

    .manage-item button {
      background: transparent;
      color: var(--vscode-errorForeground);
      border: none;
      cursor: pointer;
      padding: 1px 4px;
      font-size: 0.8em;
    }

    .manage-item button:hover { text-decoration: underline; }

    .manage-item.nested { margin-left: 20px; }

    .manage-item.folder {
      cursor: pointer;
    }

    .manage-item.folder:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .folder-toggle {
      margin-right: 4px;
      font-size: 0.7em;
      transition: transform 0.15s;
      display: inline-block;
      width: 12px;
      text-align: center;
      transform-origin: center center;
    }

    .folder-toggle.collapsed {
      transform: rotate(-90deg);
    }

    .folder-files {
      overflow: hidden;
      transition: max-height 0.2s ease-out;
    }

    .folder-files.collapsed {
      display: none;
    }

    .error-indicator {
      color: var(--vscode-errorForeground);
      cursor: pointer;
      margin-left: 4px;
      font-size: 0.9em;
    }

    .error-indicator:hover {
      text-decoration: underline;
    }

    /* Modal overlay */
    .modal-overlay {
      display: none;
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.6);
      z-index: 100;
      padding: 20px 10px;
    }

    .modal-overlay.active {
      display: flex;
      align-items: flex-start;
      justify-content: center;
    }

    .modal-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      max-width: 100%;
      max-height: calc(100vh - 40px);
      display: flex;
      flex-direction: column;
    }

    .modal-header {
      padding: 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: var(--vscode-editor-background);
      flex-shrink: 0;
      border-radius: 6px 6px 0 0;
    }

    .modal-header h3 { margin: 0; font-size: 0.95em; }

    .modal-close {
      background: transparent;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 1.2em;
      padding: 0 4px;
    }

    .modal-body {
      padding: 8px;
      overflow-y: auto;
      flex: 1;
    }

    .errors-list {
      font-size: 0.85em;
    }

    .error-item {
      padding: 6px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      line-height: 1.4;
    }

    .error-item:last-child {
      border-bottom: none;
    }

    .error-number {
      color: var(--vscode-errorForeground);
      font-weight: 500;
    }

    .error-message {
      font-family: var(--vscode-editor-font-family);
      word-break: break-word;
    }

    .modal-entry {
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      margin-bottom: 8px;
      overflow: hidden;
    }

    .modal-entry-header {
      padding: 6px 8px;
      background: var(--vscode-editor-inactiveSelectionBackground);
      font-size: 0.85em;
      font-weight: 500;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .modal-entry-title {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .modal-file-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      cursor: pointer;
    }

    .modal-file-link:hover {
      text-decoration: underline;
      color: var(--vscode-textLink-activeForeground);
    }

    .modal-entry-key {
      color: var(--vscode-descriptionForeground);
    }

    .modal-copy-btn {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
      border: none;
      padding: 2px 8px;
      border-radius: 2px;
      cursor: pointer;
      font-size: 0.85em;
      margin-left: 8px;
      flex-shrink: 0;
    }

    .modal-copy-btn:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    .modal-entry-fields { padding: 6px 8px; }

    .modal-field-row {
      display: flex;
      font-size: 0.8em;
      padding: 2px 0;
      border-bottom: 1px solid var(--vscode-panel-border);
    }

    .modal-field-row:last-child { border-bottom: none; }

    .modal-field-name {
      width: 60px;
      flex-shrink: 0;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }

    .modal-field-value {
      flex: 1;
      word-break: break-word;
    }
  </style>
</head>
<body>
  <div class="main-view" id="mainView">
    <div class="search-container">
      <div class="search-wrapper">
        <input type="text" class="search-box" placeholder="Search entries..." id="searchInput">
        <button class="search-clear" id="searchClear" title="Clear search">×</button>
      </div>
    </div>
    <div class="search-banner" id="searchBanner">
      <a id="searchBannerLink">← Back to search: <span id="searchBannerQuery"></span></a>
      <button class="search-banner-dismiss" id="searchBannerDismiss" title="Dismiss">×</button>
    </div>
    <div class="content" id="content">
      <div class="placeholder">Loading...</div>
    </div>
    <div class="status-bar">
      <span id="statusText">Initializing...</span>
      <span class="progress-text" id="progressText"><span class="spinner"></span><span id="progressLabel"></span></span>
      <a id="manageFiles">Manage files</a>
    </div>
  </div>

  <div class="manage-view" id="manageView">
    <div class="manage-header">
      <h3>Manage Files</h3>
      <a id="backToMain">← Back</a>
    </div>
    <div class="manage-content" id="manageContent"></div>
  </div>

  <div class="modal-overlay" id="modalOverlay">
    <div class="modal-content">
      <div class="modal-header">
        <h3 id="modalTitle">Files</h3>
        <button class="modal-close" id="modalClose">×</button>
      </div>
      <div class="modal-body" id="modalBody"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const searchInput = document.getElementById('searchInput');
    const searchClear = document.getElementById('searchClear');
    const content = document.getElementById('content');
    const statusText = document.getElementById('statusText');
    const manageFiles = document.getElementById('manageFiles');
    const mainView = document.getElementById('mainView');
    const manageView = document.getElementById('manageView');
    const manageContent = document.getElementById('manageContent');
    const backToMain = document.getElementById('backToMain');
    const modalOverlay = document.getElementById('modalOverlay');
    const modalClose = document.getElementById('modalClose');
    const modalBody = document.getElementById('modalBody');
    const modalTitle = document.getElementById('modalTitle');
    const progressText = document.getElementById('progressText');
    const progressLabel = document.getElementById('progressLabel');
    const searchBanner = document.getElementById('searchBanner');
    const searchBannerLink = document.getElementById('searchBannerLink');
    const searchBannerQuery = document.getElementById('searchBannerQuery');
    const searchBannerDismiss = document.getElementById('searchBannerDismiss');

    let currentEntry = null;
    let isSearching = false;
    let canInsert = false;
    let savedSearchQuery = '';
    const MAX_VALUE_LENGTH = 300;

    vscode.postMessage({ command: 'ready' });

    // Update clear button visibility
    function updateClearButton() {
      if (searchInput.value.length > 0) {
        searchClear.classList.add('visible');
      } else {
        searchClear.classList.remove('visible');
      }
    }

    function showSearchBanner(query) {
      searchBannerQuery.textContent = '"' + query + '"';
      searchBanner.classList.add('visible');
    }

    function hideSearchBanner() {
      searchBanner.classList.remove('visible');
      savedSearchQuery = '';
    }

    // Clear search button handler
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      updateClearButton();
      isSearching = false;
      hideSearchBanner();
      vscode.postMessage({ command: 'search', query: '' });
    });

    manageFiles.addEventListener('click', () => {
      mainView.classList.add('hidden');
      manageView.classList.add('active');
      vscode.postMessage({ command: 'showManageFiles' });
    });

    backToMain.addEventListener('click', () => {
      manageView.classList.remove('active');
      mainView.classList.remove('hidden');
      vscode.postMessage({ command: 'hideManageFiles' });
    });

    modalClose.addEventListener('click', () => {
      modalOverlay.classList.remove('active');
    });

    modalOverlay.addEventListener('click', (e) => {
      if (e.target === modalOverlay) {
        modalOverlay.classList.remove('active');
      }
    });

    searchBannerLink.addEventListener('click', () => {
      const query = savedSearchQuery;
      searchInput.value = query;
      updateClearButton();
      isSearching = true;
      hideSearchBanner();
      vscode.postMessage({ command: 'search', query });
    });

    searchBannerDismiss.addEventListener('click', () => {
      hideSearchBanner();
    });

    searchInput.addEventListener('input', () => {
      updateClearButton();
      hideSearchBanner();
      const query = searchInput.value.trim();
      isSearching = query.length > 0;

      // Keep 1-character input local so we don't trigger a matches response
      // (which is used to exit search mode when navigating to an entry).
      if (query.length === 0 || query.length >= 2) {
        vscode.postMessage({ command: 'search', query });
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      switch (message.command) {
        case 'status':
          statusText.textContent = message.entries + ' entries in ' +
            message.files + ' files (' + message.folders + ' folders)';
          break;

        case 'matches':
          if (isSearching) {
            savedSearchQuery = searchInput.value.trim();
            isSearching = false;
            searchInput.value = '';
            updateClearButton();
            showSearchBanner(savedSearchQuery);
          }
          currentEntry = message.currentEntry;
          renderMatches(message.currentEntry, message.matches);
          break;

        case 'searchResults':
          canInsert = message.canInsert;
          renderSearchResults(message.results, canInsert);
          break;

        case 'fileManagementData':
          renderFileManagement(message.folders, message.filesByFolder);
          break;

        case 'filesModalData':
          renderFilesModal(message.entries);
          break;

        case 'indexProgress':
          if (message.current < message.total) {
            progressText.classList.add('active');
            progressLabel.textContent = message.phase + ' ' + message.current + '/' + message.total;
          } else {
            progressText.classList.remove('active');
          }
          break;
      }
    });

    function renderMatches(currentEntry, matches) {
      if (!currentEntry) {
        content.innerHTML = '<div class="placeholder">Place cursor in a bib entry to see matches from other files</div>';
        return;
      }

      let html = '';

      html += '<div class="current-entry-info">';
      html += '<div class="label">Current entry</div>';
      html += '<strong>' + escapeHtml(currentEntry.key) + '</strong>';
      if (currentEntry.title) {
        html += ' — ' + escapeHtml(truncate(currentEntry.title, 60));
      }
      html += '</div>';

      if (matches.length === 0) {
        html += '<div class="placeholder">No matching entries found in other files</div>';
      } else {
        html += '<div class="section-header">Matches from other files</div>';
        matches.forEach(match => {
          html += renderEntryCard(match, true, true);
        });
      }

      content.innerHTML = html;
      attachEventListeners();
    }

    function renderSearchResults(results, canInsert) {
      if (results.length === 0) {
        content.innerHTML = '<div class="placeholder">No results found</div>';
        return;
      }

      let html = '<div class="section-header">Search results</div>';
      results.forEach((entry, index) => {
        if (entry.isFirstInCluster && index > 0) {
          html += '<div class="cluster-separator"></div>';
        }
        html += renderEntryCard(entry, false, canInsert);
      });

      content.innerHTML = html;
      attachEventListeners();
    }

    function renderEntryCard(entry, showFieldComparison, canInsertEntry = false) {
      let html = '<div class="entry-card">';

      html += '<div class="entry-header">';
      html += '<div class="entry-title">' + escapeHtml(truncate(entry.title, 100)) + '</div>';
      html += '<div class="entry-meta">';
      html += '<span class="entry-type">@' + escapeHtml(entry.entryType) + '</span> ';
      html += escapeHtml(entry.author);
      if (entry.year) html += ' (' + entry.year + ')';
      html += '</div>';

      const filesData = entry.allFiles && entry.allFiles.length > 0
        ? JSON.stringify(entry.allFiles).replace(/"/g, '&quot;')
        : '[]';
      html += '<div class="entry-source" data-files="' + filesData + '">';
      html += escapeHtml(entry.fileName);
      if (entry.fileCount > 1) {
        html += ' (+' + (entry.fileCount - 1) + ' more)';
      }
      html += '</div>';
      html += '</div>';

      // Always show fields if they exist
      if (entry.fields && entry.fields.length > 0) {
        html += '<div class="entry-fields">';
        entry.fields.forEach(field => {
          // Skip 'only-yours' fields in search mode (no current entry to compare)
          if (!showFieldComparison && field.status === 'only-yours') {
            return;
          }

          html += '<div class="field-row">';
          html += '<span class="field-name" title="' + escapeHtml(field.name) + '">' + escapeHtml(field.name) + '</span>';

          if (showFieldComparison) {
            // Edit mode: show comparison styling and insert buttons
            var insertBtnAttrs;
            if (entry.mergedFields) {
              // Super card: use insertFieldValue with the value directly
              insertBtnAttrs = 'data-action="insertFieldValue" data-field="' +
                escapeHtml(field.name) + '" data-value="' +
                escapeHtml(field.value).replace(/"/g, '&quot;') + '"';
            } else {
              insertBtnAttrs = 'data-action="insert" data-file="' +
                escapeHtml(entry.file) + '" data-key="' + escapeHtml(entry.key) +
                '" data-field="' + escapeHtml(field.name) + '"';
            }
            if (field.status === 'only-yours') {
              html += '<span class="field-value only-yours">[none]</span>';
              html += '<span class="field-action"></span>';
            } else if (field.status === 'only-theirs') {
              html += renderFieldValue(field.value, 'only-theirs', field.name, field.linkTarget);
              html += '<span class="field-action"><button ' + insertBtnAttrs + '>→</button></span>';
            } else if (field.status === 'different' && field.diffHtml) {
              html += '<span class="field-value">' + field.diffHtml + '</span>';
              html += '<span class="field-action"><button ' + insertBtnAttrs + '>→</button></span>';
            } else {
              html += renderFieldValue(field.value, '', field.name, field.linkTarget);
              html += '<span class="field-action"></span>';
            }
          } else {
            // Search mode: just show field values without comparison styling
            html += renderFieldValue(field.value, '', field.name, field.linkTarget);
            html += '<span class="field-action"></span>';
          }

          html += '</div>';
        });
        html += '</div>';
      }

      html += '<div class="entry-actions">';
      if (entry.mergedFields) {
        // Super card: copy/insert the merged entry
        html += '<button data-action="copySuperCard" data-entry-type="' + escapeHtml(entry.entryType) +
          '" data-key="' + escapeHtml(entry.key) +
          '" data-merged-fields="' + escapeHtml(entry.mergedFields).replace(/"/g, '&quot;') + '">Copy entry</button>';
        if (showFieldComparison || canInsertEntry) {
          html += ' <button data-action="insertSuperCard" data-entry-type="' + escapeHtml(entry.entryType) +
            '" data-key="' + escapeHtml(entry.key) +
            '" data-merged-fields="' + escapeHtml(entry.mergedFields).replace(/"/g, '&quot;') +
            '" title="Insert merged entry into current file">→</button>';
        }
      } else {
        html += '<button data-action="copy" data-file="' + escapeHtml(entry.file) +
          '" data-key="' + escapeHtml(entry.key) + '">Copy entry</button>';
        if (showFieldComparison || canInsertEntry) {
          html += ' <button data-action="insertEntry" data-file="' + escapeHtml(entry.file) +
            '" data-key="' + escapeHtml(entry.key) + '" title="Insert entry into current file">→</button>';
        }
      }
      html += '</div>';

      html += '</div>';
      return html;
    }

    function renderFieldValue(value, cssClass, fieldName, linkTarget) {
      const id = 'fv-' + Math.random().toString(36).substr(2, 9);
      const renderedValue = linkTarget
        ? '<a href="#" class="field-link" data-url="' + escapeHtml(linkTarget).replace(/"/g, '&quot;') +
          '" title="' + escapeHtml(linkTarget).replace(/"/g, '&quot;') + '">' + escapeHtml(value) + '</a>'
        : escapeHtml(value);

      if (value.length > MAX_VALUE_LENGTH) {
        const truncated = value.substring(0, MAX_VALUE_LENGTH);
        if (linkTarget) {
          return '<span class="field-value ' + cssClass + '" id="' + id + '">' +
            '<a href="#" class="field-link" data-url="' + escapeHtml(linkTarget).replace(/"/g, '&quot;') +
            '" title="' + escapeHtml(linkTarget).replace(/"/g, '&quot;') + '">' +
            escapeHtml(truncated) + '...</a></span>';
        }
        return '<span class="field-value ' + cssClass + '" id="' + id + '" data-full="' +
          escapeHtml(value).replace(/"/g, '&quot;') + '">' +
          escapeHtml(truncated) + '<span class="ellipsis" data-target="' + id + '">...</span></span>';
      }
      return '<span class="field-value ' + cssClass + '">' + renderedValue + '</span>';
    }

    function renderFileManagement(folders, filesByFolder) {
      let html = '';

      html += '<div class="manage-actions">';
      html += '<button id="addFolderBtn">+ Folder</button>';
      html += '<button id="addFileBtn">+ File</button>';
      html += '<button id="refreshIndexBtn">Refresh Index</button>';
      html += '</div>';

      if (folders.length > 0) {
        folders.forEach((folder, idx) => {
          const files = filesByFolder[folder] || [];
          const folderId = 'folder-' + idx;
          const fileCount = files.length;
          const fileLabel = fileCount === 1 ? '1 file' : fileCount + ' files';

          html += '<div class="manage-section">';
          html += '<div class="manage-item folder" data-folder-id="' + folderId + '">';
          html += '<span class="manage-item-name" title="' + escapeHtml(folder) + '">';
          html += '<span class="folder-toggle" id="toggle-' + folderId + '">▼</span>';
          html += '📁 ' + escapeHtml(folder.split('/').pop()) + '</span>';
          html += '<span class="manage-item-count">' + fileLabel + '</span>';
          html += '<button data-action="removeFolder" data-folder="' + escapeHtml(folder) + '">×</button>';
          html += '</div>';

          html += '<div class="folder-files" id="files-' + folderId + '">';
          files.forEach(file => {
            const hasErrors = file.parseErrors && file.parseErrors.length > 0;
            html += '<div class="manage-item nested">';
            html += '<span class="manage-item-name file-link" data-path="' + escapeHtml(file.path) + '" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</span>';
            if (hasErrors) {
              const errorData = JSON.stringify(file.parseErrors).replace(/"/g, '&quot;');
              html += '<span class="error-indicator" data-errors="' + errorData + '" data-file="' + escapeHtml(file.name) + '" title="' + file.parseErrors.length + ' parsing error(s)">⚠</span>';
            }
            html += '<span class="manage-item-count">' + file.entryCount + '</span>';
            html += '<button data-action="removeFile" data-file="' + escapeHtml(file.path) + '">×</button>';
            html += '</div>';
          });
          html += '</div>';
          html += '</div>';
        });
      }

      const indivFiles = filesByFolder['_individual'] || [];
      if (indivFiles.length > 0) {
        html += '<div class="manage-section">';
        html += '<h4>Individual files</h4>';
        indivFiles.forEach(file => {
          const hasErrors = file.parseErrors && file.parseErrors.length > 0;
          html += '<div class="manage-item">';
          html += '<span class="manage-item-name file-link" data-path="' + escapeHtml(file.path) + '" title="' + escapeHtml(file.path) + '">' + escapeHtml(file.name) + '</span>';
          if (hasErrors) {
            const errorData = JSON.stringify(file.parseErrors).replace(/"/g, '&quot;');
            html += '<span class="error-indicator" data-errors="' + errorData + '" data-file="' + escapeHtml(file.name) + '" title="' + file.parseErrors.length + ' parsing error(s)">⚠</span>';
          }
          html += '<span class="manage-item-count">' + file.entryCount + '</span>';
          html += '<button data-action="removeFile" data-file="' + escapeHtml(file.path) + '">×</button>';
          html += '</div>';
        });
        html += '</div>';
      }

      if (folders.length === 0 && indivFiles.length === 0) {
        html += '<div class="placeholder">No files indexed yet.</div>';
      }

      manageContent.innerHTML = html;

      document.getElementById('addFolderBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addFolder' });
      });

      document.getElementById('addFileBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'addFile' });
      });

      document.getElementById('refreshIndexBtn')?.addEventListener('click', () => {
        vscode.postMessage({ command: 'reindex' });
      });

      // Folder collapse/expand toggles
      manageContent.querySelectorAll('.manage-item.folder').forEach(item => {
        item.addEventListener('click', (e) => {
          // Don't toggle if clicking the remove button
          if (e.target.tagName === 'BUTTON') return;

          const folderId = item.dataset.folderId;
          const toggle = document.getElementById('toggle-' + folderId);
          const filesDiv = document.getElementById('files-' + folderId);

          if (toggle && filesDiv) {
            toggle.classList.toggle('collapsed');
            filesDiv.classList.toggle('collapsed');
          }
        });
      });

      manageContent.querySelectorAll('button[data-action="removeFolder"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'removeFolder', folder: btn.dataset.folder });
        });
      });

      manageContent.querySelectorAll('button[data-action="removeFile"]').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ command: 'removeFile', file: btn.dataset.file });
        });
      });

      // Error indicator clicks
      manageContent.querySelectorAll('.error-indicator').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const errors = JSON.parse(el.dataset.errors);
          const fileName = el.dataset.file;
          showErrorsModal(fileName, errors);
        });
      });

      // File link clicks - open file in editor
      manageContent.querySelectorAll('.file-link').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ command: 'openFile', file: el.dataset.path });
        });
      });
    }

    function showErrorsModal(fileName, errors) {
      modalTitle.textContent = 'Parsing errors: ' + fileName;

      let html = '<div class="errors-list">';
      errors.forEach((err, idx) => {
        html += '<div class="error-item">';
        html += '<span class="error-number">' + (idx + 1) + '.</span> ';
        html += '<span class="error-message">' + escapeHtml(err) + '</span>';
        html += '</div>';
      });
      html += '</div>';

      modalBody.innerHTML = html;
      modalOverlay.classList.add('active');
    }

    function renderFilesModal(entries) {
      modalTitle.textContent = 'Found in ' + entries.length + ' files';

      let html = '';
      entries.forEach(e => {
        html += '<div class="modal-entry">';
        html += '<div class="modal-entry-header">';
        html += '<span class="modal-entry-title">';
        html += '<a href="#" class="modal-file-link" data-file="' + escapeHtml(e.file) + '" data-line="' + (e.startLine || 1) + '">' + escapeHtml(e.fileName) + '</a>';
        html += '<span class="modal-entry-key"> — ' + escapeHtml(e.key) + '</span>';
        html += '</span>';
        html += '<button class="modal-copy-btn" data-action="copy" data-file="' + escapeHtml(e.file) + '" data-key="' + escapeHtml(e.key) + '">Copy</button>';
        html += '</div>';
        html += '<div class="modal-entry-fields">';
        e.fields.forEach(f => {
          html += '<div class="modal-field-row">';
          html += '<span class="modal-field-name">' + escapeHtml(f.name) + '</span>';
          html += '<span class="modal-field-value">' + escapeHtml(f.value) + '</span>';
          html += '</div>';
        });
        html += '</div>';
        html += '</div>';
      });

      modalBody.innerHTML = html;
      modalOverlay.classList.add('active');

      // Attach file link event listeners
      modalBody.querySelectorAll('.modal-file-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          vscode.postMessage({ command: 'openFile', file: link.dataset.file, line: parseInt(link.dataset.line, 10) });
        });
      });

      // Attach copy button event listeners
      modalBody.querySelectorAll('.modal-copy-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          vscode.postMessage({ command: 'copyEntry', file: btn.dataset.file, key: btn.dataset.key });
          showCopyFeedback(btn);
        });
      });
    }

    function attachEventListeners() {
      content.querySelectorAll('button[data-action]').forEach(btn => {
        btn.addEventListener('click', () => {
          const action = btn.dataset.action;
          const file = btn.dataset.file;
          const key = btn.dataset.key;
          const field = btn.dataset.field;

          if (action === 'copy') {
            vscode.postMessage({ command: 'copyEntry', file, key });
            showCopyFeedback(btn);
          } else if (action === 'insert') {
            vscode.postMessage({ command: 'insertField', file, key, field });
          } else if (action === 'insertEntry') {
            vscode.postMessage({ command: 'insertEntry', file, key });
          } else if (action === 'insertFieldValue') {
            vscode.postMessage({ command: 'insertFieldValue', field, value: btn.dataset.value });
          } else if (action === 'copySuperCard') {
            const fields = JSON.parse(btn.dataset.mergedFields);
            vscode.postMessage({ command: 'copySuperCard', fields, entryType: btn.dataset.entryType, key });
            showCopyFeedback(btn);
          } else if (action === 'insertSuperCard') {
            const fields = JSON.parse(btn.dataset.mergedFields);
            vscode.postMessage({ command: 'insertSuperCard', fields, entryType: btn.dataset.entryType, key });
          }
        });
      });

      content.querySelectorAll('.entry-source').forEach(el => {
        el.addEventListener('click', () => {
          const filesData = el.dataset.files;
          if (filesData && filesData !== '[]') {
            const entries = JSON.parse(filesData);
            vscode.postMessage({ command: 'showFilesModal', entries });
          }
        });
      });

      content.querySelectorAll('.ellipsis').forEach(el => {
        el.addEventListener('click', (e) => {
          e.stopPropagation();
          const targetId = el.dataset.target;
          const target = document.getElementById(targetId);
          if (target && target.dataset.full) {
            target.innerHTML = escapeHtml(target.dataset.full);
          }
        });
      });

      content.querySelectorAll('.field-link').forEach(link => {
        link.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (link.dataset.url) {
            vscode.postMessage({ command: 'openExternal', url: link.dataset.url });
          }
        });
      });
    }

    function showCopyFeedback(btn) {
      const originalText = btn.textContent;
      btn.textContent = 'Copied!';
      btn.disabled = true;
      setTimeout(() => {
        btn.textContent = originalText;
        btn.disabled = false;
      }, 1500);
    }

    function escapeHtml(text) {
      if (!text) return '';
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    function truncate(text, maxLen) {
      if (!text || text.length <= maxLen) return text || '';
      return text.substring(0, maxLen - 3) + '...';
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

interface DisplayEntry {
  key: string;
  file: string;
  fileName: string;
  fileCount: number;
  allFiles: { file: string; key: string }[];
  entryType: string;
  title: string;
  author: string;
  year: string;
  fields: DisplayField[];
  mergedFields?: string;        // JSON of merged fields for super card copy/insert
  clusterId?: number;           // For cluster boundary rendering in search results
  isFirstInCluster?: boolean;   // First card in a cluster
}

interface DisplayField {
  name: string;
  value: string;
  status: 'same' | 'only-theirs' | 'only-yours' | 'different';
  canCopy: boolean;
  diffHtml: string | null;
  linkTarget?: string;
}
