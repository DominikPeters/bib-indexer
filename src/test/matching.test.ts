import * as assert from 'assert';
import {
  similarity, findMatches,
  computeQualityScore, hasFullFirstNames,
  areFieldsCompatible, buildSuperCards,
  clusterByPaperIdentity, buildPaperClusters,
} from '../matching';
import { IndexedEntry } from '../types';

const createEntry = (overrides: Partial<IndexedEntry> = {}): IndexedEntry => ({
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
    test('should match entries with same DOI', () => {
      const entry = createEntry({
        key: 'entry1', file: '/test/file1.bib', doi: '10.1000/test',
      });
      const candidate = createEntry({
        key: 'entry2', file: '/test/file2.bib', doi: '10.1000/test',
        titleFilter: 'completely different title',
        authorNorm: 'different author',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].key, 'entry2');
    });

    test('should not match entries with different DOIs and different content', () => {
      const entry = createEntry({
        key: 'entry1', doi: '10.1000/test1',
        titleFilter: 'game theory introduction', authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2', file: '/test/file2.bib', doi: '10.1000/test2',
        titleFilter: 'quantum mechanics basics', authorNorm: 'feynman',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 0);
    });

    test('should match entries with similar title and author', () => {
      const entry = createEntry({
        key: 'entry1', file: '/test/file1.bib',
        titleFilter: 'the nash equilibrium in games', authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2', file: '/test/file2.bib',
        titleFilter: 'the nash equilibrium in games', authorNorm: 'nash',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 1);
    });

    test('should not match entries with different titles', () => {
      const entry = createEntry({
        key: 'entry1', titleFilter: 'game theory basics', authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2', file: '/test/file2.bib',
        titleFilter: 'quantum mechanics introduction', authorNorm: 'nash',
      });

      const matches = findMatches(entry, [candidate]);
      assert.strictEqual(matches.length, 0);
    });

    test('should not match self', () => {
      const entry = createEntry({ key: 'entry1', file: '/test/file.bib' });
      const matches = findMatches(entry, [entry]);
      assert.strictEqual(matches.length, 0);
    });

    test('should respect similarity threshold', () => {
      const entry = createEntry({
        key: 'entry1', file: '/test/file1.bib',
        titleFilter: 'the nash equilibrium', authorNorm: 'nash',
      });
      const candidate = createEntry({
        key: 'entry2', file: '/test/file2.bib',
        titleFilter: 'the nash equilibria', authorNorm: 'nash',
      });

      const strictMatches = findMatches(entry, [candidate], 0.99);
      assert.strictEqual(strictMatches.length, 0);

      const lenientMatches = findMatches(entry, [candidate], 0.8);
      assert.strictEqual(lenientMatches.length, 1);
    });
  });

  suite('computeQualityScore function', () => {
    test('should give more points for more fields', () => {
      const few = createEntry({ fields: { title: 'T' } });
      const many = createEntry({ fields: { title: 'T', author: 'A', year: '2020' } });
      assert.ok(computeQualityScore(many) > computeQualityScore(few));
    });

    test('should give bonus for DOI', () => {
      const withDoi = createEntry({ fields: { title: 'T', doi: '10.1000/x' } });
      const withoutDoi = createEntry({ fields: { title: 'T', url: 'http://x' } });
      // DOI gives +2, URL gives +1, so withDoi should win despite same field count
      assert.ok(computeQualityScore(withDoi) > computeQualityScore(withoutDoi));
    });

    test('should give bonus for full first names', () => {
      const full = createEntry({
        fields: { title: 'T' },
        creators: { author: [{ firstName: 'John', lastName: 'Nash' }] },
      });
      const initials = createEntry({
        fields: { title: 'T' },
        creators: { author: [{ firstName: 'J.', lastName: 'Nash' }] },
      });
      assert.ok(computeQualityScore(full) > computeQualityScore(initials));
    });
  });

  suite('hasFullFirstNames function', () => {
    test('should return true for full names', () => {
      assert.ok(hasFullFirstNames([{ firstName: 'John' }]));
      assert.ok(hasFullFirstNames([{ firstName: 'John Kenneth' }]));
    });

    test('should return false for initials', () => {
      assert.ok(!hasFullFirstNames([{ firstName: 'J.' }]));
      assert.ok(!hasFullFirstNames([{ firstName: 'J. K.' }]));
    });

    test('should return false for empty creators', () => {
      assert.ok(!hasFullFirstNames([]));
    });

    test('should skip literals', () => {
      assert.ok(hasFullFirstNames([
        { literal: 'World Health Organization' },
        { firstName: 'John' },
      ]));
    });
  });

  suite('areFieldsCompatible function', () => {
    test('should be compatible with disjoint fields', () => {
      assert.ok(areFieldsCompatible({ title: 'T' }, { url: 'http://x' }));
    });

    test('should be compatible when shared fields have identical values', () => {
      assert.ok(areFieldsCompatible(
        { title: 'T', author: 'A' },
        { title: 'T', url: 'http://x' }
      ));
    });

    test('should be incompatible when a shared field differs', () => {
      assert.ok(!areFieldsCompatible(
        { title: 'Title A' },
        { title: 'Title B' }
      ));
    });

    test('should be compatible with empty fields', () => {
      assert.ok(areFieldsCompatible({}, { title: 'T' }));
      assert.ok(areFieldsCompatible({ title: 'T' }, {}));
      assert.ok(areFieldsCompatible({}, {}));
    });

    test('should check all shared fields', () => {
      // One shared field matches, another differs
      assert.ok(!areFieldsCompatible(
        { title: 'T', year: '2020' },
        { title: 'T', year: '2021' }
      ));
    });
  });

  suite('buildSuperCards function', () => {
    test('should return empty array for no entries', () => {
      assert.strictEqual(buildSuperCards([]).length, 0);
    });

    test('should create one super card for a single entry', () => {
      const entry = createEntry({ fields: { title: 'T', author: 'A' } });
      const cards = buildSuperCards([entry]);
      assert.strictEqual(cards.length, 1);
      assert.deepStrictEqual(cards[0].fields, { title: 'T', author: 'A' });
      assert.strictEqual(cards[0].sourceEntries.length, 1);
    });

    test('should merge two compatible entries into one super card', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib',
        fields: { title: 'T', author: 'A', year: '2020' },
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        fields: { title: 'T', author: 'A', url: 'http://x' },
      });

      const cards = buildSuperCards([a, b]);
      assert.strictEqual(cards.length, 1);
      // Merged fields should be the union
      assert.strictEqual(cards[0].fields.title, 'T');
      assert.strictEqual(cards[0].fields.author, 'A');
      assert.strictEqual(cards[0].fields.year, '2020');
      assert.strictEqual(cards[0].fields.url, 'http://x');
      assert.strictEqual(cards[0].sourceEntries.length, 2);
    });

    test('should keep two incompatible entries as separate super cards', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib',
        fields: { title: 'Title A', author: 'A' },
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        fields: { title: 'Title B', author: 'A' },
      });

      const cards = buildSuperCards([a, b]);
      assert.strictEqual(cards.length, 2);
    });

    test('should not merge entries with different entry types', () => {
      const article = createEntry({
        key: 'a', file: '/a.bib', entryType: 'article',
        fields: { title: 'T', author: 'A', year: '2020' },
      });
      const inproceedings = createEntry({
        key: 'b', file: '/b.bib', entryType: 'inproceedings',
        fields: { title: 'T', author: 'A', url: 'http://x' },
      });

      const cards = buildSuperCards([article, inproceedings]);
      assert.strictEqual(cards.length, 2);
    });

    test('should process entries in quality-score order (best first seeds)', () => {
      // Entry with more fields has higher quality score and should seed
      const rich = createEntry({
        key: 'rich', file: '/r.bib',
        fields: { title: 'T', author: 'A', year: '2020', doi: '10.1/x', url: 'http://x' },
      });
      const poor = createEntry({
        key: 'poor', file: '/p.bib',
        fields: { title: 'T', author: 'A' },
      });

      const cards = buildSuperCards([poor, rich]); // poor first in input
      assert.strictEqual(cards.length, 1);
      assert.strictEqual(cards[0].key, 'rich'); // seed should be rich
      assert.strictEqual(cards[0].sourceEntries[0].key, 'rich');
    });

    test('should handle three entries with partial compatibility', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib',
        fields: { title: 'T', author: 'A', year: '2020' },
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        fields: { title: 'T', author: 'A', url: 'http://x' },
      });
      const c = createEntry({
        key: 'c', file: '/c.bib',
        fields: { title: 'T', author: 'A', url: 'http://y' }, // conflicts with b on url
      });

      const cards = buildSuperCards([a, b, c]);
      // a and b are compatible (no url conflict), c conflicts with whichever has url
      // After merging a+b, the super card has url='http://x', c has url='http://y' -> incompatible
      assert.strictEqual(cards.length, 2);
    });
  });

  suite('clusterByPaperIdentity function', () => {
    test('should cluster entries with same DOI', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib', doi: '10.1/x',
        titleFilter: 'title a', authorNorm: 'author a',
      });
      const b = createEntry({
        key: 'b', file: '/b.bib', doi: '10.1/x',
        titleFilter: 'completely different', authorNorm: 'other',
      });

      const clusters = clusterByPaperIdentity([a, b]);
      assert.strictEqual(clusters.length, 1);
      assert.strictEqual(clusters[0].length, 2);
    });

    test('should cluster entries with similar title and author', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib',
        titleFilter: 'the nash equilibrium', authorNorm: 'nash',
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        titleFilter: 'the nash equilibrium', authorNorm: 'nash',
      });

      const clusters = clusterByPaperIdentity([a, b]);
      assert.strictEqual(clusters.length, 1);
    });

    test('should keep different papers in separate clusters', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib',
        titleFilter: 'game theory', authorNorm: 'nash',
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        titleFilter: 'quantum physics', authorNorm: 'feynman',
      });

      const clusters = clusterByPaperIdentity([a, b]);
      assert.strictEqual(clusters.length, 2);
    });

    test('should handle transitive clustering', () => {
      // A matches B (similar title), B matches C (same DOI), but A doesn't directly match C
      const a = createEntry({
        key: 'a', file: '/a.bib',
        titleFilter: 'the nash equilibrium', authorNorm: 'nash',
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        titleFilter: 'the nash equilibrium', authorNorm: 'nash',
        doi: '10.1/x',
      });
      const c = createEntry({
        key: 'c', file: '/c.bib',
        titleFilter: 'completely different title', authorNorm: 'other author',
        doi: '10.1/x',
      });

      const clusters = clusterByPaperIdentity([a, b, c]);
      assert.strictEqual(clusters.length, 1);
      assert.strictEqual(clusters[0].length, 3);
    });

    test('should return single-entry clusters', () => {
      const a = createEntry({ key: 'a', file: '/a.bib' });
      const clusters = clusterByPaperIdentity([a]);
      assert.strictEqual(clusters.length, 1);
      assert.strictEqual(clusters[0].length, 1);
    });

    test('should return empty array for no entries', () => {
      assert.strictEqual(clusterByPaperIdentity([]).length, 0);
    });
  });

  suite('buildPaperClusters function', () => {
    test('should cluster and merge end-to-end', () => {
      // Two papers, each with 2 compatible versions
      const paper1a = createEntry({
        key: 'p1a', file: '/a.bib',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', year: '2020' },
      });
      const paper1b = createEntry({
        key: 'p1b', file: '/b.bib',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', doi: '10.1/x' },
      });
      const paper2a = createEntry({
        key: 'p2a', file: '/a.bib',
        titleFilter: 'quantum physics', authorNorm: 'feynman',
        fields: { title: 'Quantum Physics', author: 'Feynman' },
      });
      const paper2b = createEntry({
        key: 'p2b', file: '/b.bib',
        titleFilter: 'quantum physics', authorNorm: 'feynman',
        fields: { title: 'Quantum Physics', author: 'Feynman', url: 'http://x' },
      });

      const clusters = buildPaperClusters([paper1a, paper1b, paper2a, paper2b]);
      assert.strictEqual(clusters.length, 2);

      // Each cluster should have 1 super card (entries are compatible)
      for (const cluster of clusters) {
        assert.strictEqual(cluster.superCards.length, 1);
        assert.strictEqual(cluster.totalEntries, 2);
      }
    });

    test('should produce multiple super cards for incompatible entries', () => {
      // Same paper, but two versions with conflicting field values
      const a = createEntry({
        key: 'a', file: '/a.bib',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', note: 'Version A' },
      });
      const b = createEntry({
        key: 'b', file: '/b.bib',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', note: 'Version B' },
      });

      const clusters = buildPaperClusters([a, b]);
      assert.strictEqual(clusters.length, 1); // same paper
      assert.strictEqual(clusters[0].superCards.length, 2); // but incompatible
    });

    test('should keep separate super cards when entry types differ', () => {
      const a = createEntry({
        key: 'a', file: '/a.bib', entryType: 'article',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', year: '2020' },
      });
      const b = createEntry({
        key: 'b', file: '/b.bib', entryType: 'inproceedings',
        titleFilter: 'game theory', authorNorm: 'nash',
        fields: { title: 'Game Theory', author: 'Nash', url: 'http://x' },
      });

      const clusters = buildPaperClusters([a, b]);
      assert.strictEqual(clusters.length, 1);
      assert.strictEqual(clusters[0].superCards.length, 2);
    });

    test('should set display info from best super card', () => {
      const entry = createEntry({
        key: 'e', file: '/e.bib',
        titleFilter: 'test', authorNorm: 'author',
        fields: { title: 'My Title', author: 'My Author', year: '2023' },
      });

      const clusters = buildPaperClusters([entry]);
      assert.strictEqual(clusters[0].displayTitle, 'My Title');
      assert.strictEqual(clusters[0].displayAuthor, 'My Author');
      assert.strictEqual(clusters[0].year, '2023');
    });
  });
});
