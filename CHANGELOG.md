# Changelog

All notable changes to the "Bib Indexer" extension will be documented in this file.

## [0.2.0] - 2026-03-03

### Improvements

- **Aligned `=` formatting**: when inserting a field or a whole entry into a `.bib` file that aligns its `=` signs (e.g. `author  = {…}`, `journal = {…}`), inserted fields now match that style. If a field name is too long to fit within the established column, a single space is used as a fallback.

## [0.1.0] - 2026-03-01

Initial release.

### Features

- **Full-text search** across all indexed `.bib` files with quoted phrase and multi-term support
- **Automatic duplicate detection** via DOI exact match or fuzzy title/author similarity
- **Field-level comparison** highlighting missing fields, different values, and identical fields
- **Smart merging** of compatible entries into unified "super cards"
- **One-click actions**: copy entry, insert entry, insert individual fields
- **Incremental indexing** based on file modification times
- **Configurable similarity threshold** for fuzzy matching
- **Field ignore list** with wildcard support (e.g., `bdsk-file-*`)
