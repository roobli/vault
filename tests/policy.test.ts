import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAccess } from '../src/access.js';
import { addAgent, agentList, revokeAgent, setFolderSensitivity } from '../src/policy.js';

let root: string;
const policyFile = () => path.join(root, '.noto', 'access.yaml');
const policy = () => readFileSync(policyFile(), 'utf8');

const HAND_WRITTEN = [
  '# Kept by hand: who may read what.',
  'sensitivity:',
  '  default: open',
  '  # Work is nobody else\'s business.',
  '  private: ["Work/"]',
  '  sealed:',
  '    - Diary/',
  '',
  'principals:',
  '  # The one I trust most.',
  '  claude-code:',
  '    keys: [aaaa]',
  '    read: ["**"]',
  '    max_sensitivity: private',
  '',
  '# The end.',
  '',
].join('\n');

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-policy-'));
  mkdirSync(path.join(root, '.noto'));
  writeFileSync(policyFile(), HAND_WRITTEN);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('adding an agent', () => {
  it('gives it a key that opens exactly what was asked, and keeps every comment', () => {
    const { key } = addAgent(root, { name: 'codex', reads: 'open', may: 'write', writeIn: 'Daily' });
    const access = loadAccess(root);
    const codex = access.principalFor(key);
    expect(codex.name).toBe('codex');
    expect(codex.maxSensitivity).toBe('open');
    expect(codex.canWrite('Daily/2026-11-05.md')).toBe(true);
    expect(codex.canWrite('Ideas/x.md')).toBe(false);
    expect([...codex.verbs].sort()).toEqual(['append', 'propose', 'read', 'recall', 'search', 'write']);
    // Only the hash is kept.
    expect(policy()).not.toContain(key);
    for (const comment of ['# Kept by hand', '# Work is nobody', '# The one I trust most.', '# The end.']) expect(policy()).toContain(comment);
    expect(access.principal('claude-code')?.maxSensitivity).toBe('private');
  });

  it('refuses a name that is taken or not a name, and a folder that leaves the vault', () => {
    expect(() => addAgent(root, { name: 'claude-code', reads: 'open', may: 'read' })).toThrow(/already/);
    expect(() => addAgent(root, { name: 'two words', reads: 'open', may: 'read' })).toThrow(/letters/);
    expect(() => addAgent(root, { name: 'default', reads: 'open', may: 'read' })).toThrow(/not "owner" or "default"/);
    expect(() => addAgent(root, { name: 'w', reads: 'open', may: 'write', writeIn: '../elsewhere' })).toThrow(/not a folder/);
    expect(() => addAgent(root, { name: 'w', reads: 'open', may: 'write', writeIn: '.noto' })).toThrow(/not a folder/);
  });

  it('makes the file when there is none, and fills `principals: {}`', () => {
    rmSync(policyFile());
    const first = addAgent(root, { name: 'one', reads: 'private', may: 'propose' });
    expect(loadAccess(root).principalFor(first.key).verbs.has('propose')).toBe(true);
    writeFileSync(policyFile(), 'sensitivity:\n  default: open\n\nprincipals: {}\n');
    const second = addAgent(root, { name: 'two', reads: 'open', may: 'read' });
    expect(loadAccess(root).principalFor(second.key).name).toBe('two');
    expect(policy().match(/^principals:/gm)).toHaveLength(1);
  });
});

describe('taking a key back', () => {
  it('shuts the key at once, keeps what the agent was allowed, and says when', () => {
    const { key } = addAgent(root, { name: 'codex', reads: 'open', may: 'read' });
    expect(revokeAgent(root, 'codex', new Date('2026-11-05T12:00:00Z'))).toBe(true);
    expect(() => loadAccess(root).principalFor(key)).toThrow(/names no principal/);
    const codex = agentList(root).find((agent) => agent.name === 'codex')!;
    expect(codex).toMatchObject({ keys: 0, revoked: '2026-11-05T12:00:00.000Z', reads: 'open' });
    // Under the same name it can be added again, with a fresh key.
    const again = addAgent(root, { name: 'codex', reads: 'private', may: 'read' });
    expect(loadAccess(root).principalFor(again.key).maxSensitivity).toBe('private');
    expect(agentList(root).find((agent) => agent.name === 'codex')!.revoked).toBeNull();
    expect(revokeAgent(root, 'nobody')).toBe(false);
  });

  it('gives an agent without a key nothing to read, when that is what is asked', () => {
    expect(agentList(root).find((agent) => agent.name === 'default')).toMatchObject({ implicit: true, reads: 'open' });
    expect(loadAccess(root).principalFor(undefined).canSee('Ideas/x.md', 'open')).toBe(true);
    revokeAgent(root, 'default');
    expect(loadAccess(root).principalFor(undefined).canSee('Ideas/x.md', 'open')).toBe(false);
    expect(agentList(root).find((agent) => agent.name === 'default')).toMatchObject({ implicit: false });
  });
});

describe('how private a folder is', () => {
  it('puts the folder in the list asked for, and out of the others', () => {
    setFolderSensitivity(root, 'Ideas', 'private');
    expect(loadAccess(root).sensitivityOf('Ideas/x.md')).toBe('private');
    setFolderSensitivity(root, 'Diary', 'open');
    expect(loadAccess(root).sensitivityOf('Diary/today.md')).toBe('open');
    // The default makes it open already: no pattern is left behind for it.
    expect(policy()).not.toContain('Diary/');
    setFolderSensitivity(root, 'Work/Public', 'open');
    // Inside a private folder, open needs a pattern of its own, and the longest wins.
    expect(loadAccess(root).sensitivityOf('Work/Public/a.md')).toBe('open');
    expect(loadAccess(root).sensitivityOf('Work/b.md')).toBe('private');
    expect(policy()).toContain('# Work is nobody');
    expect(() => setFolderSensitivity(root, '../x', 'sealed')).toThrow(/not a folder/);
  });
});
