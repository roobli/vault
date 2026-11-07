/**
 * What the vault knows about one folder: its notes counted, the warmest and
 * the most read, the ones nothing leads to or from, and its broken links, by
 * the folder's prefix alone and only what the principal may see.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recordEvents } from '../src/events.js';
import { folderAbout } from '../src/folder.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-folder-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write('Areas/A/plan.md', '# Plan\n\nSee [[Areas/A/notes]] and [[Missing note]].\n');
  write('Areas/A/notes.md', '# Notes\n\nPlain.\n');
  write('Areas/A/alone.md', '# Alone\n\nNothing links here, and this links nowhere.\n');
  write('Areas/A_b/other.md', '# Other\n\nA folder whose name starts the same.\n');
  write('Areas/A/secret.md', '---\nsensitivity: sealed\n---\n# Secret\n\nMine.\n');
  write('Elsewhere/essay.md', '# Essay\n\nAbout [[Areas/A/alone]].\n');
  write('.noto/brain.yaml', 'kinds: {}\n');
  const t = (minutes: number) => new Date(Date.now() - (60 - minutes) * 60_000).toISOString();
  recordEvents(root, [
    { time: t(0), actor: 'owner', verb: 'open', path: 'Areas/A/notes.md', session: 's1' },
    { time: t(1), actor: 'owner', verb: 'open', path: 'Areas/A/notes.md', session: 's1' },
    { time: t(2), actor: 'owner', verb: 'open', path: 'Areas/A/plan.md', session: 's1' },
  ]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('a folder', () => {
  it('counts its notes, ranks them by warmth and reads, and names the ones nothing leads to or from', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const about = folderAbout(vault, 'Areas/A/');
      expect(about.folder).toBe('Areas/A');
      // Not Areas/A_b: the prefix is the folder, not the letters.
      expect(about.notes).toBe(4);
      expect(about.mostRead.map((note) => [note.path, note.reads])).toEqual([['Areas/A/notes.md', 2], ['Areas/A/plan.md', 1]]);
      expect(about.warmest[0]!.path).toBe('Areas/A/notes.md');
      // alone.md is linked from Elsewhere, so it is not alone; secret.md is.
      expect(about.orphans).toEqual({ count: 1, items: [expect.objectContaining({ path: 'Areas/A/secret.md' })] });
      expect(about.broken).toBe(1);
      expect(folderAbout(vault, '').notes).toBe(6);
      // A folder is its exact name: on a disk that tells case apart, areas/a is another folder.
      vault.store.db.prepare(`INSERT INTO notes(path, hash, title, kind, sensitivity, chars, frontmatter, headings, tags, aliases, origins)
        VALUES ('areas/a/lower.md', 'x', 'Lower', 'note', 'open', 1, '{}', '[]', '[]', '[]', '{}')`).run();
      expect(folderAbout(vault, 'Areas/A').notes).toBe(4);
      expect(folderAbout(vault, 'areas/a').notes).toBe(1);
      expect(folderAbout(vault, '').notes).toBe(7);
    } finally {
      vault.close();
    }
  });

  it('leaves out what the principal may not see', async () => {
    writeFileSync(path.join(root, '.noto', 'access.yaml'), 'principals: {}\n');
    const vault = await Vault.open(root, {});
    try {
      const about = folderAbout(vault, 'Areas/A');
      expect(about.notes).toBe(3);
      expect(about.orphans.count).toBe(0);
    } finally {
      vault.close();
    }
  });
});
