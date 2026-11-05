import { describe, expect, it } from 'vitest';
import { parseYaml, parseYamlMap } from '../src/yaml.js';

describe('the YAML that frontmatter and config use', () => {
  it('reads a project card', () => {
    expect(parseYamlMap(['moc: true', 'id: holt', 'aliases: [TaskStack, culm]', 'status: done', 'started: 2026-09-16', 'repo: roobli/holt', 'tags: [tasks, timeline]'].join('\n')))
      .toEqual({ moc: true, id: 'holt', aliases: ['TaskStack', 'culm'], status: 'done', started: '2026-09-16', repo: 'roobli/holt', tags: ['tasks', 'timeline'] });
  });

  it('reads block sequences, at the key column or indented, and sequences of maps', () => {
    expect(parseYamlMap('tags:\n- a\n- "b, c"\nother:\n  - x\n  - y\n')).toEqual({ tags: ['a', 'b, c'], other: ['x', 'y'] });
    expect(parseYaml('- name: a\n  value: 1\n- name: b\n')).toEqual([{ name: 'a', value: 1 }, { name: 'b' }]);
  });

  it('reads nested maps, comments, quotes and URLs', () => {
    const text = [
      '# policy',
      'sensitivity:',
      '  default: open   # the rest',
      '  private: ["Work/", "Journal/"]',
      'principals:',
      '  claude-code:',
      "    keys: ['ab#cd']",
      '    read: ["**"]',
      'url: https://example.com/a#b',
      "title: 'It''s: here'",
      'empty:',
    ].join('\n');
    expect(parseYamlMap(text)).toEqual({
      sensitivity: { default: 'open', private: ['Work/', 'Journal/'] },
      principals: { 'claude-code': { keys: ['ab#cd'], read: ['**'] } },
      url: 'https://example.com/a#b',
      title: "It's: here",
      empty: null,
    });
  });

  it('types plain scalars by the core schema and leaves dates and padded numbers as written', () => {
    expect(parseYamlMap('a: 12\nb: 1.5\nc: false\nd: ~\ne: 007\nf: no\ng: 2026-11-05')).toEqual({ a: 12, b: 1.5, c: false, d: null, e: '007', f: 'no', g: '2026-11-05' });
  });

  it('reads literal and folded block scalars', () => {
    expect(parseYamlMap('a: |\n  one\n  two\nb: >-\n  one\n  two\n\n  three\nc: 1')).toEqual({ a: 'one\ntwo\n', b: 'one two\nthree', c: 1 });
  });

  it('reads flow collections that run over lines, and nested ones', () => {
    expect(parseYamlMap('a: [x,\n  y, [z]]\nb: {k: v, n: 2}')).toEqual({ a: ['x', 'y', ['z']], b: { k: 'v', n: 2 } });
  });

  it('gives what it can of text that is not a map', () => {
    expect(parseYamlMap('just a line')).toEqual({});
    expect(parseYamlMap('')).toEqual({});
  });
});
