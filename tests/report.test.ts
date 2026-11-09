import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyHash } from '../src/access.js';
import { run } from '../src/cli.js';
import { recordEvalRun, type EvalRun } from '../src/eval.js';
import { recordEvents, type VaultEvent } from '../src/events.js';
import { createProposal, findRepo } from '../src/git.js';
import { isoWeek, reportTarget, weekRange, weeklyReport } from '../src/report.js';
import { AccessError, Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
/** A moment in 2026-W45 (Monday 2 November to Sunday 8 November), or around it. */
const at = (day: string, hour = 10) => `2026-11-${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const event = (time: string, actor: string, verb: VaultEvent['verb'], rel: string, extra: Partial<VaultEvent> = {}): VaultEvent => ({ time, actor, verb, path: rel, ...extra });
const evalRun = (time: string, file: string, hitAtK: number, mrr: number, firstHit: number): EvalRun =>
  ({ time, actor: 'owner', file, mode: 'recall', queries: 4, k: 5, hitAtK, mrr, firstHit, schema: 4, config: 'c0ffee00', version: '0.1.0' });
let output: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-report-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write('Projects/index.md', '---\nmoc: true\nid: argus\n---\n# Argus\n\nSee [[Plan]] and [[Missing note]].\n');
  write('Plan.md', '# Plan\n\nThe plan, for [[Argus]]. Also [gone](Nowhere/gone.md).\n');
  write('Decisions/choice.md', '---\nkind: decision\n---\n# Choice\n\nWe chose. See [[Plan]].\n');
  write('Alone.md', '# Alone\n\nNothing links here, and this links nowhere.\n');
  write('Logs/2026-11-03 day.md', '# Day\n\nA day alone, as logs are.\n');
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'first'], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 'cd', GIT_AUTHOR_EMAIL: 'cd@example.com', GIT_COMMITTER_NAME: 'cd', GIT_COMMITTER_EMAIL: 'cd@example.com' },
  });
  write('.noto/access.yaml', `principals:\n  agent:\n    keys: [${keyHash('k')}]\n    verbs: [read, search, recall, propose]\n`);
  recordEvents(root, [
    event('2026-10-28T10:00:00.000Z', 'agent', 'propose', 'Plan.md', { proposal: 'p1' }),
    event(at('02'), 'owner', 'accept', 'Plan.md', { proposal: 'p1', author: 'agent', reason: 'right', reviewMs: 3000 }),
    event(at('03'), 'agent', 'propose', 'Alone.md', { proposal: 'p2' }),
    event(at('03', 11), 'owner', 'reject', 'Alone.md', { proposal: 'p2', author: 'agent', reviewMs: 1000 }),
    event(at('04'), 'agent', 'propose', 'Plan.md', { proposal: 'p3' }),
    // An accept of p3 that stopped on a conflict: not a proposal made.
    event(at('04', 12), 'owner', 'propose', 'Plan.md', { proposal: 'p3' }),
    event(at('05'), 'codex', 'propose', 'Plan.md', { proposal: 'p4' }),
    event(at('10'), 'owner', 'accept', 'Plan.md', { proposal: 'p4', author: 'codex' }),
    // An accept recorded before lines named their proposal.
    event(at('06'), 'owner', 'accept', 'Alone.md'),
    event(at('02', 9), 'owner', 'open', 'Plan.md', { session: 's1' }),
    event(at('02', 9), 'owner', 'open', 'Alone.md', { session: 's2' }),
    event(at('03', 9), 'agent', 'read', 'Plan.md'),
    event(at('07', 9), 'claude-code', 'recall', 'Plan.md', { query: 'plan' }),
    event(at('07', 9), 'claude-code', 'recall', 'Alone.md', { query: 'plan' }),
    event('2026-10-30T09:00:00.000Z', 'owner', 'open', 'Plan.md'),
  ], 'h');
  recordEvalRun(root, evalRun('2026-10-30T09:00:00.000Z', 'eval/cases.yaml', 0.5, 0.5, 0.25), 'h');
  recordEvalRun(root, evalRun(at('04'), 'eval/cases.yaml', 0.75, 0.6, 0.5), 'h');
  recordEvalRun(root, evalRun(at('05'), 'eval/other.yaml', 1, 1, 1), 'h');
  // A proposal still open whose propose line is not in the logs: it counts by its ref.
  const repo = findRepo(root)!;
  createProposal(repo, root, [{ path: 'Alone.md', content: '# Alone\n\nNow linked to [[Plan]].\n' }], 'Link Alone', { name: 'claude-code', email: 'cc@noto.local' }, new Date(at('06')));
  output = [];
  vi.spyOn(console, 'log').mockImplementation((text: unknown) => { output.push(String(text)); });
  vi.spyOn(console, 'error').mockImplementation((text: unknown) => { output.push(String(text)); });
  vi.stubEnv('CLAUDECODE', '');
  vi.stubEnv('CODEX_THREAD_ID', '');
  vi.stubEnv('NOTO_ACTOR', '');
  vi.stubEnv('NOTO_VAULT_KEY', '');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('weeks', () => {
  it('reads and names ISO weeks in UTC', () => {
    expect(isoWeek(new Date('2026-11-02T00:00:00Z'))).toBe('2026-W45');
    expect(isoWeek(new Date('2026-11-08T23:59:59Z'))).toBe('2026-W45');
    expect(isoWeek(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W53');
    expect(weekRange('2026-W45')).toEqual({ start: Date.parse('2026-11-02T00:00:00Z'), end: Date.parse('2026-11-09T00:00:00Z') });
    expect(weekRange('2026-W53')).not.toBeNull();
    expect(weekRange('2025-W53')).toBeNull();
    expect(weekRange('2026-W00')).toBeNull();
    expect(weekRange('2026-45')).toBeNull();
  });
});

describe('the weekly report', () => {
  it('says what the vault holds and what happened in the week, the same each time', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const text = weeklyReport(vault, { week: '2026-W45' });
      expect(weeklyReport(vault, { week: '2026-W45' })).toBe(text);
      expect(text).toContain('# Vault report, 2026-W45');
      expect(text).toContain('2026-11-02 to 2026-11-08 (UTC)');
      expect(text).toContain('| decision | 1 |\n| card | 1 |\n| note | 2 |\n| log | 1 |\n| all | 5 |');
      expect(text).toContain('2 in all:');
      expect(text).toContain('| `Plan.md` | 3 | `Nowhere/gone.md` |');
      expect(text).toContain('| `Projects/index.md` | 7 | `Missing note` |');
      expect(text).toContain('Notes that link nowhere and that nothing links to, logs aside: 1 in all.');
      expect(text).toContain('| `Alone.md` | note |');
      expect(text).not.toContain('| `Logs/2026-11-03 day.md` |');
      expect(text).toContain('| made by | made | accepted | rejected | pending | accept rate | median review |');
      expect(text).toContain('| agent | 2 | 1 | 1 | 1 | 50% | 2.0 s |');
      expect(text).toContain('| claude-code | 0 | 0 | 0 | 1 |  |  |');
      expect(text).toContain('| codex | 1 | 0 | 0 | 1 |  |  |');
      expect(text).toContain('| unknown | 0 | 1 | 0 | 0 | 100% |  |');
      expect(text).toContain('| all | 3 | 2 | 1 | 3 | 67% | 2.0 s |');
      expect(text).toContain('counted by the author git keeps on the proposal');
      expect(text).toContain('| 2026-10-30 09:00 (before) | `eval/cases.yaml` | 5 | 4 | 50% | 0.50 | 25% | c0ffee00 |');
      expect(text).toContain('| 2026-11-04 10:00 | `eval/cases.yaml` | 5 | 4 | 75% (+25) | 0.60 (+0.10) | 50% (+25) | c0ffee00 |');
      expect(text).toContain('| 2026-11-05 10:00 | `eval/other.yaml` | 5 | 4 | 100% | 1.00 | 100% | c0ffee00 |');
      expect(text).toContain('| reader | opened | read | recalled | cited | all |\n| --- | --- | --- | --- | --- | --- |\n| owner | 2 | 0 | 0 | 0 | 2 |\n| agent | 0 | 1 | 0 | 0 | 1 |\n| claude-code | 0 | 0 | 2 | 0 | 2 |');
      // Plain Markdown: no HTML.
      expect(text).not.toMatch(/<[a-z][^>]*>/i);
    } finally {
      vault.close();
    }
  });

  it('says so when a week saw nothing', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const text = weeklyReport(vault, { week: '2026-W40' });
      expect(text).toContain('None were made, decided or pending this week.');
      expect(text).toContain('No eval was run this week.');
      expect(text).toContain('Nobody read the vault this week.');
    } finally {
      vault.close();
    }
  });

  it('is the owner\'s alone', async () => {
    const agent = await Vault.open(root, { key: 'k' });
    try {
      expect(() => weeklyReport(agent, { week: '2026-W45' })).toThrow(AccessError);
    } finally {
      agent.close();
    }
  });

  it('writes only a .md file inside .noto, and prints otherwise', async () => {
    expect(() => reportTarget(root, path.join(root, 'report.md'))).toThrow(/\.noto\/reports/);
    expect(() => reportTarget(root, path.join(os.tmpdir(), 'report.md'))).toThrow(/inside the vault's \.noto/);
    expect(() => reportTarget(root, path.join(root, '.noto', 'brain.yaml'))).toThrow(/\.md file/);
    process.exitCode = undefined;
    await run(['--root', root, 'report', '--week', '2026-W45', '--out', path.join(root, 'Reports', 'w45.md')]);
    expect(process.exitCode).toBe(2);
    expect(existsSync(path.join(root, 'Reports'))).toBe(false);
    await run(['--root', root, 'report', '--week', '2026-W99']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await run(['--root', root, 'report', '--week', '2026-W45']);
    const printed = write.mock.calls.map((call) => String(call[0])).join('');
    write.mockRestore();
    expect(printed).toContain('# Vault report, 2026-W45');

    const out = path.join(root, '.noto', 'reports', '2026-W45.md');
    await run(['--root', root, 'report', '--week', '2026-W45', '--out', out]);
    expect(process.exitCode).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(printed);
  });

  it('refuses a link on the way even when what it points to is not there yet', () => {
    const outside = mkdtempSync(path.join(os.tmpdir(), 'vault-report-outside-'));
    try {
      mkdirSync(path.join(root, '.noto', 'reports'), { recursive: true });
      symlinkSync(path.join(outside, 'leak.md'), path.join(root, '.noto', 'reports', 'w45.md'));
      expect(() => reportTarget(root, path.join(root, '.noto', 'reports', 'w45.md'))).toThrow(/is a link/);
      symlinkSync(path.join(outside, 'gone'), path.join(root, '.noto', 'elsewhere'));
      expect(() => reportTarget(root, path.join(root, '.noto', 'elsewhere', 'w45.md'))).toThrow(/is a link/);
      expect(existsSync(path.join(outside, 'leak.md'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('refuses a folder in the place of the file, and reads a relative path from the vault', () => {
    mkdirSync(path.join(root, '.noto', 'reports', 'taken.md'), { recursive: true });
    expect(() => reportTarget(root, path.join(root, '.noto', 'reports', 'taken.md'))).toThrow(/not a file/);
    const relative = reportTarget(root, path.join('.noto', 'reports', 'w46.md'));
    expect(relative.endsWith(path.join('.noto', 'reports', 'w46.md'))).toBe(true);
  });

  it('takes the path it suggests when the vault is reached through a link', () => {
    const via = path.join(mkdtempSync(path.join(os.tmpdir(), 'vault-report-via-')), 'vault');
    try {
      symlinkSync(root, via);
      expect(() => reportTarget(via, path.join(via, '.noto', 'reports', 'w45.md'))).not.toThrow();
    } finally {
      rmSync(path.dirname(via), { recursive: true, force: true });
    }
  });
});
