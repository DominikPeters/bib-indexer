import * as assert from 'assert';
import { parseBibFile } from '../parser';

suite('Parser Test Suite', () => {
  test('should preserve braces in titles', () => {
    const content = `@article{test,
  title = {The unreasonable fairness of maximum {Nash} welfare},
  author = {Test Author},
  year = {2019}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(
      result.entries[0].fields.title,
      'The unreasonable fairness of maximum {Nash} welfare',
      'Braces around Nash should be preserved'
    );
  });

  test('should preserve multiple braced sections', () => {
    const content = `@article{test,
  title = {A {B}ayesian approach to {Nash} equilibrium},
  author = {Test Author}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(
      result.entries[0].fields.title,
      'A {B}ayesian approach to {Nash} equilibrium'
    );
  });

  test('should convert en-dashes to -- in pages field', () => {
    const content = `@article{test,
  title = {Test},
  pages = {1–32},
  author = {Test Author}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(
      result.entries[0].fields.pages,
      '1--32',
      'En-dash should be converted to --'
    );
  });

  test('should parse author names correctly', () => {
    const content = `@article{test,
  title = {Test},
  author = {Caragiannis, Ioannis and Kurokawa, David and Moulin, Hervé}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].creators.author?.length, 3);
    assert.strictEqual(result.entries[0].creators.author?.[0].lastName, 'Caragiannis');
    assert.strictEqual(result.entries[0].creators.author?.[0].firstName, 'Ioannis');
  });

  test('should compute correct line positions', () => {
    const content = `@article{first,
  title = {First}
}

@article{second,
  title = {Second}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries.length, 2);
    assert.strictEqual(result.entries[0].key, 'first');
    assert.strictEqual(result.entries[0].startLine, 1);
    assert.strictEqual(result.entries[1].key, 'second');
    assert.strictEqual(result.entries[1].startLine, 5);
  });

  test('should normalize title for filtering (without braces)', () => {
    const content = `@article{test,
  title = {The {Nash} Solution},
  author = {Test Author}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // titleFilter should have braces removed for search matching
    assert.strictEqual(
      result.entries[0].titleFilter,
      'the nash solution'
    );
  });

  test('should normalize title for clustering (with braces)', () => {
    const content = `@article{test,
  title = {The {Nash} Solution},
  author = {Test Author}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // titleCluster should preserve braces
    assert.strictEqual(
      result.entries[0].titleCluster,
      'the {nash} solution'
    );
  });

  test('should filter out ignored fields (keywords, abstract)', () => {
    const content = `@article{test,
  title = {Test Title},
  author = {Test Author},
  year = {2020},
  keywords = {game theory, equilibrium},
  abstract = {This is an abstract that should be ignored.}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].fields.title, 'Test Title');
    assert.strictEqual(result.entries[0].fields.keywords, undefined, 'keywords should be filtered');
    assert.strictEqual(result.entries[0].fields.abstract, undefined, 'abstract should be filtered');
  });

  test('should filter out bdsk-file-* fields using wildcard', () => {
    const content = `@article{test,
  title = {Test},
  author = {Author},
  bdsk-file-1 = {base64data1},
  bdsk-file-2 = {base64data2},
  bdsk-file-99 = {base64data99}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].fields['bdsk-file-1'], undefined);
    assert.strictEqual(result.entries[0].fields['bdsk-file-2'], undefined);
    assert.strictEqual(result.entries[0].fields['bdsk-file-99'], undefined);
  });

  test('should handle different entry types', () => {
    const content = `@book{mybook,
  title = {A Book},
  author = {Book Author},
  publisher = {Publisher}
}

@inproceedings{myproc,
  title = {A Paper},
  author = {Paper Author},
  booktitle = {Conference}
}

@misc{mymisc,
  title = {Something},
  howpublished = {Online}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries.length, 3);
    assert.strictEqual(result.entries[0].entryType, 'book');
    assert.strictEqual(result.entries[1].entryType, 'inproceedings');
    assert.strictEqual(result.entries[2].entryType, 'misc');
  });

  test('should extract DOI correctly', () => {
    const content = `@article{test,
  title = {Test},
  author = {Author},
  doi = {10.1000/example.doi}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].doi, '10.1000/example.doi');
  });

  test('should normalize author names for matching', () => {
    const content = `@article{test,
  title = {Test},
  author = {Smith, John and Doe, Jane and Brown, Bob}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // authorNorm should be sorted last names
    assert.strictEqual(result.entries[0].authorNorm, 'brown doe smith');
  });

  test('should handle "First Last" author format', () => {
    const content = `@article{test,
  title = {Test},
  author = {John Smith and Jane Doe}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].creators.author?.length, 2);
    // authorNorm extracts last names
    assert.strictEqual(result.entries[0].authorNorm, 'doe smith');
  });

  test('should preserve institutional authors in raw field', () => {
    const content = `@article{test,
  title = {Test},
  author = {{World Health Organization}}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // With raw mode, the author field preserves the braces
    // (though the creators parsing may not recognize it as a literal)
    assert.ok(result.entries[0].fields.author.includes('{World Health Organization}'));
  });

  test('should use editor when author is missing for authorNorm', () => {
    const content = `@book{test,
  title = {Edited Volume},
  editor = {Smith, John}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].authorNorm, 'smith');
  });

  test('should handle entries with parsing errors gracefully', () => {
    const content = `@article{good,
  title = {Good Entry},
  author = {Author}
}

@article{bad,
  title = {Missing closing brace
}

@article{alsogood,
  title = {Also Good},
  author = {Another Author}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // Should still parse the valid entries
    assert.ok(result.entries.length >= 1);
    assert.ok(result.entries.some(e => e.key === 'good'));
  });

  test('should preserve LaTeX formatting commands', () => {
    const content = `@article{test,
  title = {The \\textbf{bold} and \\emph{italic} text},
  author = {M{\\"u}ller, Hans}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // With raw mode, LaTeX commands are preserved exactly
    assert.ok(result.entries[0].fields.title.includes('\\textbf{bold}'));
    assert.ok(result.entries[0].fields.title.includes('\\emph{italic}'));
  });

  test('should preserve unknown LaTeX commands', () => {
    const content = `@article{test,
  title = {The \\mycustomcmd{content} here}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // Unknown commands are preserved as-is
    assert.ok(result.entries[0].fields.title.includes('\\mycustomcmd'));
  });
});

suite('Round-trip Test Suite', () => {
  test('should round-trip braces for case protection', () => {
    const content = `@article{test,
  title = {The {Nash} equilibrium}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // Should preserve braces
    assert.strictEqual(result.entries[0].fields.title, 'The {Nash} equilibrium');
  });

  test('should round-trip \\textbf command', () => {
    const content = `@article{test,
  title = {The \\textbf{bold} text}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // Should convert back to \textbf
    assert.strictEqual(result.entries[0].fields.title, 'The \\textbf{bold} text');
  });

  test('should round-trip \\emph command', () => {
    const content = `@article{test,
  title = {The \\emph{italic} text}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].fields.title, 'The \\emph{italic} text');
  });

  test('should round-trip \\texttt command', () => {
    const content = `@article{test,
  title = {The \\texttt{code} text}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].fields.title, 'The \\texttt{code} text');
  });

  test('should round-trip \\textsc command', () => {
    const content = `@article{test,
  title = {The \\textsc{SmallCaps} text}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.strictEqual(result.entries[0].fields.title, 'The \\textsc{SmallCaps} text');
  });

  test('should round-trip subscript and superscript commands', () => {
    const content = `@article{test,
  title = {H\\textsubscript{2}O and x\\textsuperscript{2}}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // With raw mode, these commands are preserved
    assert.ok(result.entries[0].fields.title.includes('\\textsubscript{2}'));
    assert.ok(result.entries[0].fields.title.includes('\\textsuperscript{2}'));
  });

  test('should round-trip nested formatting in braces', () => {
    const content = `@article{test,
  title = {The {\\textbf{Bold} Nash} equilibrium}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    // Should preserve both braces and bold
    assert.ok(result.entries[0].fields.title.includes('{'));
    assert.ok(result.entries[0].fields.title.includes('\\textbf{Bold}'));
  });

  test('should round-trip multiple formatting commands', () => {
    const content = `@article{test,
  title = {\\textbf{Bold} and \\emph{italic} and {Protected}}
}`;
    const result = parseBibFile(content, '/test/file.bib');

    assert.ok(result.entries[0].fields.title.includes('\\textbf{Bold}'));
    assert.ok(result.entries[0].fields.title.includes('\\emph{italic}'));
    assert.ok(result.entries[0].fields.title.includes('{Protected}'));
  });
});
