/**
 * Diff algorithms for comparing field values
 */

export interface DiffPart {
  type: 'same' | 'add' | 'remove';
  text: string;
}

/**
 * Consolidate consecutive diff parts of the same type
 */
function consolidate(parts: DiffPart[]): DiffPart[] {
  const result: DiffPart[] = [];
  for (const part of parts) {
    if (result.length > 0 && result[result.length - 1].type === part.type) {
      result[result.length - 1].text += part.text;
    } else {
      result.push({ ...part });
    }
  }
  return result;
}

/**
 * Character-level diff using LCS (Longest Common Subsequence)
 * Best for short strings where individual character changes matter (e.g., titles)
 */
export function computeCharDiff(a: string, b: string): DiffPart[] {
  const m = a.length;
  const n = b.length;

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff: DiffPart[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      diff.unshift({ type: 'same', text: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', text: b[j - 1] });
      j--;
    } else {
      diff.unshift({ type: 'remove', text: a[i - 1] });
      i--;
    }
  }

  return consolidate(diff);
}

/**
 * Word-level diff using LCS on whitespace-separated tokens
 * Better for long strings (e.g., abstracts) where word-level changes are more readable
 */
export function computeWordDiff(a: string, b: string): DiffPart[] {
  const tokenize = (s: string): string[] => {
    const tokens: string[] = [];
    const regex = /(\s+|[^\s]+)/g;
    let m;
    while ((m = regex.exec(s)) !== null) {
      tokens.push(m[0]);
    }
    return tokens;
  };

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  const m = tokensA.length;
  const n = tokensB.length;

  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (tokensA[i - 1] === tokensB[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const diff: DiffPart[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && tokensA[i - 1] === tokensB[j - 1]) {
      diff.unshift({ type: 'same', text: tokensA[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diff.unshift({ type: 'add', text: tokensB[j - 1] });
      j--;
    } else {
      diff.unshift({ type: 'remove', text: tokensA[i - 1] });
      i--;
    }
  }

  return consolidate(diff);
}

/**
 * Compute a diff between two strings, choosing character-level or word-level
 * based on string length. Returns all diff parts (same, add, remove).
 */
export function computeDiff(a: string, b: string): DiffPart[] {
  if (a.length > 250 || b.length > 250) {
    return computeWordDiff(a, b);
  }
  return computeCharDiff(a, b);
}
