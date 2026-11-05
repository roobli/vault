import { describe, expect, it } from 'vitest';
import { dateFromName, extractLinks, parseNote } from '../src/markdown.js';

describe('reading a note', () => {
  it('finds wiki links, Markdown links and images outside code, as the vault tool does', () => {
    const text = [
      'See [[Argus]] and [[Work/plan#Goals|the plan]], ![pic](img/a.png) and [doc](../x.md#top).',
      '`[[not a link]]` and a [site](https://example.com) and [[123]] and [[:alpha:]].',
      '```',
      '[[inside a fence]]',
      '```',
    ].join('\n');
    const links = extractLinks(text);
    expect(links.map((link) => [link.kind, link.target, link.anchor, link.label])).toEqual([
      ['wiki', 'Argus', '', null],
      ['wiki', 'Work/plan', '#Goals', 'the plan'],
      ['img', 'img/a.png', '', 'pic'],
      ['md', '../x.md', '#top', 'doc'],
    ]);
  });

  it('reads typed relation lines and leaves ordinary list items alone', () => {
    const text = '# Title\n\n- 属于 [[Argus]]\n- **取代**：[[old plan]]、[[older plan]]\n- see [[X]] for more\n- related: [[Y]]\n';
    const note = parseNote('a.md', text);
    expect(note.links.map((link) => [link.target, link.relation])).toEqual([
      ['Argus', 'part_of'], ['old plan', 'supersedes'], ['older plan', 'supersedes'], ['X', null], ['Y', 'related'],
    ]);
    expect(note.links[0]!.line).toBe(3);
  });

  it('takes the frontmatter title, else an H1 that opens the note, else the file name', () => {
    expect(parseNote('a/b.md', '---\ntitle: Given\n---\n# Heading\n').title).toBe('Given');
    expect(parseNote('a/b.md', '\n\n# Opening\n\ntext\n').title).toBe('Opening');
    expect(parseNote('a/2026_11_05_some-note.md', 'one\ntwo\nthree\nfour\nfive\n# Late\n').title).toBe('2026 11 05 some note');
    expect(parseNote('a/b.md', '```bash\n# comment\n```\n').headings).toEqual([]);
  });

  it('reads the date a log carries in its name', () => {
    expect(dateFromName("X/Y2026_M11/2026_11_05_想法.md")).toBe('2026-11-05');
    expect(dateFromName('a/2026-01-02 notes.md')).toBe('2026-01-02');
    expect(dateFromName('2026_11/notes.md')).toBeNull();
  });
});
