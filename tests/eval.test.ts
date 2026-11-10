import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keyHash } from '../src/access.js';
import { run } from '../src/cli.js';
import { parseRecallConfig, recallConfigHash } from '../src/config.js';
import { evaluate, evalRunsDir, recordEvalRun } from '../src/eval.js';
import { hostName } from '../src/events.js';
import { SCHEMA_VERSION } from '../src/store.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const runs = (): Record<string, unknown>[] => {
  const file = path.join(evalRunsDir(root), `${hostName()}.jsonl`);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>) : [];
};
const quiet = () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
};
const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-eval-'));
  mkdirSync(path.join(root, '.noto'));
  write('Decisions/budget.md', '---\nkind: decision\n---\n# Budget choice\n\nWe chose the smaller budget for the audit.\n');
  write('Logs/2026-11-01 budget.md', '# Budget day\n\nTalked about the budget and the audit all day.\n');
  write('Knowledge/Audit.md', '# Audit\n\nThe audit of the indexes.\n');
  // One case first place, one second, one missed.
  write('eval/cases.yaml', [
    '- query: budget choice', '  expect: [Decisions/budget.md]',
    '- query: budget', '  expect: [Logs/2026-11-01 budget.md]',
    '- query: nothing like it', '  expect: [Knowledge/Audit.md]',
  ].join('\n'));
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

describe('the eval ledger', () => {
  it('appends one line per run with the scores and what they were measured under', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const report = evaluate(vault, path.join(root, 'eval/cases.yaml'), { k: 3 });
      expect(report.rows.map((row) => row.rank)).toEqual([1, 2, null]);
      expect(report.firstHit).toBeCloseTo(1 / 3);
      expect(report.mrr).toBeCloseTo((1 + 1 / 2) / 3);
      expect(runs()).toEqual([{
        time: expect.any(String), actor: 'owner', file: 'eval/cases.yaml', mode: 'recall', queries: 3, k: 3,
        hitAtK: report.hitRate, mrr: report.mrr, firstHit: report.firstHit,
        schema: SCHEMA_VERSION, config: recallConfigHash(vault.config.recall), version,
      }]);
      // Measuring reads nothing.
      expect(existsSync(path.join(root, '.noto', 'events'))).toBe(false);
      // Another config is another hash.
      evaluate(vault, path.join(root, 'eval/cases.yaml'), { k: 3, config: parseRecallConfig({ heat: 0.3 }) });
      expect(runs()).toHaveLength(2);
      expect(runs()[1]!.config).not.toBe(runs()[0]!.config);
    } finally {
      vault.close();
    }
  });

  it('records from the command line unless told --no-record, and still records no reads', async () => {
    quiet();
    const cases = path.join(root, 'eval/cases.yaml');
    await run(['--root', root, 'eval', cases, '--no-record']);
    expect(runs()).toEqual([]);
    await run(['--root', root, 'eval', cases, '--k', '2', '--search']);
    expect(runs()).toEqual([expect.objectContaining({ mode: 'search', k: 2, queries: 3, file: 'eval/cases.yaml' })]);
    expect(existsSync(path.join(root, '.noto', 'events'))).toBe(false);
  });

  it('keeps only the owner\'s runs: an agent\'s is measured and shown, not kept', async () => {
    quiet();
    write('.noto/access.yaml', `principals:\n  agent:\n    keys: [${keyHash('k')}]\n    verbs: [read, search, recall]\n`);
    vi.stubEnv('NOTO_VAULT_KEY', 'k');
    process.exitCode = undefined;
    await run(['--root', root, 'eval', path.join(root, 'eval/cases.yaml')]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(runs()).toEqual([]);
  });

  it('says a cases file that is not a list is the caller\'s to fix', async () => {
    quiet();
    write('eval/bad.yaml', 'query: budget\n');
    process.exitCode = undefined;
    await run(['--root', root, 'eval', path.join(root, 'eval/bad.yaml')]);
    expect(process.exitCode).toBe(2);
    expect(runs()).toEqual([]);
  });

  it('makes its folders only inside a .noto that is there', () => {
    const bare = mkdtempSync(path.join(os.tmpdir(), 'noto-eval-bare-'));
    try {
      const line = { time: '2026-11-09T00:00:00.000Z', actor: 'owner', file: 'c.yaml', mode: 'recall' as const, queries: 0, k: 5, hitAtK: 0, mrr: 0, firstHit: 0, schema: SCHEMA_VERSION, config: 'x', version };
      expect(recordEvalRun(bare, line, 'h')).toBe(false);
      expect(readdirSync(bare)).toEqual([]);
      expect(recordEvalRun(root, line, 'h')).toBe(true);
      expect(readFileSync(path.join(root, '.noto/eval/runs/h.jsonl'), 'utf8')).toBe(`${JSON.stringify(line)}\n`);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
