/**
 * Text for SQLite's full-text index, with Chinese, Japanese and Korean made
 * searchable.
 *
 * FTS5's `unicode61` tokenizer splits on spaces and punctuation, so a run of
 * CJK characters would be one token and `方案` would never match inside
 * `改造方案`. Each CJK run is written instead as its overlapping bigrams plus
 * its last character: `改造方案` becomes `改造 造方 方案 案`. A query for a
 * run becomes the phrase of its bigrams, which matches exactly where the run
 * occurs; a one-character query is a prefix query that finds the bigrams it
 * starts and the unigram at a run's end. Everything else is left for
 * `unicode61`, which the query side reuses by quoting it.
 */

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯\u{20000}-\u{2fa1f}]/u;
const CJK_RUN = /[぀-ヿ㐀-䶿一-鿿豈-﫿가-힯\u{20000}-\u{2fa1f}]+/gu;

export const hasCjk = (text: string): boolean => CJK.test(text);

function runTokens(run: string): string[] {
  const chars = [...run];
  if (chars.length === 1) return chars;
  const out: string[] = [];
  for (let at = 0; at + 1 < chars.length; at += 1) out.push(chars[at]! + chars[at + 1]!);
  out.push(chars[chars.length - 1]!);
  return out;
}

/** The text as the index stores it. */
export function indexText(text: string): string {
  return text.replace(CJK_RUN, (run) => ` ${runTokens(run).join(' ')} `);
}

const quote = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** The pieces of a query: CJK runs and the text between them, per word. */
export function queryPieces(query: string): string[] {
  const pieces: string[] = [];
  for (const word of query.trim().split(/\s+/)) {
    if (!word) continue;
    let last = 0;
    for (const match of word.matchAll(CJK_RUN)) {
      const before = word.slice(last, match.index);
      if (/[\p{L}\p{N}]/u.test(before)) pieces.push(before);
      pieces.push(match[0]);
      last = match.index! + match[0].length;
    }
    const after = word.slice(last);
    if (/[\p{L}\p{N}]/u.test(after)) pieces.push(after);
  }
  return pieces;
}

function pieceExpression(piece: string): string {
  if (!hasCjk(piece)) return quote(piece);
  const chars = [...piece];
  if (chars.length === 1) return `${quote(piece)}*`;
  const grams: string[] = [];
  for (let at = 0; at + 1 < chars.length; at += 1) grams.push(chars[at]! + chars[at + 1]!);
  return quote(grams.join(' '));
}

/** An FTS5 MATCH expression: every piece (`all`) or any piece. Null when nothing is searchable. */
export function matchExpression(query: string, mode: 'all' | 'any' = 'all'): string | null {
  const pieces = queryPieces(query);
  if (pieces.length === 0) return null;
  return pieces.map(pieceExpression).join(mode === 'all' ? ' AND ' : ' OR ');
}
