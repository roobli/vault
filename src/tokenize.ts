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

/** Bigrams that carry no topic: question words, connectives, pronouns. */
const STOP_BIGRAMS = new Set([
  '怎么', '什么', '为什', '么样', '要不', '不要', '是不', '不是', '有没', '没有', '哪些', '哪个', '如何', '为何', '可以', '能不', '不能',
  '应该', '以后', '之后', '之前', '时候', '这个', '那个', '这些', '那些', '一个', '一下', '还有', '以及', '或者', '还是', '我们', '你们',
  '他们', '自己', '已经', '就是', '但是', '因为', '所以', '如果', '的话', '怎样', '多少', '到底', '一些', '这样', '那样', '然后', '其实',
]);
/** Characters that only bind words together; a bigram that holds one says nothing. */
const FUNCTION_CHARS = new Set([...'的了吗呢吧啊么和与及跟把被给是我你他她它在都也就又才得地着过啥哪该']);
const ENGLISH_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'and', 'or', 'is', 'are', 'was', 'be', 'do', 'does', 'how', 'what', 'why', 'which', 'when', 'where', 'who', 'it', 'this', 'that', 'i', 'we', 'you', 'my', 'our']);

/**
 * The words of a question, for recall: each English word, and the bigrams of
 * each CJK run less those made of question words and particles, any of which
 * may match. A question is rarely written word for word in the note that
 * answers it; BM25 then ranks by how many of the rarer pieces a note holds.
 */
export function looseTerms(query: string): string[] {
  const terms = new Set<string>();
  for (const piece of queryPieces(query)) {
    if (!hasCjk(piece)) {
      for (const word of piece.toLowerCase().split(/[^\p{L}\p{N}]+/u)) if (word && !ENGLISH_STOP.has(word)) terms.add(word);
      continue;
    }
    const chars = [...piece];
    if (chars.length === 1) continue;
    for (let at = 0; at + 1 < chars.length; at += 1) {
      const gram = chars[at]! + chars[at + 1]!;
      if (STOP_BIGRAMS.has(gram) || FUNCTION_CHARS.has(chars[at]!) || FUNCTION_CHARS.has(chars[at + 1]!)) continue;
      terms.add(gram);
    }
  }
  return [...terms];
}

/** An FTS5 expression where any of the loose terms may match; null when none is left. */
export function looseExpression(query: string): string | null {
  const terms = looseTerms(query);
  return terms.length === 0 ? null : terms.map(quote).join(' OR ');
}
