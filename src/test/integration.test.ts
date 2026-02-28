import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { BibIndexManager } from '../index';
import { SidebarProvider } from '../sidebar/sidebarProvider';

const fixturesDir = path.join(__dirname, '..', '..', 'src', 'test', 'fixtures');
const sampleBib = path.join(fixturesDir, 'sample.bib');
const sample2Bib = path.join(fixturesDir, 'sample2.bib');

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs = 5000,
  intervalMs = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) {
      return true;
    }
    await wait(intervalMs);
  }
  return predicate();
}

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bib-indexer-test-'));
}

function createWorkspaceTempDir(): string {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const baseDir = workspaceRoot ?? fixturesDir;
  return fs.mkdtempSync(path.join(baseDir, 'bib-indexer-watch-'));
}

function cleanupFixtureTmpDirs(): void {
  const entries = fs.readdirSync(fixturesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith('tmp-')) {
      fs.rmSync(path.join(fixturesDir, entry.name), { recursive: true, force: true });
    }
  }
}

function writeBibFile(dir: string, name: string, content: string): string {
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function createMockContext(storageDir: string): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file(storageDir),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function createOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel('BibIndexer Test');
}

function createTestIndexManager(storageDir: string): BibIndexManager {
  const context = createMockContext(storageDir);
  const channel = createOutputChannel();
  return new BibIndexManager(context, channel);
}

async function openFixture(name: string): Promise<vscode.TextEditor> {
  const filePath = path.join(fixturesDir, name);
  const doc = await vscode.workspace.openTextDocument(filePath);
  return vscode.window.showTextDocument(doc);
}

function setCursor(editor: vscode.TextEditor, line: number, character = 0): void {
  const pos = new vscode.Position(line, character);
  editor.selection = new vscode.Selection(pos, pos);
}

async function activateExtensionForEditorFeatures(): Promise<void> {
  const extension = vscode.extensions.all.find(ext => ext.packageJSON?.name === 'bib-indexer');
  assert.ok(extension, 'Bib Indexer extension should be available in integration tests');
  if (!extension!.isActive) {
    await extension!.activate();
  }
}

function linkTargetToString(link: vscode.DocumentLink): string {
  return link.target?.toString() ?? '';
}

suite('Integration: BibIndexManager with real files', () => {
  let indexManager: BibIndexManager;
  let storageDir: string;

  setup(() => {
    cleanupFixtureTmpDirs();
    storageDir = createTempDir();
    indexManager = createTestIndexManager(storageDir);
  });

  teardown(() => {
    cleanupFixtureTmpDirs();
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('should index .bib files from a folder', async () => {
    await indexManager.addFolder(fixturesDir);

    const entries = indexManager.getEntries();
    assert.ok(entries.length >= 6, `Expected at least 6 entries, got ${entries.length}`);

    const files = indexManager.getFiles();
    const filePaths = Object.keys(files);
    assert.ok(filePaths.some(f => f.endsWith('sample.bib')), 'Should include sample.bib');
    assert.ok(filePaths.some(f => f.endsWith('sample2.bib')), 'Should include sample2.bib');
  });

  test('should find entries for a specific file', async () => {
    await indexManager.addFolder(fixturesDir);

    const sampleEntries = indexManager.getEntriesForFile(sampleBib);
    assert.strictEqual(sampleEntries.length, 3, 'sample.bib should have 3 entries');

    const keys = sampleEntries.map(e => e.key).sort();
    assert.deepStrictEqual(keys, ['arrow1951social', 'nash1950equilibrium', 'rawls1971theory']);
  });

  test('should add and remove individual files', async () => {
    await indexManager.addFile(sampleBib);

    let entries = indexManager.getEntries();
    assert.strictEqual(entries.length, 3, 'Should have 3 entries after adding sample.bib');

    indexManager.removeFile(sampleBib);

    entries = indexManager.getEntries();
    assert.strictEqual(entries.length, 0, 'Should have 0 entries after removing sample.bib');
  });

  test('should persist and reload index', async () => {
    await indexManager.addFile(sampleBib);
    assert.strictEqual(indexManager.getEntries().length, 3);

    // Create a fresh manager with the same storage path
    const indexManager2 = createTestIndexManager(storageDir);
    await indexManager2.initialize();

    const entries = indexManager2.getEntries();
    assert.strictEqual(entries.length, 3, 'Reloaded index should have 3 entries');

    const keys = entries.map(e => e.key).sort();
    assert.deepStrictEqual(keys, ['arrow1951social', 'nash1950equilibrium', 'rawls1971theory']);
  });

  test('should detect duplicates across files via search index', async () => {
    await indexManager.addFile(sampleBib);
    await indexManager.addFile(sample2Bib);

    const searchIndex = indexManager.getSearchIndex();
    const nashEntry = indexManager.getEntriesForFile(sampleBib).find(e => e.key === 'nash1950equilibrium')!;
    assert.ok(nashEntry, 'Nash entry should exist in sample.bib');

    const candidates = searchIndex.findDuplicateCandidates(nashEntry);
    const nashDuplicate = candidates.find(c => c.file === sample2Bib && c.key === 'nash1950equilibrium');
    assert.ok(nashDuplicate, 'Should find Nash duplicate from sample2.bib');
  });

  test('should persist newly discovered files during background validation', async () => {
    const folder = createTempDir();
    const first = writeBibFile(folder, 'first.bib', `@article{first,
  title = {First},
  author = {One, Author},
  year = {2020}
}`);

    await indexManager.addFolder(folder);
    assert.strictEqual(indexManager.getEntriesForFile(first).length, 1);

    const second = writeBibFile(folder, 'second.bib', `@article{second,
  title = {Second},
  author = {Two, Author},
  year = {2021}
}`);

    await (indexManager as any).validateAndUpdate();
    assert.strictEqual(indexManager.getEntriesForFile(second).length, 1, 'New file should be indexed');

    const reloaded = createTestIndexManager(storageDir);
    await reloaded.initialize();
    assert.strictEqual(reloaded.getEntriesForFile(second).length, 1, 'Newly discovered file should persist across reload');

    fs.rmSync(folder, { recursive: true, force: true });
  });

  test('should persist newly discovered individual files during background validation', async () => {
    const first = writeBibFile(fixturesDir, 'tmp-individual-first.bib', `@article{tmpFirst,
  title = {Tmp First},
  author = {Tmp, One},
  year = {2020}
}`);
    const second = path.join(fixturesDir, 'tmp-individual-second.bib');

    await indexManager.addFile(first);
    assert.strictEqual(indexManager.getEntriesForFile(first).length, 1);

    const rawIndexManager = indexManager as unknown as {
      index: { individualFiles: string[] };
      validateAndUpdate: () => Promise<void>;
    };
    rawIndexManager.index.individualFiles.push(second);

    writeBibFile(fixturesDir, 'tmp-individual-second.bib', `@article{tmpSecond,
  title = {Tmp Second},
  author = {Tmp, Two},
  year = {2021}
}`);

    await rawIndexManager.validateAndUpdate();
    assert.strictEqual(indexManager.getEntriesForFile(second).length, 1, 'Second individual file should be indexed');

    const reloaded = createTestIndexManager(storageDir);
    await reloaded.initialize();
    assert.strictEqual(reloaded.getEntriesForFile(second).length, 1, 'Second individual file should persist across reload');

    fs.rmSync(first, { force: true });
    fs.rmSync(second, { force: true });
  });

  test('should debounce file watcher per file without dropping parallel updates', async function() {
    this.timeout(10000);
    const folder = createWorkspaceTempDir();
    const fileA = writeBibFile(folder, 'a.bib', `@article{a0,
  title = {A0},
  author = {A, Author},
  year = {2020}
}`);
    const fileB = writeBibFile(folder, 'b.bib', `@article{b0,
  title = {B0},
  author = {B, Author},
  year = {2020}
}`);

    await indexManager.addFolder(folder);
    const watcher = indexManager.startWatching();
    try {
      // Give the watcher a moment to start delivering events.
      await wait(200);

      fs.writeFileSync(fileA, `@article{a0,
  title = {A0},
  author = {A, Author},
  year = {2020}
}

@article{a1,
  title = {A1},
  author = {A, Author},
  year = {2021}
}`, 'utf-8');

      fs.writeFileSync(fileB, `@article{b0,
  title = {B0},
  author = {B, Author},
  year = {2020}
}

@article{b1,
  title = {B1},
  author = {B, Author},
  year = {2021}
}`, 'utf-8');

      const updated = await waitForCondition(() => {
        const aKeys = indexManager.getEntriesForFile(fileA).map(e => e.key);
        const bKeys = indexManager.getEntriesForFile(fileB).map(e => e.key);
        return aKeys.includes('a1') && bKeys.includes('b1');
      });

      const aKeys = indexManager.getEntriesForFile(fileA).map(e => e.key);
      const bKeys = indexManager.getEntriesForFile(fileB).map(e => e.key);
      assert.ok(updated, 'Watcher should index both updated files within timeout');
      assert.ok(aKeys.includes('a1'), 'Watcher should apply update for file A');
      assert.ok(bKeys.includes('b1'), 'Watcher should apply update for file B');
    } finally {
      watcher.dispose();
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

suite('Integration: Cursor tracking', () => {
  let indexManager: BibIndexManager;
  let sidebarProvider: SidebarProvider;
  let storageDir: string;

  setup(() => {
    storageDir = createTempDir();
    indexManager = createTestIndexManager(storageDir);
    sidebarProvider = new SidebarProvider(vscode.Uri.file(fixturesDir), indexManager);
  });

  teardown(async () => {
    // Close all editors
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('should identify entry under cursor', async () => {
    const editor = await openFixture('sample.bib');
    setCursor(editor, 1); // Line 2 (0-indexed: 1) is inside Nash entry

    sidebarProvider.onCursorMoved(editor);

    const current = sidebarProvider.getCurrentEntry();
    assert.ok(current, 'Should have a current entry');
    assert.strictEqual(current!.key, 'nash1950equilibrium');
  });

  test('should update when cursor moves to different entry', async () => {
    const editor = await openFixture('sample.bib');

    setCursor(editor, 1); // Nash entry
    sidebarProvider.onCursorMoved(editor);
    assert.strictEqual(sidebarProvider.getCurrentEntry()?.key, 'nash1950equilibrium');

    setCursor(editor, 15); // Arrow entry (line 16, 0-indexed: 15)
    sidebarProvider.onCursorMoved(editor);
    assert.strictEqual(sidebarProvider.getCurrentEntry()?.key, 'arrow1951social');
  });

  test('should clear entry when cursor is between entries', async () => {
    const editor = await openFixture('sample.bib');

    setCursor(editor, 1); // Nash entry
    sidebarProvider.onCursorMoved(editor);
    assert.ok(sidebarProvider.getCurrentEntry(), 'Should be on an entry');

    setCursor(editor, 12); // Blank line between entries (line 13, 0-indexed: 12)
    sidebarProvider.onCursorMoved(editor);
    assert.strictEqual(sidebarProvider.getCurrentEntry(), null, 'Should be null between entries');
  });

  test('should use cache on repeated cursor moves', async () => {
    const editor = await openFixture('sample.bib');

    // First call parses the document
    setCursor(editor, 1);
    sidebarProvider.onCursorMoved(editor);
    const entry1 = sidebarProvider.getCurrentEntry();
    assert.strictEqual(entry1?.key, 'nash1950equilibrium');

    // Second call without document edit should use cache (same version)
    setCursor(editor, 5);
    sidebarProvider.onCursorMoved(editor);
    const entry2 = sidebarProvider.getCurrentEntry();
    assert.strictEqual(entry2?.key, 'nash1950equilibrium', 'Same entry from cache');

    // Move to a different entry, still from cache
    setCursor(editor, 26); // Rawls entry
    sidebarProvider.onCursorMoved(editor);
    assert.strictEqual(sidebarProvider.getCurrentEntry()?.key, 'rawls1971theory');
  });
});

suite('Integration: Field and entry insertion', () => {
  let indexManager: BibIndexManager;
  let sidebarProvider: SidebarProvider;
  let storageDir: string;

  setup(async () => {
    storageDir = createTempDir();
    indexManager = createTestIndexManager(storageDir);
    sidebarProvider = new SidebarProvider(vscode.Uri.file(fixturesDir), indexManager);
    // Index sample2.bib so we can pull fields/entries from it
    await indexManager.addFile(sample2Bib);
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('should insert a missing field into current entry', async () => {
    // Open sample.bib - Arrow entry has no doi, but sample2.bib Arrow has doi
    const editor = await openFixture('sample.bib');
    setCursor(editor, 15); // Inside Arrow entry
    sidebarProvider.onCursorMoved(editor);

    assert.strictEqual(sidebarProvider.getCurrentEntry()?.key, 'arrow1951social');

    await sidebarProvider.handleInsertField(sample2Bib, 'arrow1951social', 'doi');

    const text = editor.document.getText();
    assert.ok(text.includes('doi = {10.2307/j.ctt1nqb90}'), 'doi field should be inserted');
  });

  test('should replace an existing field', async () => {
    // Open sample.bib - Nash entry has pages = {48--49}, sample2.bib has pages = {48--50}
    const editor = await openFixture('sample.bib');
    setCursor(editor, 1); // Inside Nash entry
    sidebarProvider.onCursorMoved(editor);

    assert.strictEqual(sidebarProvider.getCurrentEntry()?.key, 'nash1950equilibrium');

    await sidebarProvider.handleInsertField(sample2Bib, 'nash1950equilibrium', 'pages');

    const text = editor.document.getText();
    assert.ok(text.includes('pages = {48--50}'), 'pages should be replaced with new value');
    // Check it's not duplicated
    const pagesMatches = text.match(/pages\s*=/g);
    assert.strictEqual(pagesMatches?.length, 1, 'pages field should appear exactly once');
  });

  test('should insert a whole entry into current file', async () => {
    const editor = await openFixture('sample.bib');
    setCursor(editor, 1);
    sidebarProvider.onCursorMoved(editor);

    // Insert the Sen entry from sample2.bib (not in sample.bib)
    await sidebarProvider.handleInsertEntry(sample2Bib, 'sen1970impossibility');

    const text = editor.document.getText();
    assert.ok(text.includes('@article{sen1970impossibility'), 'Sen entry should be inserted');
    assert.ok(text.includes('Impossibility'), 'Sen title should be present');
  });

  test('should preserve indentation style', async () => {
    const editor = await openFixture('sample.bib');
    setCursor(editor, 15); // Inside Arrow entry
    sidebarProvider.onCursorMoved(editor);

    await sidebarProvider.handleInsertField(sample2Bib, 'arrow1951social', 'doi');

    const text = editor.document.getText();
    const doiLine = text.split('\n').find(l => l.includes('doi = {'));
    assert.ok(doiLine, 'doi line should exist');
    // sample.bib uses 2-space indent
    assert.ok(doiLine!.startsWith('  '), `Inserted field should use 2-space indent, got: "${doiLine}"`);
  });

  test('should replace an existing multiline field without leaving stale lines', async () => {
    const tempDir = createTempDir();
    const targetPath = writeBibFile(tempDir, 'target.bib', `@article{multiline,
  title = {Target},
  author = {Author, Target},
  note = {Line one
    line two
    line three},
  year = {2020}
}`);
    const sourcePath = writeBibFile(tempDir, 'source.bib', `@article{multiline,
  title = {Target},
  author = {Author, Target},
  note = {Replacement note},
  year = {2020}
}`);

    await indexManager.addFile(sourcePath);
    const doc = await vscode.workspace.openTextDocument(targetPath);
    const editor = await vscode.window.showTextDocument(doc);
    setCursor(editor, 2);
    sidebarProvider.onCursorMoved(editor);

    await sidebarProvider.handleInsertField(sourcePath, 'multiline', 'note');

    const text = editor.document.getText();
    assert.ok(text.includes('note = {Replacement note},'));
    assert.ok(!text.includes('line two'), 'Old multiline continuation should be removed');
    assert.ok(!text.includes('line three'), 'Old multiline continuation should be removed');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('should replace multiline field when it is the last field before closing brace', async () => {
    const tempDir = createTempDir();
    const targetPath = writeBibFile(tempDir, 'target-last.bib', `@article{multilineLast,
  title = {Target},
  author = {Author, Target},
  note = {Line one
    line two
    line three}
}`);
    const sourcePath = writeBibFile(tempDir, 'source-last.bib', `@article{multilineLast,
  title = {Target},
  author = {Author, Target},
  note = {Replacement final note}
}`);

    await indexManager.addFile(sourcePath);
    const doc = await vscode.workspace.openTextDocument(targetPath);
    const editor = await vscode.window.showTextDocument(doc);
    setCursor(editor, 2);
    sidebarProvider.onCursorMoved(editor);

    await sidebarProvider.handleInsertField(sourcePath, 'multilineLast', 'note');

    const text = editor.document.getText();
    assert.ok(text.includes('note = {Replacement final note},'));
    assert.ok(!text.includes('line two'), 'Old multiline continuation should be removed');
    assert.ok(!text.includes('line three'), 'Old multiline continuation should be removed');
    assert.ok(text.includes('\n}'), 'Closing brace should remain intact');

    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

suite('Integration: Search via index', () => {
  let indexManager: BibIndexManager;
  let storageDir: string;

  setup(async () => {
    storageDir = createTempDir();
    indexManager = createTestIndexManager(storageDir);
    await indexManager.addFile(sampleBib);
    await indexManager.addFile(sample2Bib);
  });

  teardown(() => {
    fs.rmSync(storageDir, { recursive: true, force: true });
  });

  test('should find entries by title keyword', () => {
    const results = indexManager.getSearchIndex().search('equilibrium');
    const keys = results.map(e => e.key);
    assert.ok(keys.includes('nash1950equilibrium'), 'Should find Nash by title keyword');
  });

  test('should find entries by author', () => {
    const results = indexManager.getSearchIndex().search('arrow');
    const keys = results.map(e => e.key);
    assert.ok(keys.some(k => k === 'arrow1951social'), 'Should find Arrow entries');
  });

  test('should find entries by citation key', () => {
    const results = indexManager.getSearchIndex().search('rawls1971');
    const keys = results.map(e => e.key);
    assert.ok(keys.includes('rawls1971theory'), 'Should find Rawls by citation key');
  });

  test('should find entries across both files', () => {
    const results = indexManager.getSearchIndex().search('nash');
    // Nash entry exists in both sample.bib and sample2.bib
    const files = results.filter(e => e.key === 'nash1950equilibrium').map(e => e.file);
    assert.ok(files.some(f => f.endsWith('sample.bib')), 'Should find Nash in sample.bib');
    assert.ok(files.some(f => f.endsWith('sample2.bib')), 'Should find Nash in sample2.bib');
  });
});

suite('Integration: Editor links', () => {
  setup(async () => {
    await activateExtensionForEditorFeatures();
  });

  teardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  test('should provide links for valid URL, DOI, and arXiv fields only', async () => {
    const tempDir = createTempDir();
    const filePath = writeBibFile(tempDir, 'links.bib', `@article{links,
  url = {https://example.com/paper},
  doi = {10.1000/xyz123},
  archivePrefix = {arXiv},
  eprint = {1611.08826},
  eprint = {1701.00001},
  archivePrefix = {arXiv},
  url = {www.example.com/no-scheme},
  doi = {not-a-doi},
  archivePrefix = {arXiv},
  year = {2016},
  eprint = {1701.00001},
  eprint = {1801.00001},
  year = {2018},
  archivePrefix = {arXiv},
  doi = "10.1000/valid" # suffix,
}`);

    const doc = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(doc);

    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
      'vscode.executeLinkProvider',
      doc.uri
    );

    const linkTargets = (links ?? []).map(linkTargetToString);
    assert.ok(linkTargets.includes('https://example.com/paper'), 'Expected valid URL link');
    assert.ok(linkTargets.includes('https://doi.org/10.1000/xyz123'), 'Expected canonical DOI link');
    assert.ok(linkTargets.includes('https://arxiv.org/abs/1611.08826'), 'Expected arXiv link');
    assert.ok(linkTargets.includes('https://arxiv.org/abs/1701.00001'), 'Expected reverse-order arXiv link');
    assert.ok(!linkTargets.includes('www.example.com/no-scheme'), 'Invalid URL should not be linked');
    assert.ok(!linkTargets.includes('https://doi.org/not-a-doi'), 'Invalid DOI should not be linked');
    assert.ok(!linkTargets.includes('https://arxiv.org/abs/1801.00001'), 'Non-adjacent reverse-order eprint should not be linked');
    assert.strictEqual(linkTargets.length, 4, `Expected exactly 4 links, got ${linkTargets.length}`);

    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('should provide links for untitled bibtex documents', async () => {
    const doc = await vscode.workspace.openTextDocument({
      language: 'bibtex',
      content: `@article{untitled,
  doi = {10.5555/12345678}
}`,
    });
    await vscode.window.showTextDocument(doc);

    const links = await vscode.commands.executeCommand<vscode.DocumentLink[]>(
      'vscode.executeLinkProvider',
      doc.uri
    );
    const linkTargets = (links ?? []).map(linkTargetToString);

    assert.ok(
      linkTargets.includes('https://doi.org/10.5555/12345678'),
      'Expected DOI link in untitled bibtex document'
    );
  });
});
