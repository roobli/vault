import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyHash } from '../src/access.js';
import { run } from '../src/cli.js';
import { recordEvents } from '../src/events.js';
import { dismiss, suggest } from '../src/suggest.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
/** Every event line, as written. */
const raw = (): string[] => {
  const dir = path.join(root, '.noto', 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((host) => readdirSync(path.join(dir, host)).flatMap((file) =>
    readFileSync(path.join(dir, host, file), 'utf8').split('\n').filter(Boolean)));
};
const lines = () => raw().map((line) => JSON.parse(line) as Record<string, unknown>);
const quiet = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-outcomes-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write('a.md', '# Alpha\n\nArgus audits the indexes.\n');
  write('b.md', '# Beta\n\nBeta names Alpha without a link.\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'first'], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'cd', GIT_AUTHOR_EMAIL: 'cd@example.com', GIT_COMMITTER_NAME: 'cd', GIT_COMMITTER_EMAIL: 'cd@example.com' },
  });
  write('.noto/access.yaml', `principals:\n  agent:\n    keys: [${keyHash('k')}]\n    verbs: [read, search, recall, propose]\n`);
  vi.stubEnv('CLAUDECODE', '');
  vi.stubEnv('CODEX_THREAD_ID', '');
  vi.stubEnv('NOTO_SESSION', '');
  vi.stubEnv('NOTO_ACTOR', '');
  vi.stubEnv('NOTO_VAULT_KEY', '');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('what becomes of a proposal', () => {
  it('names the proposal on its propose, accept and reject lines, with its author and the review the person gives', async () => {
    const agent = await Vault.open(root, { key: 'k' });
    const owner = await Vault.open(root, { owner: true });
    try {
      const first = agent.propose([{ path: 'a.md', content: '# Alpha\n\nArgus audits every index.\n' }], 'Say every index');
      const second = owner.propose([{ path: 'b.md', content: '# Beta\n\nBeta names [[a|Alpha]].\n' }], 'Link Alpha');
      owner.accept(first.id, { reason: '  right  ', reviewMs: 4200.4 });
      owner.reject(second.id);
      const [made, mine, accepted, rejected] = lines();
      expect(made).toMatchObject({ actor: 'agent', verb: 'propose', path: 'a.md', proposal: first.id });
      expect(mine).toMatchObject({ actor: 'owner', verb: 'propose', path: 'b.md', proposal: second.id });
      expect(accepted).toMatchObject({ actor: 'owner', verb: 'accept', path: 'a.md', proposal: first.id, author: 'agent', reason: 'right', reviewMs: 4200 });
      expect(rejected).toMatchObject({ actor: 'owner', verb: 'reject', path: 'b.md', proposal: second.id, author: 'owner' });
      expect(rejected).not.toHaveProperty('reason');
      expect(rejected).not.toHaveProperty('reviewMs');
      // The line keeps the shape every event has, the new fields after it.
      expect(Object.keys(accepted!)).toEqual(['time', 'actor', 'verb', 'path', 'session', 'proposal', 'author', 'reason', 'reviewMs']);
    } finally {
      agent.close();
      owner.close();
    }
  });

  it('names the proposal when an accept stops on a conflict, and leaves the decision for later', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      const { id } = owner.propose([{ path: 'a.md', content: '# Alpha\n\nArgus audits one index.\n' }], 'One index');
      write('a.md', '# Alpha\n\nArgus audits two indexes.\n');
      expect(owner.accept(id, { reason: 'ok' }).conflicts).toEqual(['a.md']);
      const stalled = lines().at(-1)!;
      expect(stalled).toMatchObject({ verb: 'propose', path: 'a.md', proposal: id });
      expect(stalled).not.toHaveProperty('reason');
    } finally {
      owner.close();
    }
  });

  it('refuses a review time that is not one before changing anything', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      const { id } = owner.propose([{ path: 'a.md', content: '# Alpha\n\nChanged.\n' }], 'Change');
      expect(() => owner.reject(id, { reviewMs: -1 })).toThrow(/milliseconds/);
      expect(() => owner.accept(id, { reviewMs: Number.NaN })).toThrow(/milliseconds/);
      expect(owner.proposals().map((item) => item.id)).toEqual([id]);
      expect(readFileSync(path.join(root, 'a.md'), 'utf8')).toBe('# Alpha\n\nArgus audits the indexes.\n');
    } finally {
      owner.close();
    }
  });

  it('takes --reason and --review-ms from the command line', async () => {
    quiet();
    const owner = await Vault.open(root, { owner: true });
    const { id } = owner.propose([{ path: 'a.md', content: '# Alpha\n\nChanged.\n' }], 'Change');
    owner.close();
    process.exitCode = undefined;
    await run(['--root', root, 'proposals', 'reject', id, '--review-ms', 'soon']);
    expect(process.exitCode).toBe(2);
    await run(['--root', root, 'proposals', 'reject', id, '--reason', 'duplicate', '--review-ms', '1500']);
    expect(process.exitCode).toBe(0);
    expect(lines().at(-1)).toMatchObject({ actor: 'owner', verb: 'reject', proposal: id, author: 'owner', reason: 'duplicate', reviewMs: 1500 });
  });

  it('keeps two proposals decided in one moment on lines of their own', () => {
    recordEvents(root, [
      { time: '2026-11-06T10:00:00.000Z', actor: 'owner', verb: 'accept', path: 'a.md', proposal: 'p1', author: 'agent' },
      { time: '2026-11-06T10:00:00.000Z', actor: 'owner', verb: 'accept', path: 'b.md', proposal: 'p2', author: 'agent' },
      { time: '2026-11-06T10:00:00.000Z', actor: 'owner', verb: 'open', path: 'a.md', session: 's' },
    ], 'h');
    expect(raw()).toEqual([
      '{"time":"2026-11-06T10:00:00.000Z","actor":"owner","verb":"accept","path":"a.md","proposal":"p1","author":"agent"}',
      '{"time":"2026-11-06T10:00:00.000Z","actor":"owner","verb":"accept","path":"b.md","proposal":"p2","author":"agent"}',
      '{"time":"2026-11-06T10:00:00.000Z","actor":"owner","verb":"open","path":"a.md","session":"s"}',
    ]);
  });
});

describe('what becomes of a suggestion', () => {
  const dismissed = () => readFileSync(path.join(root, '.noto/dismissed.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>);
  beforeEach(() => {
    write('Design/目标设计说明.md', '# 目标设计说明\n\n怎么做。\n');
    write('Design/学习方案.md', '# 学习方案\n\n一份计划。\n');
    write('Design/notes.md', '# Notes\n\n先读目标设计说明，再看学习方案。\n');
  });

  it('keeps the reason and the review time on the dismissed line', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      const found = suggest(owner, { types: ['mention'] });
      expect(found.length).toBe(2);
      expect(dismiss(owner, found.slice(0, 1), { reason: 'noise', reviewMs: 800 })).toBe(1);
      // A dismissal with nothing said is the line it always was.
      expect(dismiss(owner, found.slice(1, 2))).toBe(1);
      const [said, plain] = dismissed();
      expect(said).toMatchObject({ type: 'mention', from: found[0]!.from, to: found[0]!.to, reason: 'noise', reviewMs: 800 });
      expect(Object.keys(plain!)).toEqual(['type', 'from', 'to', 'time']);
    } finally {
      owner.close();
    }
  });

  it('takes --reason and --review-ms with suggest --dismiss', async () => {
    quiet();
    const owner = await Vault.open(root, { owner: true });
    const [first] = suggest(owner, { types: ['mention'] });
    owner.close();
    process.exitCode = undefined;
    await run(['--root', root, 'suggest', '--dismiss', first!.id, '--reason', 'not a name here', '--review-ms', '2500']);
    expect(process.exitCode).toBe(0);
    expect(dismissed()).toEqual([expect.objectContaining({ from: first!.from, to: first!.to, reason: 'not a name here', reviewMs: 2500 })]);
  });
});
