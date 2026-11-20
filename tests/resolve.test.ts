import { describe, expect, it } from 'vitest';
import { buildResolveIndex, resolveLink, wikiLinkTo } from '../src/resolve.js';

const files = ['A/Beacon.md', 'A/sub/plan.md', 'B/plan.md', 'B/notes/00_索引.md', 'C/00_索引.md', 'img/a.png', 'Top.md', 'D/README.md'];

describe('resolving a link by the vault tool\'s rules', () => {
  const index = buildResolveIndex(files, new Map([['old/beacon', ['A/Beacon.md']], ['holt', ['A/sub/plan.md']]]));
  const wiki = (target: string, from = '') => resolveLink(index, from, { target, kind: 'wiki' });

  it('tries a wiki link from the root, then from the note, then by a unique name', () => {
    expect(wiki('A/Beacon')?.path).toBe('A/Beacon.md');
    expect(wiki('sub/plan', 'A')?.path).toBe('A/sub/plan.md');
    expect(wiki('Beacon', 'Z')?.path).toBe('A/Beacon.md');
  });

  it('takes the note in the link\'s own folder when a name is shared, and is ambiguous otherwise', () => {
    expect(wiki('plan', 'B')?.path).toBe('B/plan.md');
    expect(wiki('plan', 'Z')).toMatchObject({ path: null, ambiguous: true });
    expect(wiki('00_索引', 'C')?.path).toBe('C/00_索引.md');
  });

  it('tries a Markdown link from the note first, and does not guess a broken path', () => {
    expect(resolveLink(index, 'B', { target: 'plan.md', kind: 'md' })?.path).toBe('B/plan.md');
    expect(resolveLink(index, 'A', { target: '../img/a.png', kind: 'img' })?.path).toBe('img/a.png');
    expect(resolveLink(index, 'A', { target: 'nowhere/x.md', kind: 'md' })).toBeNull();
  });

  it('decodes, and reads a path through the vault\'s own folder from inside it', () => {
    const named = buildResolveIndex(files, undefined, 'My Notes');
    expect(resolveLink(named, '', { target: '/Users/x/My Notes/A/Beacon.md:12', kind: 'md' })?.path).toBe('A/Beacon.md');
    expect(resolveLink(named, 'B', { target: 'My Notes/A/Beacon.md', kind: 'md' })?.path).toBe('A/Beacon.md');
    // Without the folder's name nothing is taken off: another folder called that is just a folder.
    expect(resolveLink(index, '', { target: '/Users/x/My Notes/A/Beacon.md:12', kind: 'md' })).toBeNull();
    expect(wiki('A%2FBeacon')?.path).toBe('A/Beacon.md');
  });

  it('falls back to the name in another case, then to an alias', () => {
    expect(wiki('readme')?.path).toBe('D/README.md');
    expect(wiki('old/beacon')).toMatchObject({ path: 'A/Beacon.md', via: 'alias' });
    expect(wiki('Holt')).toMatchObject({ path: 'A/sub/plan.md', via: 'alias' });
  });

  it('writes a new link bare when the name is unique and from the root when it is not', () => {
    expect(wikiLinkTo(index, 'A/Beacon.md')).toBe('[[Beacon]]');
    expect(wikiLinkTo(index, 'B/plan.md', 'The plan')).toBe('[[B/plan|The plan]]');
  });
});
