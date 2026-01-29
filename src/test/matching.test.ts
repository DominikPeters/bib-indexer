import * as assert from 'assert';
import { similarity, findMatches, clusterMatches, compareFields } from '../matching';
import { IndexedEntry } from '../types';

suite('Matching Test Suite', () => {
  suite('similarity function', () => {
    test('should return 1 for identical strings', () => {
      assert.strictEqual(similarity('hello', 'hello'), 1);
      assert.strictEqual(similarity('', ''), 1);
    });

    test('should return 0 when one string is empty', () => {
      assert.strictEqual(similarity('hello', ''), 0);
      assert.strictEqual(similarity('', 'hello'), 0);
    });

    test('should return high similarity for similar strings', () => {
      const sim = similarity('the nash equilibrium', 'the nash equilibria');
      assert.ok(sim > 0.8, `Expected similarity > 0.8, got ${sim}`);
    });

    test('should return low similarity for different strings', () => {
      const sim = similarity('game theory', 'quantum physics');
      assert.ok(sim < 0.5, `Expected similarity < 0.5, got ${sim}`);
    });

    test('should be case-sensitive', () => {
      const sim = similarity('Hello', 'hello');
      assert.ok(sim < 1, 'Different cases should not be identical');
    });
  });

  suite('findMatches function', () => {
    const createEntry = (overrides: Partial<IndexedEntry>): IndexedEntry => ({
      file: '/test/file.bib',
      key: 'test',
      entryType: 'article',
      startLine: 1,
      endLine: 5,
      fields: { title: 'Test', author: 'Author' },
      creators: {},
      titleFilter: 'test',
      titleCluster: 'test',
      authorNorm: 'author',
      ...overrides,
    });

    test('should match entries with same DOI', () => {
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        doi: '10.1000/test',
      });
      const candidate = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        doi: '10.1000/test',
        titleFilter: 'completely different title',
        authorNorm: 'different author',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].key, 'entry2');
    });

    test('should not match entries with different DOIs and different content', () => {
      const entry = createEntry({
        key: 'entry1',
        doi: '10.1000/test1',
        titleFilter: 'game theory introduction',
        authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        doi: '10.1000/test2',
        titleFilter: 'quantum mechanics basics',
        authorNorm: 'feynman',
      });

      // Different DOIs don't prevent matching - title/author similarity is checked
      // But these entries have different titles and authors, so shouldn't match
      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 0);
    });

    test('should match entries with similar title and author', () => {
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        titleFilter: 'the nash equilibrium in games',
        authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        titleFilter: 'the nash equilibrium in games',
        authorNorm: 'nash',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 1);
    });

    test('should not match entries with different titles', () => {
      const entry = createEntry({
        key: 'entry1',
        titleFilter: 'game theory basics',
        authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        titleFilter: 'quantum mechanics introduction',
        authorNorm: 'nash',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 0);
    });

    test('should not match self', () => {
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file.bib',
      });

      const matches = findMatches(entry, [entry]);
      assert.strictEqual(matches.length, 0);
    });

    test('should respect similarity threshold', () => {
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        titleFilter: 'the nash equilibrium',
        authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        titleFilter: 'the nash equilibria', // slightly different
        authorNorm: 'nash',
      });

      // With high threshold, might not match
      const strictMatches = findMatches(entry, [candidate], 0.99);
      assert.strictEqual(strictMatches.length, 0);

      // With lower threshold, should match
      const lenientMatches = findMatches(entry, [candidate], 0.8);
      assert.strictEqual(lenientMatches.length, 1);
    });
  });

  suite('clusterMatches function', () => {
    const createEntry = (overrides: Partial<IndexedEntry>): IndexedEntry => ({
      file: '/test/file.bib',
      key: 'test',
      entryType: 'article',
      startLine: 1,
      endLine: 5,
      fields: { title: 'Test Title', author: 'Test Author' },
      creators: {},
      titleFilter: 'test title',
      titleCluster: 'test title',
      authorNorm: 'author',
      ...overrides,
    });

    test('should return null for empty matches', () => {
      const entry = createEntry({});
      const result = clusterMatches(entry, []);
      assert.strictEqual(result, null);
    });

    test('should create cluster with display info', () => {
      const current = createEntry({ key: 'current', file: '/test/file1.bib' });
      const match = createEntry({
        key: 'match',
        file: '/test/file2.bib',
        fields: { title: 'Match Title', author: 'Match Author', year: '2020' },
      });

      const cluster = clusterMatches(current, [match]);
      assert.ok(cluster);
      assert.strictEqual(cluster.displayTitle, 'Match Title');
      assert.strictEqual(cluster.displayAuthor, 'Match Author');
      assert.strictEqual(cluster.year, '2020');
    });

    test('should group entries into variants', () => {
      const current = createEntry({
        key: 'current',
        file: '/test/file1.bib',
        titleCluster: 'test title',
        fields: { title: 'Test', author: 'Author' },
      });
      const sameVariant = createEntry({
        key: 'same',
        file: '/test/file2.bib',
        titleCluster: 'test title',
        fields: { title: 'Test', author: 'Author' }, // same fields
      });
      const differentVariant = createEntry({
        key: 'different',
        file: '/test/file3.bib',
        titleCluster: 'test title',
        fields: { title: 'Test', author: 'Author', year: '2020' }, // extra field
      });

      const cluster = clusterMatches(current, [sameVariant, differentVariant]);
      assert.ok(cluster);
      assert.strictEqual(cluster.entries.length, 3);
      assert.strictEqual(cluster.variants.length, 2); // two distinct variants
    });
  });

  suite('compareFields function', () => {
    const createEntry = (fields: Record<string, string>): IndexedEntry => ({
      file: '/test/file.bib',
      key: 'test',
      entryType: 'article',
      startLine: 1,
      endLine: 5,
      fields,
      creators: {},
      titleFilter: '',
      titleCluster: '',
      authorNorm: '',
    });

    test('should identify same fields', () => {
      const current = createEntry({ title: 'Same Title' });
      const other = createEntry({ title: 'Same Title' });

      const comparisons = compareFields(current, other);
      const titleComp = comparisons.find(c => c.field === 'title');

      assert.ok(titleComp);
      assert.strictEqual(titleComp.status, 'same');
    });

    test('should identify missing fields', () => {
      const current = createEntry({ title: 'Title' });
      const other = createEntry({ title: 'Title', year: '2020' });

      const comparisons = compareFields(current, other);
      const yearComp = comparisons.find(c => c.field === 'year');

      assert.ok(yearComp);
      assert.strictEqual(yearComp.status, 'missing');
      assert.strictEqual(yearComp.other, '2020');
    });

    test('should identify extra fields', () => {
      const current = createEntry({ title: 'Title', year: '2020' });
      const other = createEntry({ title: 'Title' });

      const comparisons = compareFields(current, other);
      const yearComp = comparisons.find(c => c.field === 'year');

      assert.ok(yearComp);
      assert.strictEqual(yearComp.status, 'extra');
      assert.strictEqual(yearComp.current, '2020');
    });

    test('should identify different fields', () => {
      const current = createEntry({ title: 'Title A' });
      const other = createEntry({ title: 'Title B' });

      const comparisons = compareFields(current, other);
      const titleComp = comparisons.find(c => c.field === 'title');

      assert.ok(titleComp);
      assert.strictEqual(titleComp.status, 'different');
      assert.strictEqual(titleComp.current, 'Title A');
      assert.strictEqual(titleComp.other, 'Title B');
    });
  });
});
