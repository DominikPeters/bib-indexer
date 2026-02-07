import * as assert from 'assert';
import { SearchIndexManager } from '../search';
import { IndexedEntry } from '../types';

suite('Search Test Suite', () => {
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

  suite('SearchIndexManager', () => {
    test('should return empty results for empty query', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([]);

      const results = searchIndex.search('');
      assert.strictEqual(results.length, 0);
    });

    test('should return empty results for short query', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({ key: 'entry1', titleFilter: 'game theory introduction' }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('g'); // too short
      assert.strictEqual(results.length, 0);
    });

    test('should find entries by title', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'arrow1951',
          file: '/test/file1.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/file2.bib',
          titleFilter: 'equilibrium points in n-person games',
          authorNorm: 'nash',
        }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('social choice');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'arrow1951');
    });

    test('should find entries by author', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'arrow1951',
          file: '/test/file1.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/file2.bib',
          titleFilter: 'equilibrium points in n-person games',
          authorNorm: 'nash',
        }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('nash');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'nash1950');
    });

    test('should find entries by key', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'arrow1951',
          file: '/test/file1.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/file2.bib',
          titleFilter: 'equilibrium points in n-person games',
          authorNorm: 'nash',
        }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('arrow1951');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'arrow1951');
    });

    test('should find entries by year', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'arrow1951',
          file: '/test/file1.bib',
          titleFilter: 'social choice',
          authorNorm: 'arrow',
          fields: { title: 'Social Choice', year: '1951' },
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/file2.bib',
          titleFilter: 'equilibrium',
          authorNorm: 'nash',
          fields: { title: 'Equilibrium', year: '1950' },
        }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('1951');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'arrow1951');
    });

    test('should find multiple matching entries', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'game1',
          file: '/test/file1.bib',
          titleFilter: 'introduction to game theory',
          authorNorm: 'author1',
        }),
        createEntry({
          key: 'game2',
          file: '/test/file2.bib',
          titleFilter: 'advanced game theory',
          authorNorm: 'author2',
        }),
        createEntry({
          key: 'quantum',
          file: '/test/file3.bib',
          titleFilter: 'quantum mechanics',
          authorNorm: 'author3',
        }),
      ];
      searchIndex.rebuild(entries);

      const results = searchIndex.search('game theory');
      assert.strictEqual(results.length, 2);
      const keys = results.map(e => e.key);
      assert.ok(keys.includes('game1'));
      assert.ok(keys.includes('game2'));
    });

    test('should find entries with AND across different fields (author + title)', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'pacuit2019',
          file: '/test/file1.bib',
          titleFilter: 'the condorcet jury theorem',
          authorNorm: 'pacuit',
        }),
        createEntry({
          key: 'condorcet1785',
          file: '/test/file2.bib',
          titleFilter: 'essay on the application of analysis',
          authorNorm: 'condorcet',
        }),
        createEntry({
          key: 'pacuit2020',
          file: '/test/file3.bib',
          titleFilter: 'voting theory and causal inference',
          authorNorm: 'pacuit',
        }),
      ];
      searchIndex.rebuild(entries);

      // "pacuit condorcet" should only match entry with both terms
      const results = searchIndex.search('pacuit condorcet');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'pacuit2019');
    });

    test('should find entries by journal or booktitle', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'arrow1951',
          file: '/test/file1.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
          fields: { title: 'Social Choice', journal: 'Econometrica' },
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/file2.bib',
          titleFilter: 'equilibrium points',
          authorNorm: 'nash',
          fields: { title: 'Equilibrium', booktitle: 'Proceedings of NAS' },
        }),
      ];
      searchIndex.rebuild(entries);

      // Search by journal
      let results = searchIndex.search('econometrica');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'arrow1951');

      // Search by booktitle
      results = searchIndex.search('proceedings nas');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'nash1950');

      // Cross-field: author + journal
      results = searchIndex.search('arrow econometrica');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'arrow1951');
    });

    test('should respect limit parameter', () => {
      const searchIndex = new SearchIndexManager();
      const entries = Array.from({ length: 100 }, (_, i) =>
        createEntry({
          key: `entry${i}`,
          file: `/test/file${i}.bib`,
          titleFilter: `game theory paper number ${i}`,
          authorNorm: `author${i}`,
        })
      );
      searchIndex.rebuild(entries);

      const results = searchIndex.search('game theory', 10);
      assert.ok(results.length <= 10, `Expected <= 10 results, got ${results.length}`);
    });
  });

  suite('findDuplicateCandidates', () => {
    test('should return empty for short titles', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({ key: 'entry1', titleFilter: 'ab' }), // too short
      ];
      searchIndex.rebuild(entries);

      const entry = createEntry({ key: 'query', titleFilter: 'ab' });
      const candidates = searchIndex.findDuplicateCandidates(entry);
      assert.strictEqual(candidates.length, 0);
    });

    test('should find entries with similar titles', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'entry1',
          file: '/test/file1.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'entry2',
          file: '/test/file2.bib',
          titleFilter: 'social choice and individual values revised',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'entry3',
          file: '/test/file3.bib',
          titleFilter: 'quantum mechanics basics',
          authorNorm: 'feynman',
        }),
      ];
      searchIndex.rebuild(entries);

      const queryEntry = createEntry({
        key: 'query',
        file: '/test/query.bib',
        titleFilter: 'social choice and individual values',
        authorNorm: 'arrow',
      });

      const candidates = searchIndex.findDuplicateCandidates(queryEntry);
      // Should find entries with similar titles, not the quantum one
      assert.ok(candidates.length >= 1, 'Should find at least one candidate');
      const keys = candidates.map(e => e.key);
      assert.ok(keys.includes('entry1') || keys.includes('entry2'), 'Should find similar entries');
    });

    test('should exclude the query entry itself', () => {
      const searchIndex = new SearchIndexManager();
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        titleFilter: 'social choice and individual values',
      });
      searchIndex.rebuild([entry]);

      const candidates = searchIndex.findDuplicateCandidates(entry);
      const keys = candidates.map(e => e.key);
      assert.ok(!keys.includes('entry1'), 'Should not include the entry itself');
    });
  });

  suite('findDoiMatches', () => {
    test('should return empty for entry without DOI', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({ key: 'entry1', doi: '10.1000/test1' }),
        createEntry({ key: 'entry2', doi: '10.1000/test2' }),
      ];
      searchIndex.rebuild(entries);

      const queryEntry = createEntry({ key: 'query' }); // no DOI
      const matches = searchIndex.findDoiMatches(queryEntry);
      assert.strictEqual(matches.length, 0);
    });

    test('should find entries with matching DOI', () => {
      const searchIndex = new SearchIndexManager();
      const entries = [
        createEntry({
          key: 'entry1',
          file: '/test/file1.bib',
          doi: '10.1000/matching',
        }),
        createEntry({
          key: 'entry2',
          file: '/test/file2.bib',
          doi: '10.1000/different',
        }),
        createEntry({
          key: 'entry3',
          file: '/test/file3.bib',
          doi: '10.1000/matching', // same DOI as entry1
        }),
      ];
      searchIndex.rebuild(entries);

      const queryEntry = createEntry({
        key: 'query',
        file: '/test/query.bib',
        doi: '10.1000/matching',
      });

      const matches = searchIndex.findDoiMatches(queryEntry);
      assert.strictEqual(matches.length, 2);
      const keys = matches.map(e => e.key);
      assert.ok(keys.includes('entry1'));
      assert.ok(keys.includes('entry3'));
      assert.ok(!keys.includes('entry2'));
    });

    test('should exclude the query entry itself from DOI matches', () => {
      const searchIndex = new SearchIndexManager();
      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        doi: '10.1000/test',
      });
      searchIndex.rebuild([entry]);

      const matches = searchIndex.findDoiMatches(entry);
      assert.strictEqual(matches.length, 0);
    });
  });

  suite('rebuild', () => {
    test('should clear previous index on rebuild', () => {
      const searchIndex = new SearchIndexManager();

      // First build
      searchIndex.rebuild([
        createEntry({
          key: 'old',
          file: '/test/old.bib',
          titleFilter: 'old entry title',
        }),
      ]);

      let results = searchIndex.search('old entry');
      assert.strictEqual(results.length, 1);

      // Rebuild with different entries
      searchIndex.rebuild([
        createEntry({
          key: 'new',
          file: '/test/new.bib',
          titleFilter: 'new entry title',
        }),
      ]);

      // Old entry should not be found
      results = searchIndex.search('old entry');
      assert.strictEqual(results.length, 0);

      // New entry should be found
      results = searchIndex.search('new entry');
      assert.strictEqual(results.length, 1);
      assert.strictEqual(results[0].key, 'new');
    });
  });

  suite('removeFile', () => {
    test('should remove entries for a specific file', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([
        createEntry({
          key: 'entry1',
          file: '/test/file1.bib',
          titleFilter: 'social choice theory',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'entry2',
          file: '/test/file2.bib',
          titleFilter: 'game theory introduction',
          authorNorm: 'nash',
        }),
      ]);

      searchIndex.removeFile('/test/file1.bib');

      const results1 = searchIndex.search('social choice');
      assert.strictEqual(results1.length, 0);

      const results2 = searchIndex.search('game theory');
      assert.strictEqual(results2.length, 1);
      assert.strictEqual(results2[0].key, 'entry2');
    });

    test('should remove DOI mappings for removed file', () => {
      const searchIndex = new SearchIndexManager();
      const entry1 = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        titleFilter: 'social choice theory',
        doi: '10.1234/test',
      });
      const entry2 = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        titleFilter: 'game theory',
        doi: '10.1234/test', // same DOI
      });
      searchIndex.rebuild([entry1, entry2]);

      searchIndex.removeFile('/test/file1.bib');

      // DOI match should no longer return the removed entry
      const matches = searchIndex.findDoiMatches(entry2);
      assert.strictEqual(matches.length, 0);
    });

    test('should handle removing a file that is not indexed', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([
        createEntry({ key: 'entry1', file: '/test/file1.bib', titleFilter: 'test title' }),
      ]);

      // Should not throw
      searchIndex.removeFile('/test/nonexistent.bib');

      const results = searchIndex.search('test title');
      assert.strictEqual(results.length, 1);
    });

    test('should remove all entries from a file with multiple entries', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([
        createEntry({
          key: 'arrow1951',
          file: '/test/refs.bib',
          titleFilter: 'social choice and individual values',
          authorNorm: 'arrow',
        }),
        createEntry({
          key: 'nash1950',
          file: '/test/refs.bib',
          titleFilter: 'equilibrium points in n person games',
          authorNorm: 'nash',
        }),
        createEntry({
          key: 'other',
          file: '/test/other.bib',
          titleFilter: 'something else entirely',
          authorNorm: 'other',
        }),
      ]);

      searchIndex.removeFile('/test/refs.bib');

      assert.strictEqual(searchIndex.search('social choice').length, 0);
      assert.strictEqual(searchIndex.search('equilibrium').length, 0);
      assert.strictEqual(searchIndex.search('something else').length, 1);
    });
  });

  suite('addEntries', () => {
    test('should add entries incrementally', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([
        createEntry({
          key: 'entry1',
          file: '/test/file1.bib',
          titleFilter: 'social choice theory',
          authorNorm: 'arrow',
        }),
      ]);

      searchIndex.addEntries([
        createEntry({
          key: 'entry2',
          file: '/test/file2.bib',
          titleFilter: 'game theory introduction',
          authorNorm: 'nash',
        }),
      ]);

      const results1 = searchIndex.search('social choice');
      assert.strictEqual(results1.length, 1);

      const results2 = searchIndex.search('game theory');
      assert.strictEqual(results2.length, 1);
      assert.strictEqual(results2[0].key, 'entry2');
    });

    test('should make new entries findable by DOI', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([]);

      const entry = createEntry({
        key: 'entry1',
        file: '/test/file1.bib',
        titleFilter: 'test title',
        doi: '10.1234/added',
      });
      searchIndex.addEntries([entry]);

      const entry2 = createEntry({
        key: 'entry2',
        file: '/test/file2.bib',
        titleFilter: 'test title duplicate',
        doi: '10.1234/added',
      });
      searchIndex.addEntries([entry2]);

      const matches = searchIndex.findDoiMatches(entry);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].key, 'entry2');
    });

    test('should make new entries findable as duplicate candidates', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([]);

      const entry1 = createEntry({
        key: 'arrow1',
        file: '/test/file1.bib',
        titleFilter: 'social choice and individual values',
        authorNorm: 'arrow',
      });
      const entry2 = createEntry({
        key: 'arrow2',
        file: '/test/file2.bib',
        titleFilter: 'social choice and individual values',
        authorNorm: 'arrow',
      });

      searchIndex.addEntries([entry1, entry2]);

      const candidates = searchIndex.findDuplicateCandidates(entry1);
      assert.ok(candidates.some(c => c.key === 'arrow2'));
    });
  });

  suite('removeFile + addEntries (simulate re-index)', () => {
    test('should correctly replace entries for a file', () => {
      const searchIndex = new SearchIndexManager();
      searchIndex.rebuild([
        createEntry({
          key: 'old_entry',
          file: '/test/refs.bib',
          titleFilter: 'old title before edit',
          authorNorm: 'old',
        }),
        createEntry({
          key: 'keep_entry',
          file: '/test/other.bib',
          titleFilter: 'this should stay',
          authorNorm: 'keep',
        }),
      ]);

      // Simulate re-indexing /test/refs.bib with updated content
      searchIndex.removeFile('/test/refs.bib');
      searchIndex.addEntries([
        createEntry({
          key: 'new_entry',
          file: '/test/refs.bib',
          titleFilter: 'new title after edit',
          authorNorm: 'new',
        }),
      ]);

      // Old entry gone
      assert.strictEqual(searchIndex.search('old title').length, 0);
      // New entry findable
      assert.strictEqual(searchIndex.search('new title').length, 1);
      assert.strictEqual(searchIndex.search('new title')[0].key, 'new_entry');
      // Other file untouched
      assert.strictEqual(searchIndex.search('this should stay').length, 1);
    });

    test('DOI mappings update correctly after re-index', () => {
      const searchIndex = new SearchIndexManager();
      const otherEntry = createEntry({
        key: 'other',
        file: '/test/other.bib',
        titleFilter: 'other paper',
        doi: '10.1234/shared',
      });
      searchIndex.rebuild([
        createEntry({
          key: 'old',
          file: '/test/refs.bib',
          titleFilter: 'old paper',
          doi: '10.1234/shared',
        }),
        otherEntry,
      ]);

      // Before: other should find old via DOI
      assert.strictEqual(searchIndex.findDoiMatches(otherEntry).length, 1);

      // Re-index refs.bib without the DOI
      searchIndex.removeFile('/test/refs.bib');
      searchIndex.addEntries([
        createEntry({
          key: 'new',
          file: '/test/refs.bib',
          titleFilter: 'new paper no doi',
        }),
      ]);

      // DOI match should be gone
      assert.strictEqual(searchIndex.findDoiMatches(otherEntry).length, 0);

      // Add it back with DOI
      searchIndex.removeFile('/test/refs.bib');
      searchIndex.addEntries([
        createEntry({
          key: 'newest',
          file: '/test/refs.bib',
          titleFilter: 'newest paper',
          doi: '10.1234/shared',
        }),
      ]);

      const matches = searchIndex.findDoiMatches(otherEntry);
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0].key, 'newest');
    });
  });
});
