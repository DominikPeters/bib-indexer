/**
 * Bib Indexer - VS Code Extension Entry Point
 */

import * as vscode from 'vscode';
import { BibIndexManager } from './index';
import { SidebarProvider } from './sidebar/sidebarProvider';
import { BibDocumentLinkProvider } from './editorLinks';

let indexManager: BibIndexManager;
let outputChannel: vscode.OutputChannel;
let sidebarProvider: SidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Bib Indexer');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Bib Indexer extension activating...');

  // Initialize the index manager
  indexManager = new BibIndexManager(context, outputChannel);
  await indexManager.initialize();

  // Create sidebar webview provider
  sidebarProvider = new SidebarProvider(context.extensionUri, indexManager);

  // Refresh sidebar when background validation completes
  context.subscriptions.push(
    indexManager.onDidUpdate(() => {
      sidebarProvider.refresh();
      outputChannel.appendLine('Background index update complete, sidebar refreshed');
    })
  );

  // Register webview provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('bibIndexer.main', sidebarProvider)
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('bibIndexer.addFolder', async () => {
      const uri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: 'Add Folder to Index',
      });

      if (uri && uri.length > 0) {
        await indexManager.addFolder(uri[0].fsPath);
        sidebarProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bibIndexer.removeFolder', async () => {
      const folders = indexManager.getFolders();
      if (folders.length === 0) {
        vscode.window.showInformationMessage('No folders are currently indexed.');
        return;
      }

      const selected = await vscode.window.showQuickPick(folders, {
        placeHolder: 'Select folder to remove from index',
      });

      if (selected) {
        await indexManager.removeFolder(selected);
        sidebarProvider.refresh();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('bibIndexer.reindex', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Bib Indexer: Reindexing all files...',
          cancellable: false,
        },
        async () => {
          await indexManager.reindexAll((indexed, total) => {
            sidebarProvider.sendProgress('Indexing...', indexed, total);
          });
          sidebarProvider.refresh();
        }
      );
      vscode.window.showInformationMessage('Bib Indexer: Reindex complete!');
    })
  );

  // Start file system watcher for .bib files
  context.subscriptions.push(indexManager.startWatching());

  // Register clickable URL/DOI links inside BibTeX editors
  context.subscriptions.push(
    vscode.languages.registerDocumentLinkProvider(
      [
        { language: 'bibtex', scheme: 'file' },
        { language: 'bibtex', scheme: 'untitled' },
      ],
      new BibDocumentLinkProvider()
    )
  );

  // Listen for cursor position changes
  context.subscriptions.push(
    vscode.window.onDidChangeTextEditorSelection((event) => {
      if (event.textEditor.document.languageId === 'bibtex') {
        sidebarProvider.onCursorMoved(event.textEditor);
      }
    })
  );

  // Listen for active editor changes
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor?.document.languageId === 'bibtex') {
        sidebarProvider.onCursorMoved(editor);
      } else {
        sidebarProvider.clearCurrentEntry();
      }
    })
  );

  // Listen for document changes (to update after edits)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === 'bibtex') {
        // Debounce reindexing of current file
        sidebarProvider.onDocumentChanged(event.document);
      }
    })
  );

  outputChannel.appendLine('Bib Indexer extension activated!');
}

export function deactivate() {
  outputChannel?.appendLine('Bib Indexer extension deactivated.');
}
