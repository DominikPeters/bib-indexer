# Bib Indexer

A VS Code sidebar extension for researchers who maintain separate `.bib` bibtex files across multiple projects. Bib Indexer scans all bibliography files on your hard drive and keeps all entries in a database. While editing a bib file, it shows you related existing entries and allows you to quickly merge field data between versions. It also allows searching through all existing entries and adding search results to the current bib file with one click.

Example: You are editing a bibtex entry for a paper, but it is missing page numbers. Some other bib file on your hard drive has a more complete entry for the same paper. Bib Indexer detects this and shows you the more complete entry in the sidebar. You can then click a button to copy the missing page numbers into your current entry.

![Bib Indexer sidebar overview](images/overview.png)

## Features

### Search across all your bibliographies

Full-text search across every indexed `.bib` file. Supports quoted phrases for exact matching and multi-term queries. Results are ranked by relevance and grouped by paper identity, so different versions of the same entry appear together.

![Search results](images/search.png)

### Automatic duplicate detection

When your cursor is on a BibTeX entry, the sidebar shows matching entries from other files. Matches are found via DOI (exact match) or fuzzy title + author similarity.

![Duplicate matches](images/matches.png)

### Field-level comparison

Each match card highlights the differences between your current entry and the matched one:

- **New fields** (green) — the match has fields your entry is missing. Click the arrow to insert them.
- **Different values** — an inline diff shows what changed, with additions highlighted.
- **Identical fields** — shown plainly for reference.

![Field comparison](images/field-diff.png)

### Smart merging

When the same paper appears in multiple files, compatible entries are merged into a single "super card" showing the union of all fields. You can copy or insert the merged result directly — no manual consolidation needed.

Two entries are compatible when they share the same BibTeX type and all overlapping field values are identical.

### One-click copy and insert

- **Copy entry** — copies the full BibTeX to your clipboard.
- **Insert entry** — adds the entry into your current `.bib` file at the right location.
- **Insert field** — adds a single missing field to your current entry, respecting indentation and canonical field order.

### File management

Add folders or individual `.bib` files to the index from the sidebar. The extension watches for changes and reindexes incrementally — only modified files are re-parsed. 

![File management view](images/file-management.png)

## Getting started

1. Install the extension and open a workspace containing `.bib` files.
2. Click the **Bib Indexer** icon in the activity bar.
3. Use the **Manage files** link to add folders or files to scan.
4. Place your cursor on a BibTeX entry to see matches, or use the search box to find entries across all files.

## How it works

Bib Indexer builds a persistent local index of all entries in your configured `.bib` files. The index is updated incrementally based on file modification times, so reindexing is fast even for large collections.

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `bibIndexer.indexedFolders` | `[]` | Folders to scan recursively for `.bib` files |
| `bibIndexer.similarityThreshold` | `0.85` | Minimum similarity (0–1) for fuzzy matching |
| `bibIndexer.ignoredFields` | `["keywords", "abstract", ...]` | Fields to skip during parsing (supports wildcards like `bdsk-file-*`) |

## Commands

All commands are available via the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

- **Bib Indexer: Add Folder to Index** — add a folder to scan for `.bib` files
- **Bib Indexer: Remove Folder from Index** — remove a folder from the index
- **Bib Indexer: Reindex All Files** — force a full reindex of all configured files
