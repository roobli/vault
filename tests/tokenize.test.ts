import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { indexText, matchExpression } from '../src/tokenize.js';

describe('full text over Chinese and English', () => {
  it('writes CJK runs as bigrams and the run\'s last character', () => {
    expect(indexText('GFW改造方案ok')).toBe('GFW 改造 造方 方案 案 ok');
    expect(indexText('一')).toBe(' 一 ');
  });

  it('finds two-character words, one-character prefixes and English inside mixed text', () => {
    const db = new DatabaseSync(':memory:');
    db.exec("CREATE VIRTUAL TABLE t USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2')");
    const rows = ['看完GFW之后的改造方案', '方便面不是方案', 'kubectl_get pods quickly'];
    rows.forEach((row, at) => db.prepare('INSERT INTO t(rowid, body) VALUES (?, ?)').run(at + 1, indexText(row)));
    const find = (query: string) => (db.prepare('SELECT rowid FROM t WHERE t MATCH ? ORDER BY rowid').all(matchExpression(query)!) as { rowid: number }[]).map((row) => row.rowid);
    expect(find('方案')).toEqual([1, 2]);
    expect(find('改造方案')).toEqual([1]);
    expect(find('gfw 改造')).toEqual([1]);
    expect(find('面')).toEqual([2]);
    expect(find('kubectl_get')).toEqual([3]);
    expect(find('造方案')).toEqual([1]);
    expect(matchExpression('  ,, ')).toBeNull();
  });
});

describe('the words of a question', () => {
  it('keeps topic bigrams and English words, and drops question words and particles', async () => {
    const { looseTerms } = await import('../src/tokenize.js');
    expect(looseTerms('控制面要不要迁到亚马逊的轻量服务器')).toEqual(['控制', '制面', '面要', '要迁', '迁到', '到亚', '亚马', '马逊', '轻量', '量服', '服务', '务器']);
    expect(looseTerms('how does the GFW detect proxies')).toEqual(['gfw', 'detect', 'proxies']);
    expect(looseTerms('怎么')).toEqual([]);
  });
});
