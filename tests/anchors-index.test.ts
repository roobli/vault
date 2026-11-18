/**
 * A link that reaches its note but not the place its `#anchor` names is
 * counted apart from a broken one, and the count follows the note it points
 * into: renaming a heading there breaks the link here, and naming it back
 * mends it, with only the renamed note refreshed.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { about } from '../src/about.js';
import { folderAbout } from '../src/folder.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const GUIDE = '# Guide\n\n## 五、模型和对话\n\nText.\n\n## Setup\n\nA <a id="jump"></a> place. A line to cite. ^cite-me\n';
const LINKS = [
  '# Links',
  '',
  '- [[guide#五、模型和对话]] by its text',
  '- [slug](guide.md#五模型和对话) by its slug',
  '- [[guide#Setup]] and [[guide#^cite-me]] and [[guide#jump]]',
  '- [[guide#Gone]] names nothing',
  '- [[guide]] and [[missing#Setup]]',
  '',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-anchors-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write('guide.md', GUIDE);
  write('links.md', LINKS);
  write('.noto/brain.yaml', 'kinds: {}\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('links into a place in a note', () => {
  it('counts the one whose heading is not there, apart from the broken one', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const status = vault.status();
      expect(status.broken).toBe(1);
      expect(status.brokenAnchors).toBe(1);
      const info = about(vault, 'links.md');
      expect(info.outgoing.brokenAnchors).toEqual([{ target: 'guide', anchor: '#Gone', line: 6 }]);
      expect(info.outgoing.brokenAnchorCount).toBe(1);
      expect(folderAbout(vault, '').brokenAnchors).toBe(1);
    } finally {
      vault.close();
    }
  });

  it('follows a heading renamed in the note linked into, and renamed back', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      write('guide.md', GUIDE.replace('## Setup', '## Install'));
      vault.refresh({ paths: ['guide.md'] });
      expect(about(vault, 'links.md').outgoing.brokenAnchors.map((link) => link.anchor)).toEqual(['#Setup', '#Gone']);
      write('guide.md', GUIDE);
      vault.refresh({ paths: ['guide.md'] });
      expect(about(vault, 'links.md').outgoing.brokenAnchors.map((link) => link.anchor)).toEqual(['#Gone']);
    } finally {
      vault.close();
    }
  });
});
