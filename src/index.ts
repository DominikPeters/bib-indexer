/**
 * Index storage and management
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
// Note: fs sync is still used for initialize() (reading cached index at startup)
// and saveIndex() where sync write is needed for reliability
import * as path from 'path';
import { BibIndex, IndexedEntry, IndexedFile } from './types';
import { parseBibFile } from './parser';
import { SearchIndexManager } from './search';

// Bump this when parser changes require reindexing (e.g., field normalization changes)
const INDEX_VERSION = 6;
const INDEX_FILENAME = 'bib-index.json';

/**
 * Manages the global bibliography index
 */
export class BibIndexManager {
  private index: BibIndex;
  private indexPath: string;
  private outputChannel: vscode.OutputChannel;
  private onDidUpdateEmitter = new vscode.EventEmitter<void>();
  private searchIndex: SearchIndexManager;
  private entriesByFile: Map<string, IndexedEntry[]> = new Map();

  /** Event fired when background validation completes and index is updated */
  public readonly onDidUpdate = this.onDidUpdateEmitter.event;

  constructor(
    private context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
  ) {
    this.indexPath = path.join(context.globalStorageUri.fsPath, INDEX_FILENAME);
    this.outputChannel = outputChannel;
    this.index = this.createEmptyIndex();
    this.searchIndex = new SearchIndexManager();
  }

  /**
   * Initialize the index - loads cached data immediately, then validates in background
   * Returns quickly so extension activation is not blocked
   */
  async initialize(): Promise<void> {
    // Ensure storage directory exists
    const storageDir = this.context.globalStorageUri.fsPath;
    if (!fs.existsSync(storageDir)) {
      fs.mkdirSync(storageDir, { recursive: true });
    }

    // Load existing index or create new (this is fast - just reading JSON)
    let needsFullReindex = false;
    if (fs.existsSync(this.indexPath)) {
      try {
        const content = fs.readFileSync(this.indexPath, 'utf-8');
        const loaded = JSON.parse(content) as BibIndex;

        if (loaded.version === INDEX_VERSION) {
          this.index = loaded;
          this.normalizeLoadedEntries(this.index.entries);
          this.searchIndex.rebuild(this.index.entries);
          this.log(`Loaded index with ${this.index.entries.length} entries from ${Object.keys(this.index.files).length} files`);
        } else {
          this.log('Index version mismatch, will rebuild in background...');
          // Migrate: preserve user's file/folder configuration
          if (loaded.folders) {
            this.index.folders = loaded.folders;
          }
          if (loaded.individualFiles) {
            this.index.individualFiles = loaded.individualFiles;
          }
          if (loaded.excludedFiles) {
            this.index.excludedFiles = loaded.excludedFiles;
          }
          needsFullReindex = true;
        }
      } catch (error) {
        this.log(`Failed to load index: ${error}`);
        this.index = this.createEmptyIndex();
      }
    }

    // Load folders from settings (but preserve any from old index if settings is empty)
    const config = vscode.workspace.getConfiguration('tooManyBibs');
    const foldersFromSettings = config.get<string[]>('indexedFolders') ?? [];
    if (foldersFromSettings.length > 0) {
      this.index.folders = foldersFromSettings;
    } else if (this.index.folders.length > 0) {
      // Migrate folders from old index to settings
      this.log('Migrating folders from index to settings...');
      config.update('indexedFolders', this.index.folders, vscode.ConfigurationTarget.Global);
    }

    // Start background validation (don't await - let it run async)
    this.runBackgroundValidation(needsFullReindex);
  }

  /**
   * Run validation in the background without blocking
   */
  private async runBackgroundValidation(fullReindex: boolean): Promise<void> {
    try {
      if (fullReindex) {
        await this.reindexAll();
      } else {
        await this.validateAndUpdate();
      }
      this.onDidUpdateEmitter.fire();
    } catch (error) {
      this.log(`Background validation error: ${error}`);
    }
  }

  /**
   * Save the index to disk
   */
  private saveIndex(): void {
    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(this.index, null, 2));
    } catch (error) {
      this.log(`Failed to save index: ${error}`);
    }
  }

  private normalizeLoadedEntries(entries: IndexedEntry[]): void {
    this.entriesByFile.clear();
    for (const entry of entries) {
      if (!entry.fields) {
        entry.fields = {};
      }
      if (!entry.creators) {
        entry.creators = {};
      }
      const existing = this.entriesByFile.get(entry.file) ?? [];
      existing.push(entry);
      this.entriesByFile.set(entry.file, existing);
    }
  }

  /**
   * Add a folder to the index
   */
  async addFolder(folderPath: string): Promise<void> {
    const resolvedPath = path.resolve(folderPath);

    try {
      await fsPromises.access(resolvedPath);
    } catch {
      vscode.window.showErrorMessage(`Folder does not exist: ${resolvedPath}`);
      return;
    }

    if (this.index.folders.includes(resolvedPath)) {
      vscode.window.showInformationMessage(`Folder already indexed: ${resolvedPath}`);
      return;
    }

    this.index.folders.push(resolvedPath);
    await this.updateSettings();

    // Scan the new folder
    await this.scanFolder(resolvedPath);
    this.saveIndex();

    vscode.window.showInformationMessage(`Added folder to index: ${resolvedPath}`);
  }

  /**
   * Remove a folder from the index
   */
  async removeFolder(folderPath: string): Promise<void> {
    const resolvedPath = path.resolve(folderPath);
    const folderIndex = this.index.folders.indexOf(resolvedPath);

    if (folderIndex === -1) {
      vscode.window.showErrorMessage(`Folder not in index: ${resolvedPath}`);
      return;
    }

    this.index.folders.splice(folderIndex, 1);
    await this.updateSettings();

    // Remove entries from this folder (but not individual files that were added separately)
    const prefix = resolvedPath + path.sep;
    for (const filePath of Object.keys(this.index.files)) {
      if (filePath.startsWith(prefix) && !this.index.individualFiles.includes(filePath)) {
        this.removeFileFromIndex(filePath);
      }
    }

    this.saveIndex();
    vscode.window.showInformationMessage(`Removed folder from index: ${resolvedPath}`);
  }

  /**
   * Add an individual file to the index
   */
  async addFile(filePath: string): Promise<void> {
    const resolvedPath = path.resolve(filePath);

    try {
      await fsPromises.access(resolvedPath);
    } catch {
      vscode.window.showErrorMessage(`File does not exist: ${resolvedPath}`);
      return;
    }

    if (!resolvedPath.endsWith('.bib')) {
      vscode.window.showErrorMessage(`Not a .bib file: ${resolvedPath}`);
      return;
    }

    if (this.index.files[resolvedPath]) {
      vscode.window.showInformationMessage(`File already indexed: ${resolvedPath}`);
      return;
    }

    // Add to individual files list if not in a watched folder
    if (!this.isInWatchedFolder(resolvedPath)) {
      if (!this.index.individualFiles.includes(resolvedPath)) {
        this.index.individualFiles.push(resolvedPath);
      }
    }

    // Remove from excluded list if it was there
    const excludedIdx = this.index.excludedFiles.indexOf(resolvedPath);
    if (excludedIdx !== -1) {
      this.index.excludedFiles.splice(excludedIdx, 1);
    }

    await this.indexFile(resolvedPath);
    this.saveIndex();

    vscode.window.showInformationMessage(`Added file to index: ${path.basename(resolvedPath)}`);
  }

  /**
   * Remove a file from the index
   */
  removeFile(filePath: string): void {
    const resolvedPath = path.resolve(filePath);

    if (!this.index.files[resolvedPath]) {
      return;
    }

    // Remove from individual files list
    const indivIdx = this.index.individualFiles.indexOf(resolvedPath);
    if (indivIdx !== -1) {
      this.index.individualFiles.splice(indivIdx, 1);
    }

    // If file is in a watched folder, add to excluded list so it won't be re-added
    if (this.isInWatchedFolder(resolvedPath)) {
      if (!this.index.excludedFiles.includes(resolvedPath)) {
        this.index.excludedFiles.push(resolvedPath);
      }
    }

    this.removeFileFromIndex(resolvedPath);
    this.saveIndex();
  }

  /**
   * Check if a file is inside one of the watched folders
   */
  private isInWatchedFolder(filePath: string): boolean {
    for (const folder of this.index.folders) {
      if (filePath.startsWith(folder + path.sep)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Update settings with current folder list
   */
  private async updateSettings(): Promise<void> {
    const config = vscode.workspace.getConfiguration('tooManyBibs');
    await config.update('indexedFolders', this.index.folders, vscode.ConfigurationTarget.Global);
  }

  /**
   * Get list of indexed folders
   */
  getFolders(): string[] {
    return [...this.index.folders];
  }

  /**
   * Get list of individual files
   */
  getIndividualFiles(): string[] {
    return [...this.index.individualFiles];
  }

  /**
   * Get all entries
   */
  getEntries(): IndexedEntry[] {
    return this.index.entries;
  }

  /**
   * Get entries from a specific file
   */
  getEntriesForFile(filePath: string): IndexedEntry[] {
    return this.index.entries.filter(e => e.file === filePath);
  }

  /**
   * Get indexed file info
   */
  getFiles(): Record<string, IndexedFile> {
    return this.index.files;
  }

  /**
   * Get the search index for fast searches
   */
  getSearchIndex(): SearchIndexManager {
    return this.searchIndex;
  }

  /**
   * Reindex all files
   * @param onProgress Optional callback for progress reporting
   */
  async reindexAll(onProgress?: (indexed: number, total: number) => void): Promise<void> {
    this.log('Starting full reindex...');
    this.index.entries = [];
    this.index.files = {};
    this.entriesByFile.clear();

    // Discover all files first to know total count
    const allFiles: { filePath: string; fromFolder: boolean }[] = [];

    for (const folder of this.index.folders) {
      try {
        await fsPromises.access(folder);
        const bibFiles = await this.findBibFiles(folder);
        for (const filePath of bibFiles) {
          if (!this.index.excludedFiles.includes(filePath)) {
            allFiles.push({ filePath, fromFolder: true });
          }
        }
      } catch {
        // Folder doesn't exist
      }
    }

    for (const filePath of this.index.individualFiles) {
      try {
        await fsPromises.access(filePath);
        if (!allFiles.some(f => f.filePath === filePath)) {
          allFiles.push({ filePath, fromFolder: false });
        }
      } catch {
        // File doesn't exist
      }
    }

    this.log(`Found ${allFiles.length} .bib files to index`);

    // Index all files
    for (let i = 0; i < allFiles.length; i++) {
      await this.indexFile(allFiles[i].filePath);
      onProgress?.(i + 1, allFiles.length);
    }

    this.searchIndex.rebuild(this.index.entries);
    this.saveIndex();
    this.log(`Reindex complete: ${this.index.entries.length} entries from ${Object.keys(this.index.files).length} files`);
  }

  /**
   * Check for changed files and update the index
   */
  private async validateAndUpdate(): Promise<void> {
    const filesToReindex: string[] = [];
    const filesToRemove: string[] = [];

    // Check existing indexed files
    for (const [filePath, fileInfo] of Object.entries(this.index.files)) {
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.mtimeMs > fileInfo.mtime) {
          filesToReindex.push(filePath);
        }
      } catch {
        filesToRemove.push(filePath);
      }
    }

    // Remove entries for deleted files
    for (const filePath of filesToRemove) {
      this.removeFileFromIndex(filePath);
    }

    // Reindex changed files
    for (const filePath of filesToReindex) {
      await this.indexFile(filePath);
    }

    // Scan folders for new files (respects exclusions)
    for (const folder of this.index.folders) {
      await this.scanFolder(folder, true);
    }

    // Check individual files
    for (const filePath of this.index.individualFiles) {
      if (!this.index.files[filePath]) {
        try {
          await fsPromises.access(filePath);
          await this.indexFile(filePath);
        } catch {
          // File doesn't exist
        }
      }
    }

    if (filesToRemove.length > 0 || filesToReindex.length > 0) {
      this.saveIndex();
      this.log(`Updated index: removed ${filesToRemove.length} files, reindexed ${filesToReindex.length} files`);
    }
  }

  /**
   * Scan a folder recursively for .bib files
   */
  private async scanFolder(folderPath: string, skipExisting = false): Promise<void> {
    try {
      await fsPromises.access(folderPath);
    } catch {
      return;
    }

    const bibFiles = await this.findBibFiles(folderPath);
    this.log(`Found ${bibFiles.length} .bib files in ${folderPath}`);

    for (const filePath of bibFiles) {
      if (this.index.excludedFiles.includes(filePath)) {
        continue;
      }
      if (skipExisting && this.index.files[filePath]) {
        continue;
      }
      await this.indexFile(filePath);
    }
  }

  /**
   * Find all .bib files in a directory recursively
   */
  private async findBibFiles(dir: string): Promise<string[]> {
    const files: string[] = [];

    const scanDir = async (currentDir: string) => {
      try {
        const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await scanDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith('.bib')) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        this.log(`Error scanning directory ${currentDir}: ${error}`);
      }
    };

    await scanDir(dir);
    return files;
  }

  /**
   * Index a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const [content, stat] = await Promise.all([
        fsPromises.readFile(filePath, 'utf-8'),
        fsPromises.stat(filePath),
      ]);

      // Remove old entries from this file
      this.removeFileFromIndex(filePath);

      // Parse and add new entries
      const { entries, errors } = parseBibFile(content, filePath);

      this.entriesByFile.set(filePath, entries);
      this.index.entries.push(...entries);
      this.searchIndex.addEntries(entries);
      this.index.files[filePath] = {
        path: filePath,
        mtime: stat.mtimeMs,
        entryCount: entries.length,
        parseErrors: errors.length > 0 ? errors : undefined,
      };

      if (errors.length > 0) {
        this.log(`Indexed ${entries.length} entries from ${path.basename(filePath)} (${errors.length} errors)`);
      } else {
        this.log(`Indexed ${entries.length} entries from ${path.basename(filePath)}`);
      }
    } catch (error) {
      this.log(`Failed to index ${filePath}: ${error}`);
    }
  }

  /**
   * Remove all entries for a file from the index
   */
  private removeFileFromIndex(filePath: string): void {
    this.searchIndex.removeFile(filePath);
    this.entriesByFile.delete(filePath);
    this.rebuildEntriesFromMap();
    delete this.index.files[filePath];
  }

  private rebuildEntriesFromMap(): void {
    this.index.entries = [];
    for (const entries of this.entriesByFile.values()) {
      this.index.entries.push(...entries);
    }
  }

  /**
   * Start watching for .bib file changes in watched folders
   * Returns a disposable to stop watching
   */
  startWatching(): vscode.Disposable {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.bib');
    let debounceTimer: NodeJS.Timeout | undefined;

    const handleChange = (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      // Only handle files that are in watched folders or individually tracked
      if (!this.isInWatchedFolder(filePath) && !this.index.individualFiles.includes(filePath)) {
        return;
      }
      if (this.index.excludedFiles.includes(filePath)) {
        return;
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(async () => {
        this.log(`File changed: ${path.basename(filePath)}`);
        await this.indexFile(filePath);
        this.saveIndex();
        this.onDidUpdateEmitter.fire();
      }, 500);
    };

    const handleCreate = (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!this.isInWatchedFolder(filePath) || this.index.excludedFiles.includes(filePath)) {
        return;
      }
      if (this.index.files[filePath]) {
        return; // Already indexed
      }

      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(async () => {
        this.log(`File created: ${path.basename(filePath)}`);
        await this.indexFile(filePath);
        this.saveIndex();
        this.onDidUpdateEmitter.fire();
      }, 500);
    };

    const handleDelete = (uri: vscode.Uri) => {
      const filePath = uri.fsPath;
      if (!this.index.files[filePath]) {
        return;
      }

      this.log(`File deleted: ${path.basename(filePath)}`);
      this.removeFileFromIndex(filePath);
      this.saveIndex();
      this.onDidUpdateEmitter.fire();
    };

    watcher.onDidChange(handleChange);
    watcher.onDidCreate(handleCreate);
    watcher.onDidDelete(handleDelete);

    return new vscode.Disposable(() => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      watcher.dispose();
    });
  }

  /**
   * Create an empty index structure
   */
  private createEmptyIndex(): BibIndex {
    return {
      version: INDEX_VERSION,
      folders: [],
      individualFiles: [],
      excludedFiles: [],
      files: {},
      entries: [],
    };
  }

  /**
   * Log a message to the output channel
   */
  private log(message: string): void {
    this.outputChannel.appendLine(`[TooManyBibs] ${message}`);
  }
}
