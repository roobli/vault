import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyHash } from '../src/access.js';
import { serve } from '../src/mcp.js';
import { AccessError, Vault } from '../src/vault.js';
import { parseYamlMap } from '../src/yaml.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const policy = (keys: string) => [
  'sensitivity:',
  '  sealed: ["Priv/"]',
  'principals:',
  '  agent:',
  `    keys: [${keys}]`,
  '    max_sensitivity: private',
  '    write: ["Pub/**", "Priv/**"]',
  '    append: ["Priv/**"]',
  '    verbs: [read, search, recall, append, propose, write]',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-safety-'));
  git('init', '-q', '-b', 'main');
  write('Priv/secret.md', '# Secret\n\nTOPSECRET body\n');
  write('Pub/old.md', '# Old\n\nA note about moving things around the vault, long enough to be seen as a rename.\n');
  write('Pub/user.md', '# User\n\nSee [[holt]] for the project.\n');
  write('Pub/card.md', '---\nid: other\n---\n# Card\n');
  write('.trash/s.md', '# In the trash\n\nhidden\n');
  write('.noto/access.yaml', policy(keyHash('k')));
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('what an agent cannot reach', () => {
  it('cannot propose over a sealed note by another spelling, or over a file the index leaves out', async () => {
    const agent = await Vault.open(root, { key: 'k' });
    try {
      expect(() => agent.propose([{ path: 'priv/secret.md', content: 'x' }], 'sneak')).toThrow(AccessError);
      expect(() => agent.propose([{ path: 'Priv/secret.md', content: 'x' }], 'direct')).toThrow(AccessError);
      expect(() => agent.propose([{ path: '.trash/s.md', content: 'x' }], 'dot')).toThrow(AccessError);
      expect(() => agent.propose([{ path: 'Priv/new.md', content: 'x' }], 'new in sealed')).toThrow(AccessError);
      expect(agent.proposals()).toEqual([]);
    } finally {
      agent.close();
    }
  });

  it('cannot write, append to or learn the hash of a note it cannot see, even inside its write scope', async () => {
    const agent = await Vault.open(root, { key: 'k' });
    try {
      expect(() => agent.write('Priv/secret.md', 'x', null)).toThrow(AccessError);
      expect(() => agent.append('more', { to: 'Priv/secret.md' })).toThrow(AccessError);
      expect(readFileSync(path.join(root, 'Priv/secret.md'), 'utf8')).toContain('TOPSECRET');
    } finally {
      agent.close();
    }
  });

  it('sees only its own proposals, and not the owner\'s', async () => {
    const owner = await Vault.open(root, { owner: true });
    const { id } = owner.propose([{ path: 'Priv/secret.md', content: '# Secret\n\nchanged\n' }], 'owner change');
    owner.close();
    const agent = await Vault.open(root, { key: 'k' });
    try {
      expect(agent.proposals()).toEqual([]);
      expect(() => agent.proposalDiff(id)).toThrow(AccessError);
      expect(() => agent.proposalFile(id, 'Priv/secret.md')).toThrow(/no proposal/);
      const mine = agent.propose([{ path: 'Pub/user.md', content: '# User\n\nedited\n' }], 'agent change');
      expect(agent.proposals().map((proposal) => proposal.id)).toEqual([mine.id]);
      expect(agent.proposalFile(mine.id, 'Pub/user.md').proposed).toBe('# User\n\nedited\n');
    } finally {
      agent.close();
    }
  });
});

describe('proposals that move notes', () => {
  it('apply both halves of a move: the new note appears and the old one goes', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      const text = readFileSync(path.join(root, 'Pub/old.md'), 'utf8');
      const { id } = owner.propose([{ path: 'Pub/old.md', content: null }, { path: 'Pub/new.md', content: text }], 'move it');
      expect(owner.proposalDiff(id)).toContain('deleted file mode');
      // Each file at both ends, for showing side by side; null where there is none.
      expect(owner.proposalFile(id, 'Pub/old.md')).toEqual({ base: text, proposed: null });
      expect(owner.proposalFile(id, 'Pub/new.md')).toEqual({ base: null, proposed: text });
      expect(() => owner.proposalFile(id, 'Pub/user.md')).toThrow(/does not change/);
      const result = owner.accept(id);
      expect([...result.applied].sort()).toEqual(['Pub/new.md', 'Pub/old.md']);
      expect(existsSync(path.join(root, 'Pub/old.md'))).toBe(false);
      expect(existsSync(path.join(root, 'Pub/new.md'))).toBe(true);
    } finally {
      owner.close();
    }
  });
});

describe('notes that are not well formed', () => {
  it('reads broken frontmatter without looping or swallowing the keys after it', () => {
    const broken = parseYamlMap('tags: [a}]\nstatus: done');
    expect(broken.tags).toContain('a');
    expect(broken.status).toBe('done');
    expect(parseYamlMap('x: {k: v]\ny: 1').y).toBe(1);
    expect(parseYamlMap('title: "Plan\nsensitivity: sealed')).toEqual({ title: 'Plan', sensitivity: 'sealed' });
  });

  it('indexes a note whose frontmatter is broken, and keeps the rest of the vault', async () => {
    write('Pub/broken.md', '---\ntags: [a}]\n---\n# Broken\n\nstill searchable\n');
    const owner = await Vault.open(root, { owner: true });
    try {
      expect(owner.search('searchable')[0]!.path).toBe('Pub/broken.md');
    } finally {
      owner.close();
    }
  });

  it('re-resolves other notes\' links when a card takes on a new name', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      expect(owner.read('Pub/user.md').links[0]!.resolved).toBeNull();
      write('Pub/card.md', '---\nid: other\naliases: [holt]\n---\n# Card\n');
      expect(owner.refresh().relinked).toBe('all');
      expect(owner.read('Pub/user.md').links[0]!.resolved).toBe('Pub/card.md');
    } finally {
      owner.close();
    }
  });
});

describe('the MCP server', () => {
  it('answers a line that is not a request object, and stops serving a key that was revoked', async () => {
    const vault = await Vault.open(root, { key: 'k' });
    const input = new PassThrough();
    const output = new PassThrough();
    let buffer = '';
    output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
    const done = serve(vault, { input, output, reopen: () => Vault.open(root, { key: 'k' }) });
    const send = (message: unknown) => input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    send('null');
    send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search', arguments: { query: 'moving' } } });
    await new Promise((resolve) => setTimeout(resolve, 200));
    write('.noto/access.yaml', policy(keyHash('another')));
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search', arguments: { query: 'moving' } } });
    input.end();
    await done;
    vault.close();
    const answers = buffer.split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, any>);
    expect(answers[0]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(answers.find((answer) => answer.id === 1)!.result.isError).toBe(false);
    const revoked = answers.find((answer) => answer.id === 2)!;
    expect(revoked.result.isError).toBe(true);
    expect(revoked.result.content[0].text).toMatch(/no longer serve/);
  });
});
