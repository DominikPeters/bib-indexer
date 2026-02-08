import * as assert from 'assert';
import { detectBibFieldLinks, normalizeArxivValue, normalizeDoiValue, normalizeUrlValue } from '../editorLinks';

function extractLinkedText(text: string, line: number, startCharacter: number, endCharacter: number): string {
  const lines = text.split(/\r?\n/);
  return lines[line].slice(startCharacter, endCharacter);
}

suite('Editor Links Test Suite', () => {
  test('should link braced URL values', () => {
    const text = `@article{test,
  url = {https://example.com/paper},
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].field, 'url');
    assert.strictEqual(links[0].target, 'https://example.com/paper');
    assert.strictEqual(
      extractLinkedText(text, links[0].line, links[0].startCharacter, links[0].endCharacter),
      'https://example.com/paper'
    );
  });

  test('should link quoted URL values', () => {
    const text = `@article{test,
  url = "https://example.com/quoted",
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'https://example.com/quoted');
  });

  test('should link bare DOI values', () => {
    const text = `@article{test,
  doi = 10.1000/example.doi,
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].field, 'doi');
    assert.strictEqual(links[0].target, 'https://doi.org/10.1000/example.doi');
  });

  test('should canonicalize braced DOI values to doi.org', () => {
    const text = `@article{test,
  doi = {10.2307/j.ctt1nqb90},
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'https://doi.org/10.2307/j.ctt1nqb90');
  });

  test('should accept DOI values with doi: prefix', () => {
    const text = `@article{test,
  doi = {doi:10.1000/abc123},
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'https://doi.org/10.1000/abc123');
  });

  test('should accept DOI values in DOI resolver URL form', () => {
    const text = `@article{test,
  doi = {https://doi.org/10.1000/from-url},
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].target, 'https://doi.org/10.1000/from-url');
  });

  test('should reject invalid URL values', () => {
    assert.strictEqual(normalizeUrlValue('www.example.com/no-scheme'), null);
    assert.strictEqual(normalizeUrlValue('https://exa mple.com/bad'), null);
  });

  test('should reject invalid DOI values', () => {
    assert.strictEqual(normalizeDoiValue('not-a-doi'), null);
    assert.strictEqual(normalizeDoiValue('10.12/nope'), null);
  });

  test('should normalize valid arXiv values', () => {
    assert.strictEqual(normalizeArxivValue('1611.08826'), 'https://arxiv.org/abs/1611.08826');
    assert.strictEqual(normalizeArxivValue('arXiv:1611.08826v2'), 'https://arxiv.org/abs/1611.08826v2');
    assert.strictEqual(normalizeArxivValue('hep-th/9901001'), 'https://arxiv.org/abs/hep-th/9901001');
  });

  test('should reject invalid arXiv values', () => {
    assert.strictEqual(normalizeArxivValue('not-an-arxiv-id'), null);
    assert.strictEqual(normalizeArxivValue('161.08826'), null);
  });

  test('should reject multiline braced and quoted values', () => {
    const text = `@article{test,
  doi = {10.1000
    /multiline},
  url = "https://example.com
    /multiline",
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 0);
  });

  test('should reject top-level concatenation expressions', () => {
    const text = `@article{test,
  doi = "10.1000/part" # suffix,
  url = "https://example.com" # fragment
}`;

    const links = detectBibFieldLinks(text);

    assert.strictEqual(links.length, 0);
  });

  test('should report link ranges for only value content', () => {
    const text = `@article{test,
  doi = {10.1000/range-check},
  url = "https://example.com/range"
}`;

    const links = detectBibFieldLinks(text);
    const doiLink = links.find(link => link.field === 'doi');
    const urlLink = links.find(link => link.field === 'url');

    assert.ok(doiLink, 'Expected DOI link');
    assert.ok(urlLink, 'Expected URL link');

    assert.strictEqual(
      extractLinkedText(text, doiLink!.line, doiLink!.startCharacter, doiLink!.endCharacter),
      '10.1000/range-check'
    );
    assert.strictEqual(
      extractLinkedText(text, urlLink!.line, urlLink!.startCharacter, urlLink!.endCharacter),
      'https://example.com/range'
    );
  });

  test('should link eprint when archivePrefix arXiv is immediately before it', () => {
    const text = `@article{test,
  archivePrefix = {arXiv},
  eprint = {1611.08826},
}`;

    const links = detectBibFieldLinks(text);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].field, 'arxiv');
    assert.strictEqual(links[0].target, 'https://arxiv.org/abs/1611.08826');
    assert.strictEqual(
      extractLinkedText(text, links[0].line, links[0].startCharacter, links[0].endCharacter),
      '1611.08826'
    );
  });

  test('should link eprint when archivePrefix arXiv is immediately after it', () => {
    const text = `@article{test,
  eprint = {1611.08826},
  archivePrefix = {arXiv},
}`;

    const links = detectBibFieldLinks(text);
    assert.strictEqual(links.length, 1);
    assert.strictEqual(links[0].field, 'arxiv');
    assert.strictEqual(links[0].target, 'https://arxiv.org/abs/1611.08826');
    assert.strictEqual(
      extractLinkedText(text, links[0].line, links[0].startCharacter, links[0].endCharacter),
      '1611.08826'
    );
  });

  test('should not link eprint when archivePrefix is missing or not immediately adjacent', () => {
    const text = `@article{test,
  archivePrefix = {arXiv},
  year = {2016},
  eprint = {1611.08826},
}

@article{test2,
  eprint = {1611.08826},
  year = {2016},
  archivePrefix = {arXiv},
}

@article{test3,
  eprint = {1611.08826},
}`;

    const links = detectBibFieldLinks(text);
    assert.strictEqual(links.length, 0);
  });
});
