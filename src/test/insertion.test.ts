import * as assert from 'assert';
import { findEntryInsertionPoint, formatBibtex, determineBlankLines, detectFileUsesAlignment } from '../insertion';
import { IndexedEntry } from '../types';

suite('Entry Insertion Test Suite', () => {
  suite('findEntryInsertionPoint', () => {
    test('should insert after current entry when cursor is in an entry', () => {
      const lines = [
        '@article{first,',
        '  title = {First},',
        '}',
        '',
        '@article{second,',
        '  title = {Second},',
        '}',
      ];
      const currentEntry = { endLine: 3 }; // 1-indexed, entry ends at line 3

      const result = findEntryInsertionPoint(lines, currentEntry);

      assert.strictEqual(result, 3, 'Should insert at line 3 (after the first entry)');
    });

    test('should insert after last entry when no current entry', () => {
      const lines = [
        '@article{first,',
        '  title = {First},',
        '}',
        '',
        '@article{second,',
        '  title = {Second},',
        '}',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 7, 'Should insert at line 7 (after the second entry)');
    });

    test('should insert at end of file when no entries exist', () => {
      const lines = [
        '% This is a comment',
        '% Another comment',
        '',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 3, 'Should insert at end of file');
    });

    test('should handle empty file', () => {
      const lines: string[] = [];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 0, 'Should insert at line 0');
    });

    test('should handle multi-line entries with nested braces', () => {
      const lines = [
        '@article{test,',
        '  title = {A {Nested} Title},',
        '  author = {Someone}',
        '}',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 4, 'Should insert after the closing brace');
    });

    test('should handle entries with braces in field values', () => {
      const lines = [
        '@article{test,',
        '  title = {The {Nash} equilibrium in {Game} theory},',
        '  author = {{World Health Organization}}',
        '}',
        '',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 4, 'Should correctly count braces and find entry end');
    });

    test('should handle multiple entries correctly', () => {
      const lines = [
        '@article{a, title={A}}',
        '',
        '@book{b, title={B}}',
        '',
        '@inproceedings{c,',
        '  title = {C},',
        '  booktitle = {Conf}',
        '}',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 8, 'Should insert after the last entry');
    });

    test('should handle entry on single line', () => {
      const lines = [
        '@article{test, title={Test}, author={Author}}',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 1, 'Should insert after single-line entry');
    });

    test('should handle @string and @preamble entries', () => {
      const lines = [
        '@string{jnl = "Journal"}',
        '',
        '@article{test,',
        '  title = {Test}',
        '}',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 5, 'Should insert after the article entry');
    });

    test('should handle file with trailing blank lines', () => {
      const lines = [
        '@article{test,',
        '  title = {Test}',
        '}',
        '',
        '',
        '',
      ];

      const result = findEntryInsertionPoint(lines, null);

      assert.strictEqual(result, 3, 'Should insert right after entry, not at very end');
    });

    test('should insert near cursor before next entry when not in an entry', () => {
      const lines = [
        '@article{first,',
        '  title = {First},',
        '}',
        '',
        '% cursor here',
        '',
        '@article{second,',
        '  title = {Second},',
        '}',
      ];

      const result = findEntryInsertionPoint(lines, null, 4);

      assert.strictEqual(result, 6, 'Should insert before the second entry');
    });

    test('should insert after containing entry when cursor is inside entry but currentEntry is missing', () => {
      const lines = [
        '@article{first,',
        '  title = {First},',
        '  year = {2024}',
        '}',
        '',
      ];

      const result = findEntryInsertionPoint(lines, null, 2);

      assert.strictEqual(result, 4, 'Should insert after the current entry');
    });
  });

  suite('formatBibtex', () => {
    test('should format a basic entry', () => {
      const entry: IndexedEntry = {
        key: 'test2024',
        entryType: 'article',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 5,
        fields: {
          title: 'Test Title',
          author: 'Test Author',
          year: '2024',
        },
        creators: {},
        titleFilter: 'test title',
        titleCluster: 'test title',
        authorNorm: 'author',
      };

      const result = formatBibtex(entry);

      assert.ok(result.startsWith('@article{test2024,'));
      assert.ok(result.endsWith('}'));
      assert.ok(result.includes('title = {Test Title},'));
      assert.ok(result.includes('author = {Test Author},'));
      assert.ok(result.includes('year = {2024},'));
    });

    test('should sort fields according to canonical order', () => {
      const entry: IndexedEntry = {
        key: 'test',
        entryType: 'article',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 5,
        fields: {
          year: '2024',
          author: 'Author',
          title: 'Title',
          doi: '10.1000/test',
        },
        creators: {},
        titleFilter: 'title',
        titleCluster: 'title',
        authorNorm: 'author',
      };

      const result = formatBibtex(entry);
      const lines = result.split('\n');

      // Find field lines (exclude first and last)
      const fieldLines = lines.slice(1, -1);

      // Canonical order is: author, editor, title, ..., year, ..., doi
      const authorIdx = fieldLines.findIndex(l => l.includes('author'));
      const titleIdx = fieldLines.findIndex(l => l.includes('title'));
      const yearIdx = fieldLines.findIndex(l => l.includes('year'));
      const doiIdx = fieldLines.findIndex(l => l.includes('doi'));

      assert.ok(authorIdx < titleIdx, 'author should come before title');
      assert.ok(titleIdx < yearIdx, 'title should come before year');
      assert.ok(yearIdx < doiIdx, 'year should come before doi');
    });

    test('should preserve special characters in values', () => {
      const entry: IndexedEntry = {
        key: 'test',
        entryType: 'article',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 3,
        fields: {
          title: 'The {Nash} equilibrium',
          author: 'M{\\"u}ller, Hans',
        },
        creators: {},
        titleFilter: 'the nash equilibrium',
        titleCluster: 'the {nash} equilibrium',
        authorNorm: 'muller',
      };

      const result = formatBibtex(entry);

      assert.ok(result.includes('{Nash}'), 'Should preserve braces in title');
      assert.ok(result.includes('{\\"u}'), 'Should preserve LaTeX accents');
    });

    test('should handle different entry types', () => {
      const bookEntry: IndexedEntry = {
        key: 'book2024',
        entryType: 'book',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 3,
        fields: {
          title: 'A Book',
          publisher: 'Publisher',
        },
        creators: {},
        titleFilter: 'a book',
        titleCluster: 'a book',
        authorNorm: '',
      };

      const result = formatBibtex(bookEntry);

      assert.ok(result.startsWith('@book{book2024,'));
    });

    test('should keep concatenation expressions unwrapped', () => {
      const entry: IndexedEntry = {
        key: 'k',
        entryType: 'inproceedings',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 3,
        fields: {
          title: 'Test',
          booktitle: 'proc # {39th} # aaai',
        },
        creators: {},
        titleFilter: 'test',
        titleCluster: 'test',
        authorNorm: '',
      };

      const result = formatBibtex(entry);
      assert.ok(result.includes('booktitle = proc # {39th} # aaai,'));
      assert.ok(!result.includes('booktitle = {proc # {39th} # aaai},'));
    });

    test('should still wrap plain values that contain # as text', () => {
      const entry: IndexedEntry = {
        key: 'k2',
        entryType: 'article',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 3,
        fields: {
          title: 'C# tutorial',
        },
        creators: {},
        titleFilter: 'c tutorial',
        titleCluster: 'c tutorial',
        authorNorm: '',
      };

      const result = formatBibtex(entry);
      assert.ok(result.includes('title = {C# tutorial},'));
    });

    test('should handle entry with no fields', () => {
      const entry: IndexedEntry = {
        key: 'empty',
        entryType: 'misc',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 1,
        fields: {},
        creators: {},
        titleFilter: '',
        titleCluster: '',
        authorNorm: '',
      };

      const result = formatBibtex(entry);

      assert.strictEqual(result, '@misc{empty,\n}');
    });

    test('aligned=true should align = signs to the longest field name', () => {
      const entry: IndexedEntry = {
        key: 'turing1950',
        entryType: 'article',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 7,
        fields: {
          author: 'Turing, Alan M.',
          title: 'Computing Machinery and Intelligence',
          journal: 'Mind',
          year: '1950',
          volume: '59',
        },
        creators: {},
        titleFilter: '',
        titleCluster: '',
        authorNorm: '',
      };

      const result = formatBibtex(entry, true);
      const lines = result.split('\n').slice(1, -1); // field lines only

      // 'journal' is the longest field (7 chars); eqCol = 2 + 7 + 1 = 10
      for (const line of lines) {
        const eqIdx = line.indexOf('=');
        assert.strictEqual(eqIdx, 10, `= should be at column 10 in: "${line}"`);
      }
    });

    test('aligned=true falls back to single space when key exceeds alignment column', () => {
      const entry: IndexedEntry = {
        key: 'test',
        entryType: 'misc',
        file: '/test/file.bib',
        startLine: 1,
        endLine: 3,
        fields: {
          doi: '10.1/x',
          howpublished: 'Online',
        },
        creators: {},
        titleFilter: '',
        titleCluster: '',
        authorNorm: '',
      };

      const result = formatBibtex(entry, true);
      // 'howpublished' is longest (12 chars); eqCol = 2+12+1=15
      // 'doi' (3 chars): keyEnd=5, eqCol=15 → pads to 15
      // 'howpublished': keyEnd=14, eqCol=15 → single space (eqCol == keyEnd+1)
      assert.ok(result.includes('howpublished = {Online},'), `Longest key should have single space: ${result}`);
      const doiLine = result.split('\n').find(l => l.includes('doi'));
      assert.ok(doiLine);
      assert.strictEqual(doiLine!.indexOf('='), 15, `doi = should be at column 15`);
    });
  });

  suite('detectFileUsesAlignment', () => {
    test('returns true for a file with aligned entries', () => {
      const lines = [
        '@article{a,',
        '  author  = {A},',
        '  title   = {B},',
        '  journal = {C},',
        '  year    = {2020},',
        '}',
      ];
      assert.strictEqual(detectFileUsesAlignment(lines), true);
    });

    test('returns false for a file with no alignment', () => {
      const lines = [
        '@article{a,',
        '  author = {A},',
        '  title = {B},',
        '  journal = {C},',
        '  year = {2020},',
        '}',
      ];
      assert.strictEqual(detectFileUsesAlignment(lines), false);
    });

    test('returns false for an empty file', () => {
      assert.strictEqual(detectFileUsesAlignment([]), false);
    });

    test('ignores @string and @preamble blocks when detecting alignment', () => {
      const lines = [
        '@string{jnl = "Journal"}',
        '@preamble{"prefix"}',
        '@article{a,',
        '  author  = {A},',
        '  title   = {B},',
        '  journal = {C},',
        '}',
        '@article{b,',
        '  author  = {D},',
        '  title   = {E},',
        '  journal = {F},',
        '}',
      ];
      assert.strictEqual(detectFileUsesAlignment(lines), true);
    });

    test('supports hyphenated field names when detecting alignment', () => {
      const lines = [
        '@article{a,',
        '  bdsk-url-1  = {https://example.com/a},',
        '  year        = {2020},',
        '}',
      ];
      assert.strictEqual(detectFileUsesAlignment(lines), true);
    });
  });

  suite('determineBlankLines', () => {
    test('should need blank line before when previous line has content', () => {
      const lines = [
        '@article{prev,',
        '  title = {Prev}',
        '}',
      ];

      const result = determineBlankLines(lines, 3);

      assert.strictEqual(result.needsBlankBefore, true);
      assert.strictEqual(result.needsBlankAfter, false);
    });

    test('should not need blank line before when previous line is empty', () => {
      const lines = [
        '@article{prev,',
        '  title = {Prev}',
        '}',
        '',
      ];

      const result = determineBlankLines(lines, 4);

      assert.strictEqual(result.needsBlankBefore, false);
      assert.strictEqual(result.needsBlankAfter, false);
    });

    test('should need blank line after when next line has content', () => {
      const lines = [
        '@article{first,',
        '  title = {First}',
        '}',
        '@article{second,',
        '  title = {Second}',
        '}',
      ];

      const result = determineBlankLines(lines, 3);

      assert.strictEqual(result.needsBlankBefore, true);
      assert.strictEqual(result.needsBlankAfter, true);
    });

    test('should handle insertion at start of file', () => {
      const lines = [
        '@article{existing,',
        '  title = {Existing}',
        '}',
      ];

      const result = determineBlankLines(lines, 0);

      assert.strictEqual(result.needsBlankBefore, false);
      assert.strictEqual(result.needsBlankAfter, true);
    });

    test('should handle insertion at end of file', () => {
      const lines = [
        '@article{existing,',
        '  title = {Existing}',
        '}',
      ];

      const result = determineBlankLines(lines, 3);

      assert.strictEqual(result.needsBlankBefore, true);
      assert.strictEqual(result.needsBlankAfter, false);
    });

    test('should handle empty file', () => {
      const lines: string[] = [];

      const result = determineBlankLines(lines, 0);

      assert.strictEqual(result.needsBlankBefore, false);
      assert.strictEqual(result.needsBlankAfter, false);
    });
  });
});
