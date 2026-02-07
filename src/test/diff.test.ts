import * as assert from 'assert';
import { computeCharDiff, computeWordDiff, computeDiff, DiffPart } from '../diff';

/** Helper: extract only the text of parts with a given type */
function textOfType(parts: DiffPart[], type: DiffPart['type']): string {
  return parts.filter(p => p.type === type).map(p => p.text).join('');
}

/** Helper: reconstruct "b" from the diff (same + add parts) */
function reconstructB(parts: DiffPart[]): string {
  return parts.filter(p => p.type !== 'remove').map(p => p.text).join('');
}

/** Helper: reconstruct "a" from the diff (same + remove parts) */
function reconstructA(parts: DiffPart[]): string {
  return parts.filter(p => p.type !== 'add').map(p => p.text).join('');
}

suite('Diff Test Suite', () => {
  suite('computeCharDiff', () => {
    test('identical strings produce only same parts', () => {
      const diff = computeCharDiff('hello', 'hello');
      assert.strictEqual(diff.length, 1);
      assert.strictEqual(diff[0].type, 'same');
      assert.strictEqual(diff[0].text, 'hello');
    });

    test('empty strings produce empty diff', () => {
      const diff = computeCharDiff('', '');
      assert.strictEqual(diff.length, 0);
    });

    test('addition from empty', () => {
      const diff = computeCharDiff('', 'abc');
      assert.strictEqual(diff.length, 1);
      assert.strictEqual(diff[0].type, 'add');
      assert.strictEqual(diff[0].text, 'abc');
    });

    test('removal to empty', () => {
      const diff = computeCharDiff('abc', '');
      assert.strictEqual(diff.length, 1);
      assert.strictEqual(diff[0].type, 'remove');
      assert.strictEqual(diff[0].text, 'abc');
    });

    test('single character change', () => {
      const diff = computeCharDiff('cat', 'car');
      // Should have: same "ca", remove "t", add "r"
      assert.strictEqual(reconstructA(diff), 'cat');
      assert.strictEqual(reconstructB(diff), 'car');
    });

    test('insertion in middle', () => {
      const diff = computeCharDiff('ac', 'abc');
      assert.strictEqual(reconstructA(diff), 'ac');
      assert.strictEqual(reconstructB(diff), 'abc');
      assert.strictEqual(textOfType(diff, 'add'), 'b');
    });

    test('deletion in middle', () => {
      const diff = computeCharDiff('abc', 'ac');
      assert.strictEqual(reconstructA(diff), 'abc');
      assert.strictEqual(reconstructB(diff), 'ac');
      assert.strictEqual(textOfType(diff, 'remove'), 'b');
    });

    test('consolidates consecutive parts of same type', () => {
      const diff = computeCharDiff('aaa', 'bbb');
      // Should be consolidated into at most a few parts, not 6 individual chars
      for (let i = 1; i < diff.length; i++) {
        assert.notStrictEqual(diff[i].type, diff[i - 1].type,
          'consecutive parts should not have the same type');
      }
    });

    test('handles BibTeX title change', () => {
      const diff = computeCharDiff(
        'Social Choice and Individual Values',
        'Social Choice and Individual Welfare'
      );
      assert.strictEqual(reconstructA(diff), 'Social Choice and Individual Values');
      assert.strictEqual(reconstructB(diff), 'Social Choice and Individual Welfare');
      // The common prefix "Social Choice and Individual " should be same
      assert.ok(diff[0].type === 'same');
      assert.ok(diff[0].text.startsWith('Social Choice and Individual '));
    });

    test('handles braces in BibTeX values', () => {
      const diff = computeCharDiff('{Nash} Equilibrium', '{Nash} Bargaining');
      assert.strictEqual(reconstructA(diff), '{Nash} Equilibrium');
      assert.strictEqual(reconstructB(diff), '{Nash} Bargaining');
    });
  });

  suite('computeWordDiff', () => {
    test('identical strings produce only same parts', () => {
      const diff = computeWordDiff('hello world', 'hello world');
      assert.strictEqual(reconstructB(diff), 'hello world');
      assert.strictEqual(textOfType(diff, 'add'), '');
      assert.strictEqual(textOfType(diff, 'remove'), '');
    });

    test('empty strings produce empty diff', () => {
      const diff = computeWordDiff('', '');
      assert.strictEqual(diff.length, 0);
    });

    test('single word change', () => {
      const diff = computeWordDiff('the cat sat', 'the dog sat');
      assert.strictEqual(reconstructA(diff), 'the cat sat');
      assert.strictEqual(reconstructB(diff), 'the dog sat');
      assert.ok(textOfType(diff, 'remove').includes('cat'));
      assert.ok(textOfType(diff, 'add').includes('dog'));
    });

    test('word insertion', () => {
      const diff = computeWordDiff('hello world', 'hello beautiful world');
      assert.strictEqual(reconstructA(diff), 'hello world');
      assert.strictEqual(reconstructB(diff), 'hello beautiful world');
    });

    test('word deletion', () => {
      const diff = computeWordDiff('hello beautiful world', 'hello world');
      assert.strictEqual(reconstructA(diff), 'hello beautiful world');
      assert.strictEqual(reconstructB(diff), 'hello world');
    });

    test('preserves whitespace in tokens', () => {
      const diff = computeWordDiff('a  b', 'a  c');
      // The double space should be preserved in reconstruction
      assert.strictEqual(reconstructA(diff), 'a  b');
      assert.strictEqual(reconstructB(diff), 'a  c');
    });

    test('handles long abstract-like text', () => {
      const a = 'We study the problem of aggregating preferences in social choice theory using axiomatic methods';
      const b = 'We study the problem of aggregating preferences in voting theory using computational methods';
      const diff = computeWordDiff(a, b);
      assert.strictEqual(reconstructA(diff), a);
      assert.strictEqual(reconstructB(diff), b);
      // "social" should be removed, "voting" added
      assert.ok(textOfType(diff, 'remove').includes('social'));
      assert.ok(textOfType(diff, 'add').includes('voting'));
      // "axiomatic" removed, "computational" added
      assert.ok(textOfType(diff, 'remove').includes('axiomatic'));
      assert.ok(textOfType(diff, 'add').includes('computational'));
    });

    test('consolidates consecutive same-type parts', () => {
      const diff = computeWordDiff('a b c', 'd e f');
      for (let i = 1; i < diff.length; i++) {
        assert.notStrictEqual(diff[i].type, diff[i - 1].type,
          'consecutive parts should not have the same type');
      }
    });
  });

  suite('computeDiff (auto-selection)', () => {
    test('uses char diff for short strings', () => {
      const short = 'hello world';
      const charResult = computeCharDiff(short, short + '!');
      const autoResult = computeDiff(short, short + '!');
      // Should produce the same result as char diff
      assert.deepStrictEqual(autoResult, charResult);
    });

    test('uses word diff for long strings', () => {
      const long = 'word '.repeat(60); // 300 chars
      const longB = long + 'extra';
      const wordResult = computeWordDiff(long, longB);
      const autoResult = computeDiff(long, longB);
      assert.deepStrictEqual(autoResult, wordResult);
    });

    test('threshold is 250 chars', () => {
      // Both strings <= 250 chars - should use char diff
      const shortA = 'x'.repeat(200);
      const shortB = 'x'.repeat(200) + 'y';
      const charResult = computeCharDiff(shortA, shortB);
      const autoResult = computeDiff(shortA, shortB);
      assert.deepStrictEqual(autoResult, charResult);

      // One string > 250 chars - should switch to word diff
      const words = 'word '.repeat(51); // 255 chars
      const wordsB = words + 'extra';
      const wordResult = computeWordDiff(words, wordsB);
      const autoResult2 = computeDiff(words, wordsB);
      assert.deepStrictEqual(autoResult2, wordResult);
    });
  });
});
