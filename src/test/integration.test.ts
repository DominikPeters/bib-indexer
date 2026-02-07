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

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tmb-test-'));
}

function createMockContext(storageDir: string): vscode.ExtensionContext {
  return {
    globalStorageUri: vscode.Uri.file(storageDir),
    subscriptions: [],
  } as unknown as vscode.ExtensionContext;
}

function createOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel('TooManyBibs Test');
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

suite('Integration: BibIndexManager with real files', () => {
  let indexManager: BibIndexManager;
  let storageDir: string;

  setup(() => {
    storageDir = createTempDir();
    indexManager = createTestIndexManager(storageDir);
  });

  teardown(() => {
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
