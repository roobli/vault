import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli.js';
import { recallConfigHash } from '../src/config.js';
import { formatShadowEval, formatShadowRecall } from '../src/format.js';
import { recall } from '../src/recall.js';
import { loadShadowConfig, shadowEval, shadowRecall } from '../src/shadow.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const LOG = 'Logs/2026-11-01 budget.md';
const DECISION = 'Decisions/budget.md';
/** Everything under .noto but the index: what a run may have recorded. */
const recorded = () => readdirSync(path.join(root, '.noto')).filter((name) => !name.startsWith('index.sqlite'));
let output: string[];

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-shadow-'));
  mkdirSync(path.join(root, '.noto'));
  write(DECISION, '---\nkind: decision\n---\n# Budget choice\n\nWe chose the smaller budget for the audit.\n');
  write(LOG, '# Budget day\n\nTalked about the budget and the audit all day.\n');
  write('Knowledge/Audit.md', '# Audit\n\nThe audit of the indexes.\n');
  write('cases.yaml', `- query: budget\n  expect: [${LOG}]\n- query: budget choice\n  expect: [${DECISION}]\n`);
  write('shadow.yaml', '# Decisions last.\nrecall:\n  kind_weight: {decision: 0}\n');
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

describe('shadow ranking', () => {
  it('reads the file\'s recall: section over the vault\'s, and refuses a file without one', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const shadow = loadShadowConfig(path.join(root, 'shadow.yaml'), vault.config.recall);
      expect(shadow).toEqual({ ...vault.config.recall, kindWeight: { ...vault.config.recall.kindWeight, decision: 0 } });
      write('empty.yaml', 'budget:\n  recall_chars: 10\n');
      expect(() => loadShadowConfig(path.join(root, 'empty.yaml'), vault.config.recall)).toThrow(/no recall: section/);
    } finally {
      vault.close();
    }
  });

  it('puts both packs side by side with each note\'s move, and records nothing', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const shadow = loadShadowConfig(path.join(root, 'shadow.yaml'), vault.config.recall);
      const result = shadowRecall(vault, 'budget', shadow);
      expect(result.current).toEqual(recall(vault, 'budget', { record: false }));
      expect(result.configs).toEqual({ current: recallConfigHash(vault.config.recall), shadow: recallConfigHash(shadow) });
      expect(result.shadow.items[0]!.path).toBe(LOG);
      expect(result.moves.find((move) => move.path === LOG)).toMatchObject({ current: 2, shadow: 1 });
      expect(result.moves.find((move) => move.path === DECISION)).toMatchObject({ current: 1, shadow: 2 });
      const text = formatShadowRecall(result);
      expect(text).toMatch(new RegExp(`1 +${DECISION} +${LOG} +\\+1`));
      expect(text).toMatch(new RegExp(`2 +${LOG} +${DECISION} +-1`));
      expect(recorded()).toEqual([]);
    } finally {
      vault.close();
    }
  });

  it('scores an eval under both, and names the cases that gained, lost or moved', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const shadow = loadShadowConfig(path.join(root, 'shadow.yaml'), vault.config.recall);
      const result = shadowEval(vault, path.join(root, 'cases.yaml'), shadow, { k: 1 });
      expect([result.current.hitRate, result.shadow.hitRate]).toEqual([0.5, 0.5]);
      expect(result.changes).toEqual([
        { query: 'budget', current: null, shadow: 1, hit: 'gained' },
        { query: 'budget choice', current: 1, shadow: null, hit: 'lost' },
      ]);
      const text = formatShadowEval(result);
      expect(text).toContain('gained a hit: budget (now 1)');
      expect(text).toContain('lost a hit: budget choice (was 1)');
      expect(text).toMatch(/hit@k +50% +50% +0/);
      const wider = shadowEval(vault, path.join(root, 'cases.yaml'), shadow, { k: 3 });
      expect(wider.changes.map((change) => [change.query, change.current, change.shadow, change.hit])).toEqual([['budget', 2, 1, null], ['budget choice', 1, 2, null]]);
      expect(formatShadowEval(wider)).toContain('moved: budget 2 -> 1');
      expect(recorded()).toEqual([]);
    } finally {
      vault.close();
    }
  });

  it('runs from the command line with --shadow, as text or JSON, recording nothing', async () => {
    const shadow = path.join(root, 'shadow.yaml');
    await run(['--root', root, 'recall', 'budget', '--shadow', shadow]);
    expect(output.join('\n')).toContain('Recall for "budget": current config');
    output = [];
    await run(['--root', root, 'recall', 'budget', '--shadow', shadow, '--json']);
    expect(JSON.parse(output.join('\n')).moves[0]).toMatchObject({ path: LOG, current: 2, shadow: 1 });
    output = [];
    await run(['--root', root, 'eval', path.join(root, 'cases.yaml'), '--shadow', shadow, '--k', '1', '--json']);
    expect(JSON.parse(output.join('\n')).changes).toHaveLength(2);
    expect(recorded()).toEqual([]);
    expect(existsSync(path.join(root, '.noto', 'eval'))).toBe(false);

    process.exitCode = undefined;
    await run(['--root', root, 'eval', path.join(root, 'cases.yaml'), '--shadow', shadow, '--search']);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
    await run(['--root', root, 'recall', 'budget', '--shadow', path.join(root, 'missing.yaml')]);
    expect(process.exitCode).toBe(2);
    process.exitCode = undefined;
  });
});
