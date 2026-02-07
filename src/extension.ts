/**
 * Too Many Bibs - VS Code Extension Entry Point
 */

import * as vscode from 'vscode';
import { BibIndexManager } from './index';
import { SidebarProvider } from './sidebar/sidebarProvider';

let indexManager: BibIndexManager;
let outputChannel: vscode.OutputChannel;
let sidebarProvider: SidebarProvider;

export async function activate(context: vscode.ExtensionContext) {
  // Create output channel for logging
  outputChannel = vscode.window.createOutputChannel('Too Many Bibs');
  context.subscriptions.push(outputChannel);

  outputChannel.appendLine('Too Many Bibs extension activating...');

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
    vscode.window.registerWebviewViewProvider('tooManyBibs.main', sidebarProvider)
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('tooManyBibs.addFolder', async () => {
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
    vscode.commands.registerCommand('tooManyBibs.removeFolder', async () => {
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
    vscode.commands.registerCommand('tooManyBibs.reindex', async () => {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Too Many Bibs: Reindexing all files...',
          cancellable: false,
        },
        async () => {
          await indexManager.reindexAll((indexed, total) => {
            sidebarProvider.sendProgress('Indexing...', indexed, total);
          });
          sidebarProvider.refresh();
        }
      );
      vscode.window.showInformationMessage('Too Many Bibs: Reindex complete!');
    })
  );

  // Start file system watcher for .bib files
  context.subscriptions.push(indexManager.startWatching());

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

  outputChannel.appendLine('Too Many Bibs extension activated!');
}

export function deactivate() {
  outputChannel?.appendLine('Too Many Bibs extension deactivated.');
}
