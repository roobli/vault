/**
 * Links written again after a move: each reaches the same note as before,
 * keeps how it was written, and nothing else in the note changes.
 */

import { describe, expect, it } from 'vitest';
import { relink, relinkTokens, type Move } from '../src/relink.js';

/** The files after the moves, and the text of the notes, by where they are now. */
function run(files: string[], moves: Move[], notes: Record<string, string>) {
  const out = relink({ files, moves, notes: new Map(Object.entries(notes)), rootName: 'RooB' });
  return Object.fromEntries(out.map((note) => [note.path, note.text]));
}

describe('a note moved', () => {
  const files = ['Work/plan.md', 'Ideas/notes.md', 'Ideas/img/a.png', 'essay.md', 'Elsewhere/x.md'];
  const moves = [{ from: 'Ideas/plan.md', to: 'Work/plan.md' }];
  it('writes the links that named its old place again, in their own style, and leaves the rest', () => {
    const out = run(files, moves, {
      'essay.md': [
        'By path [[Ideas/plan]] and by name [[plan]], labelled [[Ideas/plan#Goals|the plan]].',
        'Relative [p](Ideas/plan.md#goals) and without the extension [q](Ideas/plan).',
        'Absolute [r](/Users/me/RooB/Ideas/plan.md:12) and from the root [s](/Ideas/plan.md).',
        'Already broken [b](Ideas/gone.md), and in code `[c](Ideas/plan.md)`.',
      ].join('\n'),
      'Elsewhere/x.md': 'Up and over [p](../Ideas/plan.md), and <[p](<../Ideas/plan.md>)>.',
    });
    expect(out['essay.md']).toBe([
      'By path [[Work/plan]] and by name [[plan]], labelled [[Work/plan#Goals|the plan]].',
      'Relative [p](Work/plan.md#goals) and without the extension [q](Work/plan).',
      // The vault reads no link from the root as a path, so none reached the note to be broken.
      'Absolute [r](/Users/me/RooB/Work/plan.md:12) and from the root [s](/Ideas/plan.md).',
      'Already broken [b](Ideas/gone.md), and in code `[c](Ideas/plan.md)`.',
    ].join('\n'));
    expect(out['Elsewhere/x.md']).toBe('Up and over [p](../Work/plan.md), and <[p](<../Work/plan.md>)>.');
  });

  it('writes its own relative links to the neighbours it left, pictures too', () => {
    const out = run(files, moves, { 'Work/plan.md': 'See [n](notes.md), ![a](img/a.png) and [[notes]].' });
    expect(out['Work/plan.md']).toBe('See [n](../Ideas/notes.md), ![a](../Ideas/img/a.png) and [[notes]].');
  });
});

describe('links the parser once read wrong', () => {
  it('writes the link around a picture, and the picture, each once', () => {
    const files = ['Work/a.md', 'Work/pic.png', 'essay.md'];
    const moves = [{ from: 'a.md', to: 'Work/a.md' }, { from: 'pic.png', to: 'Work/pic.png' }];
    const out = run(files, moves, { 'essay.md': 'A badge [![i](pic.png)](a.md), and the same twice [![i](a.md)](a.md).' });
    expect(out['essay.md']).toBe('A badge [![i](Work/pic.png)](Work/a.md), and the same twice [![i](Work/a.md)](Work/a.md).');
  });

  it("follows a note out of the root to the neighbours it left there, which other tools read from the note", () => {
    const out = run(['sub/a.md', 'x.md', 'docs/y.md'], [{ from: 'a.md', to: 'sub/a.md' }], { 'sub/a.md': '[x](x.md) and [y](docs/y.md)' });
    expect(out['sub/a.md']).toBe('[x](../x.md) and [y](../docs/y.md)');
  });

  it('leaves an escaped bracket alone: it was written so as not to be a link', () => {
    expect(run(['Work/a.md', 'essay.md'], [{ from: 'a.md', to: 'Work/a.md' }], { 'essay.md': String.raw`\[x](a.md) but [y](a.md)` }))
      .toEqual({ 'essay.md': String.raw`\[x](a.md) but [y](Work/a.md)` });
  });
});

describe('a note renamed', () => {
  it('follows the new name, keeps labels, and falls back to the path when the name is taken', () => {
    const files = ['Ideas/roadmap.md', 'essay.md', 'Old/roadmap2.md'];
    const out = run(files, [{ from: 'Ideas/plan.md', to: 'Ideas/roadmap.md' }], {
      'essay.md': '[[plan]], [[plan|my plan]], ![[plan]] and [x](Ideas/plan.md).',
    });
    expect(out['essay.md']).toBe('[[roadmap]], [[roadmap|my plan]], ![[roadmap]] and [x](Ideas/roadmap.md).');
    const taken = run(['Ideas/roadmap.md', 'Other/roadmap.md', 'essay.md'], [{ from: 'Ideas/plan.md', to: 'Ideas/roadmap.md' }], { 'essay.md': '[[plan]]' });
    expect(taken['essay.md']).toBe('[[Ideas/roadmap]]');
  });
});

describe('a folder moved', () => {
  it('writes links into it and out of it again, and leaves links inside it alone', () => {
    const files = ['Archive/Ideas/plan.md', 'Archive/Ideas/notes.md', 'essay.md'];
    const moves = [
      { from: 'Ideas/plan.md', to: 'Archive/Ideas/plan.md' },
      { from: 'Ideas/notes.md', to: 'Archive/Ideas/notes.md' },
    ];
    const out = run(files, moves, {
      'essay.md': '[p](Ideas/plan.md) and [[Ideas/notes]].',
      'Archive/Ideas/plan.md': '[n](notes.md) and [e](../essay.md).',
    });
    expect(out['essay.md']).toBe('[p](Archive/Ideas/plan.md) and [[Archive/Ideas/notes]].');
    expect(out['Archive/Ideas/plan.md']).toBe('[n](notes.md) and [e](../../essay.md).');
    expect(relinkTokens([{ from: 'Ideas', to: 'Archive/Ideas' }])).toEqual(['Ideas']);
  });

  it('keeps spaces escaped as they were written, in angle brackets too', () => {
    const files = ['New Place/my note.md', 'essay.md'];
    const out = run(files, [{ from: 'Old/my note.md', to: 'New Place/my note.md' }], {
      'essay.md': '[a](Old/my%20note.md) [b](<Old/my%20note.md>)',
    });
    expect(out['essay.md']).toBe('[a](New%20Place/my%20note.md) [b](<New%20Place/my%20note.md>)');
  });

  it('says nothing about a note it had nothing to change in', () => {
    expect(run(['Work/plan.md', 'essay.md'], [{ from: 'Ideas/plan.md', to: 'Work/plan.md' }], { 'essay.md': 'No links, [[plan]] by name only.' })).toEqual({});
  });
});
