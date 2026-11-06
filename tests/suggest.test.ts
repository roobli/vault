import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dismiss, suggest, suggestionId } from '../src/suggest.js';
import { AccessError, Vault } from '../src/vault.js';

let root: string;

const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-suggest-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  write('Areas/Search/Design/目标设计说明.md', '# 目标设计说明\n\n怎么做。\n');
  write('Areas/Search/Design/学习方案.md', '# 学习方案\n\n一份计划。\n');
  write('Areas/Search/Design/计划学习.md', '# 计划学习\n\n另一份。\n');
  write('Areas/Search/Design/notes.md', '# Notes\n\n先读目标设计说明，再动手。\n');
  write('Areas/Search/Design/standalone.md', '# Standalone\n\n- 学习方案\n');
  write('Areas/Search/Design/embedded.md', '# Embedded\n\n用强化学习方案很好。\n');
  write('Elsewhere/essay.md', '# Essay\n\n我参考的是：目标设计说明。\n');
  write('Elsewhere/2026_11_01.md', '# 2026-11-01\n\n今天改了目标设计说明。\n');
  write('Elsewhere/label.md', '# Label\n\n属于这一类，[[Areas/Search/Design/notes|记一次 TiDB 执行计划学习探讨]] 里写过。\n');
  write('顶层设计说明.md', '# 顶层设计说明\n\n怎么做。\n');
  write('root-notes.md', '# Root\n\n先读顶层设计说明，再动手。\n');
  write('.noto/brain.yaml', 'kinds:\n  dated_names_are_logs: true\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mention = (all: ReturnType<typeof suggest>, from: string, to: string) =>
  all.find((item) => item.type === 'mention' && item.from === from && item.to === to);

describe('suggest', () => {
  it('ranks a mention inside one area above the same name across areas, unless a log says it', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const all = suggest(vault);
      const target = 'Areas/Search/Design/目标设计说明.md';
      const near = mention(all, 'Areas/Search/Design/notes.md', target)!;
      const far = mention(all, 'Elsewhere/essay.md', target)!;
      const log = mention(all, 'Elsewhere/2026_11_01.md', target)!;
      expect(near.score).toBeGreaterThan(log.score);
      expect(log.score).toBeGreaterThan(far.score);
      expect(far.score / near.score).toBeCloseTo(0.45, 1);
      // Two notes in one folder are near however shallow it is, the vault's root included.
      // The names weigh the same; 目标设计说明 is in three notes, which halves it (log2 of 4).
      expect(mention(all, 'root-notes.md', '顶层设计说明.md')!.score).toBeCloseTo(near.score * 2, 1);
    } finally {
      vault.close();
    }
  });

  it('counts a title in the middle of a longer Chinese phrase for less', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const all = suggest(vault);
      const target = 'Areas/Search/Design/学习方案.md';
      const alone = mention(all, 'Areas/Search/Design/standalone.md', target)!;
      const inside = mention(all, 'Areas/Search/Design/embedded.md', target)!;
      expect(inside.score / alone.score).toBeCloseTo(0.6, 1);
      expect(inside.around).toEqual(['用强化', '学习方案', '很好。']);
    } finally {
      vault.close();
    }
  });

  it('never reads the label of a link as prose, even after Chinese text that runs into it', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      expect(suggest(vault).filter((item) => item.from === 'Elsewhere/label.md')).toEqual([]);
    } finally {
      vault.close();
    }
  });

  it('sees a note retitled since the last call, from a vault that stayed open', async () => {
    write('Areas/Search/Design/source.md', '# Source\n\n先看拆解清单再说。\n');
    write('Areas/Search/Design/plan.md', '# Plan\n\n一二三。\n');
    const vault = await Vault.open(root, { owner: true });
    try {
      const from = 'Areas/Search/Design/source.md';
      const ask = () => suggest(vault, { from: [from], types: ['mention'] });
      expect(mention(ask(), from, 'Areas/Search/Design/plan.md')).toBeUndefined();
      // New words alone keep the names; a new title changes them.
      write('Areas/Search/Design/plan.md', '# Plan\n\n一二三四。\n');
      vault.refresh({ paths: ['Areas/Search/Design/plan.md'] });
      expect(mention(ask(), from, 'Areas/Search/Design/plan.md')).toBeUndefined();
      write('Areas/Search/Design/plan.md', '# 拆解清单\n\n一二三四。\n');
      vault.refresh({ paths: ['Areas/Search/Design/plan.md'] });
      expect(mention(ask(), from, 'Areas/Search/Design/plan.md')?.around).toEqual(['先看', '拆解清单', '再说。']);
    } finally {
      vault.close();
    }
  });

  it('keeps an id per kind and pair, and never suggests a dismissed one again', async () => {
    const owner = await Vault.open(root, { owner: true });
    const stranger = await Vault.open(root, {});
    try {
      const first = mention(suggest(owner), 'Elsewhere/essay.md', 'Areas/Search/Design/目标设计说明.md')!;
      expect(first.id).toBe(suggestionId('mention', 'Elsewhere/essay.md', 'Areas/Search/Design/目标设计说明.md'));
      expect(() => dismiss(stranger, [first])).toThrow(AccessError);
      expect(dismiss(owner, [first])).toBe(1);
      expect(dismiss(owner, [first])).toBe(0);
      const kept = JSON.parse(readFileSync(path.join(root, '.noto/dismissed.jsonl'), 'utf8').trim()) as Record<string, string>;
      expect(kept).toMatchObject({ type: 'mention', from: 'Elsewhere/essay.md', to: 'Areas/Search/Design/目标设计说明.md' });
      expect(suggest(owner).some((item) => item.id === first.id)).toBe(false);
      expect(suggest(owner, { dismissed: true }).some((item) => item.id === first.id)).toBe(true);
      // Other suggestions to the same note stay.
      expect(mention(suggest(owner), 'Areas/Search/Design/notes.md', 'Areas/Search/Design/目标设计说明.md')).toBeDefined();
    } finally {
      owner.close();
      stranger.close();
    }
  });
});
