import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_RECALL, parseConfig, parseRecallConfig, recallConfigHash } from '../src/config.js';
import { BRAIN_TEMPLATE } from '../src/init.js';
import { recall } from '../src/recall.js';
import { Vault } from '../src/vault.js';

let root: string;
const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const brain = (text: string) => write('.noto/brain.yaml', text);
const pack = async (cue: string) => {
  const vault = await Vault.open(root, { owner: true });
  try {
    return recall(vault, cue, { record: false });
  } finally {
    vault.close();
  }
};

/** Every recall number spelled out at its default, as a vault might write them. */
const SPELLED_OUT = `recall:
  kind_weight: {decision: 1.3, card: 1.2, note: 1, log: 0.85}
  source_weight: {lived: 1.15, seen: 1, heard: 0.85}
  status_weight: {superseded: 0.35, archived: 0.8}
  heat: 0.15
  limit: 12
  pool: 2
  text_candidates: 80
  text_candidates_shared: 600
  bm25: {title: 8, path: 3, body: 1}
  text_floor: 0.05
  title_share: 0.6
  all_words_candidates: 40
  all_words: 0.35
  named: 1.2
  from: 0.6
  merge: 0.25
  hop_seeds: 10
  hop: {link_out: 0.4, relation_out: 0.6, link_in: 0.3, relation_in: 0.55, edge: 0.45, edge_floor: 0.05}
`;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-recall-'));
  mkdirSync(path.join(root, '.noto'));
  write('Decisions/budget.md', '---\nkind: decision\n---\n# Budget choice\n\nWe chose the smaller budget for the audit.\n\n- related [[Budget notes]]\n');
  write('Logs/2026-11-01 budget.md', '# Budget day\n\nTalked about the budget and the audit all day.\n');
  write('Knowledge/Budget notes.md', '---\nknown: heard\n---\n# Budget notes\n\nA budget is a plan for the audit.\n');
  write('Knowledge/Audit.md', '---\nknown: lived\nstatus: archived\n---\n# Audit\n\nThe audit, see [[Budget notes]].\n');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('recall config', () => {
  it('defaults to the numbers recall ranked by before they could be tuned', () => {
    expect(parseConfig('').recall).toEqual(SPELLED_OUT_VALUES);
    expect(parseConfig(BRAIN_TEMPLATE).recall).toEqual(SPELLED_OUT_VALUES);
    expect(recallConfigHash(parseConfig('').recall)).toBe(recallConfigHash(DEFAULT_RECALL));
  });

  it('takes what is in range and keeps the default for the rest', () => {
    const tuned = parseConfig('recall:\n  heat: 0\n  kind_weight: {log: 2, note: -1, card: big}\n  limit: 0\n  text_candidates: 2.5\n  hop_seeds: 0\n  hop: {edge: 0.9}\n  nonsense: 3\n').recall;
    expect(tuned.heat).toBe(0);
    expect(tuned.kindWeight).toEqual({ log: 2, note: 1, card: 1.2, decision: 1.3 });
    expect(tuned.limit).toBe(12);
    expect(tuned.textCandidates).toBe(80);
    expect(tuned.hopSeeds).toBe(0);
    expect(tuned.hop).toEqual({ ...DEFAULT_RECALL.hop, edge: 0.9 });
    expect(recallConfigHash(tuned)).not.toBe(recallConfigHash(DEFAULT_RECALL));
  });

  it('reads a section over another config, so a shadow names only what it changes', () => {
    const vaults = parseRecallConfig({ heat: 0.5 });
    expect(parseRecallConfig({ named: 2 }, vaults)).toEqual({ ...DEFAULT_RECALL, heat: 0.5, named: 2 });
  });

  it('gives the same pack with no recall section as with every default spelled out', async () => {
    const before = await pack('budget audit');
    brain(SPELLED_OUT);
    const after = await pack('budget audit');
    expect(before.items.length).toBeGreaterThan(2);
    expect(after).toEqual(before);
  });

  it('ranks by the weights the vault gives', async () => {
    const ranked = (await pack('budget')).items.map((item) => item.path);
    expect(ranked.indexOf('Decisions/budget.md')).toBeLessThan(ranked.indexOf('Logs/2026-11-01 budget.md'));
    brain('recall:\n  kind_weight: {log: 5}\n');
    const tuned = (await pack('budget')).items.map((item) => item.path);
    expect(tuned[0]).toBe('Logs/2026-11-01 budget.md');
    expect(tuned).not.toEqual(ranked);
  });
});

const SPELLED_OUT_VALUES = {
  kindWeight: { decision: 1.3, card: 1.2, note: 1, log: 0.85 },
  sourceWeight: { lived: 1.15, seen: 1, heard: 0.85 },
  statusWeight: { superseded: 0.35, archived: 0.8 },
  heat: 0.15,
  limit: 12,
  pool: 2,
  textCandidates: 80,
  textCandidatesShared: 600,
  bm25: { title: 8, path: 3, body: 1 },
  textFloor: 0.05,
  titleShare: 0.6,
  allWordsCandidates: 40,
  allWords: 0.35,
  named: 1.2,
  from: 0.6,
  merge: 0.25,
  hopSeeds: 10,
  hop: { linkOut: 0.4, relationOut: 0.6, linkIn: 0.3, relationIn: 0.55, edge: 0.45, edgeFloor: 0.05 },
};
