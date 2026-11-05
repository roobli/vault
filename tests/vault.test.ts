import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyHash } from '../src/access.js';
import { recordEvents } from '../src/events.js';
import { recall } from '../src/recall.js';
import { suggest, toChanges } from '../src/suggest.js';
import { AccessError, ConflictError, Vault } from '../src/vault.js';

let root: string;

const write = (rel: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), text, 'utf8');
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const commit = (message: string, when: string) => {
  git('add', '-A');
  execFileSync('git', ['commit', '-q', '-m', message], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: 'cd', GIT_AUTHOR_EMAIL: 'cd@example.com', GIT_COMMITTER_NAME: 'cd', GIT_COMMITTER_EMAIL: 'cd@example.com' },
  });
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-vault-'));
  git('init', '-q', '-b', 'main');
  write('Projects/Argus/00_索引.md', '---\nmoc: true\nid: argus\naliases: [ArgusOld]\nstatus: ing\n---\n# Argus 审计\n\nArgus 是审计服务，负责搜索引擎的接入。\n');
  write('Projects/Argus/2026_11_03_接入ES.md', '# Argus 接入 ES\n\n今天把 Argus 接入了 Elasticsearch，索引版本名写错了。\n\n- 属于 [[00_索引]]\n');
  write('Knowledge/索引版本命名.md', '# 索引版本命名\n\n索引的版本名要带日期，回滚时才找得到。\n');
  write('Knowledge/old-plan.md', '# Old plan\n\nUse a single index for everything.\n');
  write('Inbox/2026_11_04_想法.md', '# 想法\n\n索引版本命名这件事要写进规范。Argus 那边也要改。\n');
  write('Private/diary.md', '# Diary\n\nsecret things about Argus\n');
  write('Sealed/keys.md', '# Keys\n\nArgus root password\n');
  commit('first', '2026-11-01T10:00:00Z');
  git('mv', 'Knowledge/old-plan.md', 'Knowledge/plan-v1.md');
  write('Knowledge/plan-v2.md', '# Plan v2\n\nOne index per tenant, see [[old-plan]].\n');
  commit('rename the plan', '2026-11-02T10:00:00Z');
  write('Projects/Argus/2026_11_03_接入ES.md', `${readFileSync(path.join(root, 'Projects/Argus/2026_11_03_接入ES.md'), 'utf8')}\n更新。\n`);
  write('Knowledge/索引版本命名.md', `${readFileSync(path.join(root, 'Knowledge/索引版本命名.md'), 'utf8')}\n补充。\n`);
  commit('together', '2026-11-03T10:00:00Z');
  write('Projects/Argus/2026_11_03_接入ES.md', `${readFileSync(path.join(root, 'Projects/Argus/2026_11_03_接入ES.md'), 'utf8')}\n再更新。\n`);
  write('Knowledge/索引版本命名.md', `${readFileSync(path.join(root, 'Knowledge/索引版本命名.md'), 'utf8')}\n再补充。\n`);
  commit('together again', '2026-11-04T10:00:00Z');
  write('.noto/access.yaml', [
    'sensitivity:',
    '  private: ["Private/"]',
    '  sealed: ["Sealed/"]',
    'principals:',
    '  agent:',
    `    keys: [${keyHash('secret-key')}]`,
    '    max_sensitivity: private',
    '    append: ["Inbox/**"]',
    '    verbs: [read, search, recall, append, propose]',
  ].join('\n'));
  write('.noto/brain.yaml', 'append:\n  path: "Inbox/{yyyy}_{mm}_{dd}_收件.md"\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('a vault as memory', () => {
  it('indexes notes with their kinds, and finds them by path, id, alias and old path', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      expect(vault.status()).toMatchObject({ notes: 8, kinds: { card: 1, log: 2, note: 5 } });
      expect(vault.find('argus')?.path).toBe('Projects/Argus/00_索引.md');
      expect(vault.find('ArgusOld')?.kind).toBe('card');
      expect(vault.find('Knowledge/old-plan')?.path).toBe('Knowledge/plan-v1.md');
      // The link written before the rename still reaches its note, through the old name.
      const plan = vault.read('Knowledge/plan-v2.md');
      expect(plan.links).toEqual([expect.objectContaining({ target: 'old-plan', resolved: 'Knowledge/plan-v1.md' })]);
      expect(vault.backlinks('Projects/Argus/00_索引.md')).toEqual([expect.objectContaining({ path: 'Projects/Argus/2026_11_03_接入ES.md', relation: 'part_of' })]);
      expect(vault.where('argus')).toMatchObject({ folder: 'Projects/Argus', kind: 'card' });
    } finally {
      vault.close();
    }
  });

  it('searches Chinese by two-character words and ranks a title match first', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const hits = vault.search('版本');
      expect(hits[0]!.path).toBe('Knowledge/索引版本命名.md');
      expect(hits.map((hit) => hit.path)).toContain('Projects/Argus/2026_11_03_接入ES.md');
      expect(vault.search('Elasticsearch')[0]!.snippet).toContain('Elasticsearch');
    } finally {
      vault.close();
    }
  });

  it('keeps private and sealed notes from an agent, and refuses what its scope does not allow', async () => {
    const agent = await Vault.open(root, { key: 'secret-key' });
    const stranger = await Vault.open(root, {});
    try {
      expect(agent.principal.name).toBe('agent');
      expect(agent.search('Argus').map((hit) => hit.path)).toContain('Private/diary.md');
      expect(agent.search('password')).toEqual([]);
      expect(stranger.search('secret').map((hit) => hit.path)).not.toContain('Private/diary.md');
      expect(() => agent.read('Sealed/keys.md')).toThrow(/No note/);
      expect(() => agent.write('Knowledge/plan-v2.md', 'x', null)).toThrow(AccessError);
      expect(() => agent.append('note', { to: 'Knowledge/x.md' })).toThrow(AccessError);
      expect(() => stranger.append('note')).toThrow(AccessError);
      await expect(Vault.open(root, { key: 'wrong' })).rejects.toThrow(/names no principal/);
    } finally {
      agent.close();
      stranger.close();
    }
  });

  it('appends to today\'s log as the agent, and writes only from the hash it read', async () => {
    const agent = await Vault.open(root, { key: 'secret-key' });
    try {
      const when = new Date(2026, 10, 5, 9, 30);
      const { path: rel } = agent.append('把索引版本命名写进规范。', { now: when });
      expect(rel).toBe('Inbox/2026_11_05_收件.md');
      expect(readFileSync(path.join(root, rel), 'utf8')).toBe('# 2026 11 05 收件\n\n### 09:30 · agent\n\n把索引版本命名写进规范。\n');
    } finally {
      agent.close();
    }
    const owner = await Vault.open(root, { owner: true });
    try {
      const note = owner.read('Knowledge/plan-v2.md');
      expect(() => owner.write(note.path, 'changed\n', 'stale-hash')).toThrow(ConflictError);
      expect(owner.write(note.path, '# Plan v2\n\nchanged\n', note.hash).path).toBe('Knowledge/plan-v2.md');
      expect(owner.search('changed')[0]!.path).toBe('Knowledge/plan-v2.md');
    } finally {
      owner.close();
    }
  });

  it('turns visits and commits into heat and edges, and exports them as a graph', async () => {
    const t = (minutes: number) => new Date(Date.UTC(2026, 10, 4, 12, minutes)).toISOString();
    recordEvents(root, [
      { time: t(0), actor: 'owner', verb: 'open', path: 'Inbox/2026_11_04_想法.md', session: 's1' },
      { time: t(1), actor: 'owner', verb: 'open', path: 'Knowledge/old-plan.md', session: 's1', from: 'Inbox/2026_11_04_想法.md' },
      { time: t(2), actor: 'owner', verb: 'open', path: 'Inbox/2026_11_04_想法.md', session: 's1' },
      { time: t(40), actor: 'owner', verb: 'open', path: 'Knowledge/plan-v2.md', session: 's1' },
    ]);
    const vault = await Vault.open(root, { owner: true });
    try {
      const graph = vault.graph();
      const node = graph.nodes.find((entry) => entry.id === 'Knowledge/plan-v1.md')!;
      // The visit was recorded under the old path; it counts for the note where it is now.
      expect(node.reads).toBe(1);
      const visit = graph.edges.find((edge) => edge.type === 'visit')!;
      expect([visit.source, visit.target].sort()).toEqual(['Inbox/2026_11_04_想法.md', 'Knowledge/plan-v1.md']);
      expect(visit.count).toBe(2);
      // Forty minutes later is another train of thought.
      expect(graph.edges.some((edge) => edge.type === 'visit' && (edge.source === 'Knowledge/plan-v2.md' || edge.target === 'Knowledge/plan-v2.md'))).toBe(false);
      const together = graph.edges.filter((edge) => edge.type === 'co_change').sort((left, right) => right.count - left.count)[0]!;
      expect([together.source, together.target].sort()).toEqual(['Knowledge/索引版本命名.md', 'Projects/Argus/2026_11_03_接入ES.md']);
      expect(graph.edges.some((edge) => edge.type === 'relation' && edge.relation === 'part_of')).toBe(true);
    } finally {
      vault.close();
    }
  });

  it('recalls a context pack with provenance, cards and their neighbours first', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const pack = recall(vault, 'Argus 索引版本');
      const paths = pack.items.map((item) => item.path);
      expect(paths.slice(0, 3)).toEqual(expect.arrayContaining(['Projects/Argus/2026_11_03_接入ES.md', 'Knowledge/索引版本命名.md']));
      expect(paths).toContain('Projects/Argus/00_索引.md');
      expect(pack.items[0]!.why.length).toBeGreaterThan(0);
      expect(pack.items.every((item) => item.excerpt.length > 0)).toBe(true);
      expect(pack.chars).toBeLessThanOrEqual(6000);
    } finally {
      vault.close();
    }
    const agent = await Vault.open(root, { key: 'secret-key' });
    try {
      // The owner sees sealed notes; an agent never does.
      expect(recall(agent, 'Argus password').items.map((item) => item.path)).not.toContain('Sealed/keys.md');
    } finally {
      agent.close();
    }
    const again = await Vault.open(root, { owner: true });
    try {
      // Recall records what it returned, and only that.
      expect(Number(again.status().events)).toBeGreaterThan(0);
    } finally {
      again.close();
    }
  });

  it('lets a superseded note give way to the one that superseded it', async () => {
    const owner = await Vault.open(root, { owner: true });
    try {
      owner.supersede('Knowledge/plan-v1.md', 'Knowledge/plan-v2.md');
      expect(readFileSync(path.join(root, 'Knowledge/plan-v2.md'), 'utf8')).toContain('- 取代 [[plan-v1|Old plan]]');
      expect(readFileSync(path.join(root, 'Knowledge/plan-v1.md'), 'utf8')).toContain('- 被取代 [[plan-v2|Plan v2]]');
      expect(owner.isSuperseded('Knowledge/plan-v1.md')).toBe(true);
      const paths = recall(owner, 'index plan').items.map((item) => item.path);
      expect(paths).toContain('Knowledge/plan-v2.md');
      expect(paths).not.toContain('Knowledge/plan-v1.md');
    } finally {
      owner.close();
    }
  });

  it('suggests the links that are missing, and proposes them without touching the working tree', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      const all = suggest(vault);
      const mention = all.find((item) => item.type === 'mention' && item.from === 'Inbox/2026_11_04_想法.md' && item.to === 'Knowledge/索引版本命名.md')!;
      expect(mention.splice!.replacement).toBe('[[索引版本命名]]');
      expect(all.some((item) => item.type === 'mention' && item.to === 'Projects/Argus/00_索引.md' && item.from === 'Inbox/2026_11_04_想法.md')).toBe(true);
      const stale = all.find((item) => item.type === 'stale')!;
      expect(stale).toMatchObject({ from: 'Knowledge/plan-v2.md', to: 'Knowledge/plan-v1.md' });
      expect(stale.splice!.replacement).toBe('[[plan-v1]]');

      const before = readFileSync(path.join(root, 'Inbox/2026_11_04_想法.md'), 'utf8');
      git('add', '-A');
      const staged = git('diff', '--cached', '--name-only');
      const { id, files } = vault.propose(toChanges(vault, [mention, stale]), 'Link what the notes mention');
      expect(files.sort()).toEqual(['Inbox/2026_11_04_想法.md', 'Knowledge/plan-v2.md']);
      // Nothing on disk or in the person's index moved.
      expect(readFileSync(path.join(root, 'Inbox/2026_11_04_想法.md'), 'utf8')).toBe(before);
      expect(git('diff', '--cached', '--name-only')).toBe(staged);
      expect(git('branch', '--list').trim()).toBe('* main');
      expect(vault.proposalDiff(id)).toContain('+索引版本命名这件事'.replace('索引版本命名', '[[索引版本命名]]'));

      // The person edits the note meanwhile; accepting merges both.
      writeFileSync(path.join(root, 'Inbox/2026_11_04_想法.md'), before.replace('# 想法', '# 想法们'));
      const result = vault.accept(id);
      expect(result.conflicts).toEqual([]);
      const merged = readFileSync(path.join(root, 'Inbox/2026_11_04_想法.md'), 'utf8');
      expect(merged).toContain('[[索引版本命名]]这件事');
      expect(merged).toContain('# 想法们');
      expect(vault.proposals()).toEqual([]);

      // An edit to the same line conflicts: the file is left alone and the proposal stays.
      const second = vault.propose([{ path: 'Knowledge/plan-v1.md', content: '# Old plan\n\nUse one index per tenant.\n' }], 'Fix the old plan');
      writeFileSync(path.join(root, 'Knowledge/plan-v1.md'), '# Old plan\n\nUse two indexes.\n');
      expect(vault.accept(second.id).conflicts).toEqual(['Knowledge/plan-v1.md']);
      expect(readFileSync(path.join(root, 'Knowledge/plan-v1.md'), 'utf8')).toBe('# Old plan\n\nUse two indexes.\n');
      expect(vault.proposals().map((proposal) => proposal.id)).toEqual([second.id]);
      vault.reject(second.id);
      expect(vault.proposals()).toEqual([]);
    } finally {
      vault.close();
    }
  });

  it('refreshes one saved note quickly, and sees a move made outside as a move', async () => {
    const vault = await Vault.open(root, { owner: true });
    try {
      write('Knowledge/索引版本命名.md', '# 索引版本命名\n\n加上租户名。\n');
      const saved = vault.refresh();
      expect(saved).toMatchObject({ parsed: 1, removed: 0, relinked: 'changed' });
      renameSync(path.join(root, 'Inbox/2026_11_04_想法.md'), path.join(root, 'Knowledge/想法.md'));
      const moved = vault.refresh();
      expect(moved).toMatchObject({ moved: 1, removed: 1, relinked: 'all' });
      expect(vault.find('Inbox/2026_11_04_想法.md')?.path).toBe('Knowledge/想法.md');
      expect(vault.refresh()).toMatchObject({ parsed: 0, relinked: 'none' });
    } finally {
      vault.close();
    }
  });

  it('runs the vault\'s own scripts to derive fields, and re-derives when a script changes', async () => {
    write('.noto/scripts/10-roob.mjs', `export default {
      derive(note) {
        if (note.path.startsWith('Knowledge/')) return { source: 'heard', tags: ['knowledge'] };
        if (note.path.startsWith('Private/')) return { sensitivity: 'sealed' };
      },
      text(note) { return note.body.replace(/secret/g, ''); },
    };`);
    const vault = await Vault.open(root, { owner: true });
    try {
      expect(vault.find('Knowledge/plan-v2.md')).toMatchObject({ source: 'heard', tags: ['knowledge'] });
      expect(vault.find('Private/diary.md')?.sensitivity).toBe('sealed');
      expect(vault.search('secret')).toEqual([]);
    } finally {
      vault.close();
    }
    const agent = await Vault.open(root, { key: 'secret-key' });
    try {
      expect(agent.find('Private/diary.md')).toBeNull();
    } finally {
      agent.close();
    }
    expect(existsSync(path.join(root, '.noto/index.sqlite'))).toBe(true);
  });
});
