import { describe, expect, it } from 'vitest';
import { anchorReaches, headingSlug, headingSlugs, placedAnchors } from '../src/anchor.js';

// The same cases @roobli/md/inline's slug suite holds; the two copies must agree.
describe('heading slugs, as @roobli/md spells them', () => {
  it('slugs as GitHub and Typora do, keeping CJK', () => {
    expect(headingSlug('B12 脚注')).toBe('b12-脚注');
    expect(headingSlug('九、HTML')).toBe('九html');
    expect(headingSlug('What’s new?')).toBe('whats-new');
    expect(headingSlug('  a  b ')).toBe('a--b');
  });

  it('tells repeats apart with a suffix after the first', () => {
    expect(headingSlugs(['B12 脚注', '九、HTML', 'Setup', 'Setup'])).toEqual(['b12-脚注', '九html', 'setup', 'setup-1']);
  });
});

describe('whether a link reaches its place in a note', () => {
  const text = '# Guide\n\n## 五、模型和对话\n\n## Setup\n\n## Setup\n\nA <a id="jump"></a> place and <span id=\'two\'>two</span>.\n\nA line to cite. ^cite-me\n';
  const targets = { headings: ['Guide', '五、模型和对话', 'Setup', 'Setup'], ...placedAnchors(text) };

  it('reads the anchors and block ids a note places', () => {
    expect(placedAnchors(text)).toEqual({ ids: ['jump', 'two'], blocks: ['cite-me'] });
  });

  it('reaches a heading by slug, encoded or not, by its text, and a repeat by its suffix', () => {
    expect(anchorReaches('#五模型和对话', targets)).toBe(true);
    expect(anchorReaches(`#${encodeURIComponent('五模型和对话')}`, targets)).toBe(true);
    expect(anchorReaches('#五、模型和对话', targets)).toBe(true);
    expect(anchorReaches('#setup-1', targets)).toBe(true);
    expect(anchorReaches('#Guide#Setup', targets)).toBe(true);
  });

  it('reaches placed ids and block ids, and nothing that is not there', () => {
    expect(anchorReaches('#jump', targets)).toBe(true);
    expect(anchorReaches('#^cite-me', targets)).toBe(true);
    expect(anchorReaches('#^gone', targets)).toBe(false);
    expect(anchorReaches('#setup-2', targets)).toBe(false);
    expect(anchorReaches('#_7-4-配置xray', targets)).toBe(false);
    expect(anchorReaches('', targets)).toBe(true);
  });
});
