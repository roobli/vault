import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyHash, loadAccess } from '../src/access.js';
import { addAgent, agentList, folderSensitivity, PolicyEditError, revokeAgent, setFolderSensitivity } from '../src/policy.js';

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
    expect(folderSensitivity(root, 'Work/Public')).toEqual({ level: 'open', own: true });
    expect(folderSensitivity(root, 'Work/Deep')).toEqual({ level: 'private', own: false });
    expect(folderSensitivity(root, 'Elsewhere')).toEqual({ level: 'open', own: false });
  });
});

/**
 * Files written their own way. Each edit must leave every other part of the
 * policy meaning what it meant, or refuse and leave the file alone; these
 * are the shapes an earlier line editor broke.
 */
describe('a policy written its own way', () => {
  const bot = 'bot-key-0123456789';
  const write = (lines: string[]) => writeFileSync(policyFile(), lines.join('\n'));
  const unchanged = (before: string, act: () => unknown) => {
    expect(act).toThrow(PolicyEditError);
    expect(policy()).toBe(before);
  };

  it('keeps a list written at its key\'s column, and every agent after it', () => {
    write([
      'sensitivity:',
      '  default: open',
      '  sealed:',
      '  - Diary/',
      'principals:',
      '  bot:',
      `    keys: [${keyHash(bot)}]`,
      '',
    ]);
    setFolderSensitivity(root, 'Work', 'private');
    const access = loadAccess(root);
    expect(access.sensitivityOf('Work/a.md')).toBe('private');
    expect(access.sensitivityOf('Diary/a.md')).toBe('sealed');
    expect(access.principalFor(bot).name).toBe('bot');
  });

  it('keeps an agent without a key turned off when a folder is made private', () => {
    write([
      'sensitivity:',
      '  private:',
      '  - Work/',
      'principals:',
      '  default:',
      '    read: []',
      '    verbs: []',
      '',
    ]);
    setFolderSensitivity(root, 'Ideas', 'private');
    const access = loadAccess(root);
    expect(access.principalFor(undefined).canSee('Notes/a.md', 'open')).toBe(false);
    expect(access.sensitivityOf('Work/a.md')).toBe('private');
    expect(access.sensitivityOf('Ideas/a.md')).toBe('private');
  });

  it('writes in the file\'s own indent, whichever section comes first', () => {
    write([
      'principals:',
      '    bot:',
      `        keys: [${keyHash(bot)}]`,
      'sensitivity:',
      '    sealed: ["Diary/"]',
      '',
    ]);
    const { key } = addAgent(root, { name: 'codex', reads: 'open', may: 'read' });
    setFolderSensitivity(root, 'Work', 'private');
    const access = loadAccess(root);
    expect(access.principalFor(key).name).toBe('codex');
    expect(access.principalFor(bot).name).toBe('bot');
    expect(access.sensitivityOf('Diary/a.md')).toBe('sealed');
    expect(access.sensitivityOf('Work/a.md')).toBe('private');
    expect(policy()).toContain('\n    codex:\n        keys: [');
  });

  it('writes out a map given on one line before changing it', () => {
    write([
      'sensitivity: { default: open, sealed: [Diary/] }  # short',
      'principals: { default: { read: ["**"], verbs: [read] }, bot: { keys: [' + keyHash(bot) + '] } }',
      '',
    ]);
    setFolderSensitivity(root, 'Work', 'private');
    expect(revokeAgent(root, 'default')).toBe(true);
    expect(revokeAgent(root, 'bot')).toBe(true);
    const access = loadAccess(root);
    expect(access.sensitivityOf('Work/a.md')).toBe('private');
    expect(access.sensitivityOf('Diary/a.md')).toBe('sealed');
    expect(access.principalFor(undefined).canSee('Notes/a.md', 'open')).toBe(false);
    expect(() => access.principalFor(bot)).toThrow(/names no principal/);
    expect(policy()).toContain('# short');
  });

  it('takes back keys written as a list run over lines or at their key\'s column, and leaves the agents after them', () => {
    const other = 'other-key-0123456789';
    write([
      'principals:',
      '  bot:',
      '    keys: [',
      `      ${keyHash(bot)},`,
      '      ]',
      '  second:',
      '    keys:',
      `    - ${keyHash('second-key-0123456789')}`,
      '  other:',
      `    keys: [${keyHash(other)}]`,
      '',
    ]);
    expect(revokeAgent(root, 'bot')).toBe(true);
    expect(revokeAgent(root, 'second')).toBe(true);
    revokeAgent(root, 'default');
    const access = loadAccess(root);
    expect(() => access.principalFor(bot)).toThrow(/names no principal/);
    expect(() => access.principalFor('second-key-0123456789')).toThrow(/names no principal/);
    expect(access.principalFor(other).name).toBe('other');
    expect(access.principalFor(undefined).canSee('a.md', 'open')).toBe(false);
  });

  it('refuses what it cannot change safely, and leaves the file as it was', () => {
    write([
      'principals:',
      '  bot:',
      `    keys: [${keyHash(bot)}]`,
      '  bot:',
      '    keys: []',
      '',
    ]);
    const twice = policy();
    unchanged(twice, () => revokeAgent(root, 'bot'));
    write(['principals:', '  - bot', '']);
    unchanged(policy(), () => addAgent(root, { name: 'codex', reads: 'open', may: 'read' }));
  });

  it('refuses a folder whose name a pattern cannot say, and a write-in folder that is a wildcard', () => {
    const before = policy();
    unchanged(before, () => setFolderSensitivity(root, 'Secrets?', 'sealed'));
    unchanged(before, () => setFolderSensitivity(root, 'a*b', 'sealed'));
    unchanged(before, () => addAgent(root, { name: 'w', reads: 'open', may: 'write', writeIn: '**' }));
    unchanged(before, () => addAgent(root, { name: 'w', reads: 'open', may: 'write', writeIn: 'Daily\nsealed: []' }));
    unchanged(before, () => addAgent(root, { name: '__proto__', reads: 'open', may: 'read' }));
  });

  it('will not write through a link, and keeps the file\'s line endings', () => {
    const elsewhere = path.join(root, 'elsewhere.txt');
    writeFileSync(elsewhere, 'echo hello\n');
    rmSync(policyFile());
    symlinkSync(elsewhere, policyFile());
    expect(() => setFolderSensitivity(root, 'Work', 'sealed')).toThrow(/link/);
    expect(readFileSync(elsewhere, 'utf8')).toBe('echo hello\n');
    rmSync(policyFile());
    writeFileSync(policyFile(), 'sensitivity:\r\n  default: open\r\nprincipals:\r\n');
    addAgent(root, { name: 'codex', reads: 'open', may: 'read' });
    expect(policy().split('\n').every((line) => line === '' || line.endsWith('\r'))).toBe(true);
  });
});
