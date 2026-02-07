/**
 * Index storage and management
 */

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
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
        await this.reindexAllAsync();
      } else {
        await this.validateAndUpdateAsync();
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
    for (const entry of entries) {
      if (!entry.fields) {
        entry.fields = {};
      }
      if (!entry.creators) {
        entry.creators = {};
      }
    }
  }

  /**
   * Add a folder to the index
   */
  async addFolder(folderPath: string): Promise<void> {
    const resolvedPath = path.resolve(folderPath);

    if (!fs.existsSync(resolvedPath)) {
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
    this.searchIndex.rebuild(this.index.entries);
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

    this.searchIndex.rebuild(this.index.entries);
    this.saveIndex();
    vscode.window.showInformationMessage(`Removed folder from index: ${resolvedPath}`);
  }

  /**
   * Add an individual file to the index
   */
  async addFile(filePath: string): Promise<void> {
    const resolvedPath = path.resolve(filePath);

    if (!fs.existsSync(resolvedPath)) {
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
    this.searchIndex.rebuild(this.index.entries);
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
    this.searchIndex.rebuild(this.index.entries);
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
   * Reindex all files (sync version for user-triggered actions with progress)
   */
  async reindexAll(): Promise<void> {
    this.log('Starting full reindex...');
    this.index.entries = [];
    this.index.files = {};

    // Scan folders
    for (const folder of this.index.folders) {
      await this.scanFolder(folder);
    }

    // Index individual files
    for (const filePath of this.index.individualFiles) {
      if (fs.existsSync(filePath) && !this.index.files[filePath]) {
        await this.indexFile(filePath);
      }
    }

    this.searchIndex.rebuild(this.index.entries);
    this.saveIndex();
    this.log(`Reindex complete: ${this.index.entries.length} entries from ${Object.keys(this.index.files).length} files`);
  }

  /**
   * Reindex all files (async version for background operations)
   */
  private async reindexAllAsync(): Promise<void> {
    this.log('Starting background full reindex...');
    this.index.entries = [];
    this.index.files = {};

    // Scan folders
    for (const folder of this.index.folders) {
      await this.scanFolderAsync(folder);
    }

    // Index individual files
    for (const filePath of this.index.individualFiles) {
      if (!this.index.files[filePath]) {
        try {
          await fsPromises.access(filePath);
          await this.indexFileAsync(filePath);
        } catch {
          // File doesn't exist
        }
      }
    }

    this.searchIndex.rebuild(this.index.entries);
    this.saveIndex();
    this.log(`Background reindex complete: ${this.index.entries.length} entries from ${Object.keys(this.index.files).length} files`);
  }

  /**
   * Check for changed files and update the index (async, non-blocking)
   */
  private async validateAndUpdateAsync(): Promise<void> {
    const filesToReindex: string[] = [];
    const filesToRemove: string[] = [];

    // Check existing indexed files using async operations
    for (const [filePath, fileInfo] of Object.entries(this.index.files)) {
      try {
        const stat = await fsPromises.stat(filePath);
        if (stat.mtimeMs > fileInfo.mtime) {
          filesToReindex.push(filePath);
        }
      } catch {
        // File doesn't exist or can't be accessed
        filesToRemove.push(filePath);
      }
    }

    // Remove entries for deleted files
    for (const filePath of filesToRemove) {
      this.removeFileFromIndex(filePath);
    }

    // Reindex changed files
    for (const filePath of filesToReindex) {
      await this.indexFileAsync(filePath);
    }

    // Scan folders for new files (respects exclusions)
    for (const folder of this.index.folders) {
      await this.scanFolderAsync(folder, true);
    }

    // Check individual files
    for (const filePath of this.index.individualFiles) {
      if (!this.index.files[filePath]) {
        try {
          await fsPromises.access(filePath);
          await this.indexFileAsync(filePath);
        } catch {
          // File doesn't exist
        }
      }
    }

    if (filesToRemove.length > 0 || filesToReindex.length > 0) {
      this.searchIndex.rebuild(this.index.entries);
      this.saveIndex();
      this.log(`Updated index: removed ${filesToRemove.length} files, reindexed ${filesToReindex.length} files`);
    }
  }

  /**
   * Scan a folder recursively for .bib files (sync version)
   */
  private async scanFolder(folderPath: string, skipExisting = false): Promise<void> {
    if (!fs.existsSync(folderPath)) {
      return;
    }

    const bibFiles = this.findBibFiles(folderPath);
    this.log(`Found ${bibFiles.length} .bib files in ${folderPath}`);

    for (const filePath of bibFiles) {
      // Skip excluded files
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
   * Scan a folder recursively for .bib files (async version)
   */
  private async scanFolderAsync(folderPath: string, skipExisting = false): Promise<void> {
    try {
      await fsPromises.access(folderPath);
    } catch {
      return;
    }

    const bibFiles = await this.findBibFilesAsync(folderPath);
    this.log(`Found ${bibFiles.length} .bib files in ${folderPath}`);

    for (const filePath of bibFiles) {
      // Skip excluded files
      if (this.index.excludedFiles.includes(filePath)) {
        continue;
      }

      if (skipExisting && this.index.files[filePath]) {
        continue;
      }
      await this.indexFileAsync(filePath);
    }
  }

  /**
   * Find all .bib files in a directory recursively (sync version)
   */
  private findBibFiles(dir: string): string[] {
    const files: string[] = [];

    const scanDir = (currentDir: string) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            // Skip hidden directories and common non-source directories
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              scanDir(fullPath);
            }
          } else if (entry.isFile() && entry.name.endsWith('.bib')) {
            files.push(fullPath);
          }
        }
      } catch (error) {
        this.log(`Error scanning directory ${currentDir}: ${error}`);
      }
    };

    scanDir(dir);
    return files;
  }

  /**
   * Find all .bib files in a directory recursively (async version)
   */
  private async findBibFilesAsync(dir: string): Promise<string[]> {
    const files: string[] = [];

    const scanDir = async (currentDir: string) => {
      try {
        const entries = await fsPromises.readdir(currentDir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);

          if (entry.isDirectory()) {
            // Skip hidden directories and common non-source directories
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
   * Index a single file (sync version for user-triggered actions)
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const stat = fs.statSync(filePath);

      // Remove old entries from this file
      this.removeFileFromIndex(filePath);

      // Parse and add new entries
      const { entries, errors } = parseBibFile(content, filePath);

      this.index.entries.push(...entries);
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
   * Index a single file (async version for background operations)
   */
  private async indexFileAsync(filePath: string): Promise<void> {
    try {
      const [content, stat] = await Promise.all([
        fsPromises.readFile(filePath, 'utf-8'),
        fsPromises.stat(filePath),
      ]);

      // Remove old entries from this file
      this.removeFileFromIndex(filePath);

      // Parse and add new entries
      const { entries, errors } = parseBibFile(content, filePath);

      this.index.entries.push(...entries);
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
    this.index.entries = this.index.entries.filter(e => e.file !== filePath);
    delete this.index.files[filePath];
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
