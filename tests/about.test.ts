import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { about } from '../src/about.js';
import { keyHash } from '../src/access.js';
import { AccessError, Vault } from '../src/vault.js';

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

const ARGUS = 'Projects/Argus/00_索引.md';
const ARGUS_TEXT = '---\nmoc: true\nid: argus\n---\n# Argus 审计\n\nArgus 是审计服务。索引版本命名要带日期，见 [[missing-note]]。\n';
const IDEA = 'Knowledge/idea.md';
const PLAIN = 'Knowledge/plain.md';
const SEALED = 'Sealed/keys.md';
const EVENTS = '.noto/events/test-host/2026-11.jsonl';
/** A local time on a day in November 2026, as an event file writes it. */
const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).toISOString();

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-about-'));
  git('init', '-q', '-b', 'main');
  write(ARGUS, ARGUS_TEXT);
  write('Projects/Argus/2026_11_03_接入.md', '# Argus 接入\n\n今天接入。\n\n- 属于 [[00_索引]]\n');
  write(PLAIN, '# Plain\n\n看 [[argus]] 的设计。\n');
  write('Knowledge/索引版本命名.md', '---\ntype: decision\nknown: lived\nsensitivity: private\n---\n# 索引版本命名\n\n版本名带日期。\n');
  write('Knowledge/audit.md', '# 审计流程\n\nArgus 的审计流程怎么走。\n');
  write('Knowledge/idea-old.md', '# 想法记录\n\n一个想法。\n');
  write('Knowledge/old.md', '# Old way\n\nThe old way.\n');
  write('Knowledge/new.md', '# New way\n\nThe new way.\n\n- supersedes [[old]]\n');
  write('Scripted/plan.md', '# Plan\n\nA plan.\n');
  write('Scripted/heard.md', '---\nknown: heard\n---\n# Heard\n\nSomething heard.\n');
  write('Private/diary.md', '---\nsensitivity: open\n---\n# Diary\n\n关于 [[argus]] 的私事。\n');
  write('Private/scripted.md', '# Scripted\n\nPrivate twice.\n');
  write('Private/tied.md', '---\nsensitivity: private\n---\n# Tied\n\nPrivate three times.\n');
  write(SEALED, '# Keys\n\n[[argus]] 的密码。\n');
  commit('first', '2026-11-01T10:00:00Z');
  git('mv', 'Knowledge/idea-old.md', IDEA);
  commit('rename the idea', '2026-11-02T10:00:00Z');
  write(ARGUS, `${ARGUS_TEXT}\n更新。\n`);
  commit('change argus', '2026-11-03T10:00:00Z');

  write('.noto/brain.yaml', 'kinds:\n  fields: [type]\nco_change:\n  max_notes: 3\n');
  write('.noto/access.yaml', [
    'sensitivity:',
    '  private: ["Private/"]',
    '  sealed: ["Sealed/"]',
    'principals:',
    '  agent:',
    `    keys: [${keyHash('agent-key')}]`,
    '    max_sensitivity: private',
    '    verbs: [read, search, recall]',
    '  reader:',
    `    keys: [${keyHash('reader-key')}]`,
    '    read: ["Projects/**", "Private/**"]',
    '  blind:',
    `    keys: [${keyHash('blind-key')}]`,
    '    verbs: [append]',
  ].join('\n'));
  write('.noto/scripts/10-test.mjs', `export default {
    derive(note) {
      if (note.path.startsWith('Scripted/')) return { kind: 'decision', source: 'seen', sensitivity: 'private' };
      if (note.path === 'Private/scripted.md' || note.path === 'Private/tied.md') return { sensitivity: 'private' };
    },
  };`);
  // The format src/events.ts writes: one JSON object per line.
  const events = [
    { time: at(2, 9, 0), actor: 'owner', verb: 'open', path: 'Knowledge/idea-old.md', session: 's1' },
    { time: at(3, 9, 0), actor: 'owner', verb: 'open', path: ARGUS, session: 's2' },
    { time: at(3, 9, 1), actor: 'owner', verb: 'open', path: IDEA, session: 's2', from: ARGUS },
    { time: at(3, 9, 2), actor: 'owner', verb: 'open', path: ARGUS, session: 's2', from: IDEA },
    { time: at(3, 9, 3), actor: 'owner', verb: 'open', path: PLAIN, session: 's2' },
    { time: at(4, 10, 0), actor: 'owner', verb: 'open', path: ARGUS, session: 's3', from: SEALED },
    { time: at(4, 10, 1), actor: 'owner', verb: 'open', path: ARGUS, session: 's3', from: IDEA },
    { time: at(4, 10, 5), actor: 'agent', verb: 'read', path: ARGUS, session: 's4' },
    { time: at(4, 10, 6), actor: 'agent', verb: 'recall', path: ARGUS, session: 's4', query: '审计' },
    { time: at(4, 10, 7), actor: 'owner', verb: 'cite', path: ARGUS },
    { time: at(4, 10, 8), actor: 'owner', verb: 'write', path: ARGUS },
    { time: at(4, 10, 9), actor: 'owner', verb: 'append', path: ARGUS },
  ];
  write(EVENTS, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const open = (key?: string) => Vault.open(root, key ? { key } : { owner: true });

describe('about', () => {
  it('says where each of kind, known and sensitivity came from', async () => {
    const vault = await open();
    try {
      const origins = (ref: string) => {
        const info = about(vault, ref);
        return { kind: info.kind, known: info.known, sensitivity: info.sensitivity };
      };
      // A card by the card rule, a log by its dated name, and nothing said about the rest.
      expect(origins(ARGUS)).toEqual({ kind: { value: 'card', from: 'config' }, known: { value: null, from: 'default' }, sensitivity: { value: 'open', from: 'default' } });
      expect(origins('Projects/Argus/2026_11_03_接入.md').kind).toEqual({ value: 'log', from: 'config' });
      expect(origins(PLAIN)).toEqual({ kind: { value: 'note', from: 'default' }, known: { value: null, from: 'default' }, sensitivity: { value: 'open', from: 'default' } });
      // A frontmatter field brain.yaml maps, and the note's own word for the rest.
      expect(origins('Knowledge/索引版本命名.md')).toEqual({ kind: { value: 'decision', from: 'config' }, known: { value: 'lived', from: 'note' }, sensitivity: { value: 'private', from: 'note' } });
      expect(origins('Scripted/plan.md')).toEqual({ kind: { value: 'decision', from: 'script' }, known: { value: 'seen', from: 'script' }, sensitivity: { value: 'private', from: 'script' } });
      // What the note says of how it is known beats the script.
      expect(origins('Scripted/heard.md').known).toEqual({ value: 'heard', from: 'note' });
      // The folder is a floor the note cannot lower; when layers agree, the one nearest the note is named.
      expect(origins('Private/diary.md').sensitivity).toEqual({ value: 'private', from: 'folder' });
      expect(origins('Private/scripted.md').sensitivity).toEqual({ value: 'private', from: 'script' });
      expect(origins('Private/tied.md').sensitivity).toEqual({ value: 'private', from: 'note' });
      expect(origins(SEALED).sensitivity).toEqual({ value: 'sealed', from: 'folder' });
    } finally {
      vault.close();
    }
  });

  it('lists what links here, what the note names without a link, and what goes with it', async () => {
    const vault = await open();
    try {
      const now = Date.now();
      const info = about(vault, 'argus', { now });
      expect(info).toMatchObject({ path: ARGUS, title: 'Argus 审计', id: 'argus', aliases: ['argus'] });
      expect(info.heat).toEqual(vault.heatOf(ARGUS, now));
      expect(info.linksHere.map((link) => link.path).sort()).toEqual(['Private/diary.md', PLAIN, 'Projects/Argus/2026_11_03_接入.md', SEALED].sort());
      expect(info.linksHereCount).toBe(4);
      expect(info.linksHere.find((link) => link.path === 'Projects/Argus/2026_11_03_接入.md')?.relation).toBe('part_of');
      // Every note was written once; Plain was also opened, so it is the warmest.
      expect(info.linksHere[0]).toMatchObject({ path: PLAIN, reads: 1 });

      expect(info.namedHere).toEqual([expect.objectContaining({ to: 'Knowledge/索引版本命名.md', title: '索引版本命名' })]);
      expect(info.namedHere[0]!.around[1]).toBe('索引版本命名');
      expect(info.namedHereCount).toBe(1);

      // Plain was opened right after it too, but it links here already.
      expect(info.together).toEqual([expect.objectContaining({ path: IDEA, title: '想法记录', type: 'visit', count: 2 })]);
      expect(info.togetherCount).toBe(1);
      expect(info.together[0]!.weight).toBeGreaterThan(0);

      const listed = [ARGUS, ...info.linksHere.map((link) => link.path), ...info.namedHere.map((item) => item.to), ...info.together.map((item) => item.path)];
      expect(info.aboutSame.map((item) => item.path)).toContain('Knowledge/audit.md');
      expect(info.aboutSame.some((item) => listed.includes(item.path))).toBe(false);

      const line = ARGUS_TEXT.split('\n').findIndex((text) => text.includes('[[missing-note]]')) + 1;
      expect(info.outgoing).toEqual({ count: 1, broken: [{ target: 'missing-note', line }], brokenCount: 1 });
      expect(about(vault, 'Knowledge/old.md').supersededBy).toEqual({ path: 'Knowledge/new.md', title: 'New way' });
      expect(info.supersededBy).toBeNull();
    } finally {
      vault.close();
    }
  });

  it('counts reads per local day, who read it, and how they came to it', async () => {
    const before = readFileSync(path.join(root, EVENTS), 'utf8');
    const vault = await open();
    try {
      const info = about(vault, ARGUS);
      // A write and an append are not reads.
      expect(info.reads).toEqual([{ day: '2026-11-03', count: 2 }, { day: '2026-11-04', count: 5 }]);
      expect(info.readers).toEqual([
        { actor: 'owner', count: 5, last: at(4, 10, 7) },
        { actor: 'agent', count: 2, last: at(4, 10, 6) },
      ]);
      expect(info.leadsHere[0]).toEqual({ from: IDEA, query: null, count: 2 });
      expect(info.leadsHere).toContainEqual({ from: SEALED, query: null, count: 1 });
      expect(info.leadsHere).toContainEqual({ from: null, query: '审计', count: 1 });
      expect(info.writes).toEqual({ commits: 2, appends: 1 });
      expect(about(vault, ARGUS, { limit: 1 }).reads).toEqual([{ day: '2026-11-04', count: 5 }]);
      // What happened at the note's old path is the note's; the commit that only moved it is not a write.
      const idea = about(vault, IDEA);
      expect(idea.reads).toEqual([{ day: '2026-11-02', count: 1 }, { day: '2026-11-03', count: 1 }]);
      expect(idea.writes).toEqual({ commits: 1, appends: 0 });
    } finally {
      vault.close();
    }
    // Looking a note up records nothing, not even the recall behind aboutSame.
    expect(readFileSync(path.join(root, EVENTS), 'utf8')).toBe(before);
  });

  it('says which agents cannot see a note, and why', async () => {
    const vault = await open();
    try {
      const agents = (ref: string) => Object.fromEntries(about(vault, ref).agents.map((agent) => [agent.name, agent]));
      expect(Object.keys(agents(ARGUS))).toEqual(['agent', 'reader', 'blind', 'default']);
      expect(agents('Private/diary.md')).toMatchObject({
        agent: { canSee: true, why: null },
        reader: { canSee: false, why: 'the note is private' },
        default: { canSee: false, why: 'the note is private' },
      });
      expect(agents(PLAIN).reader).toEqual({ name: 'reader', canSee: false, why: 'the note is outside the paths it may read' });
      expect(Object.values(agents(SEALED)).every((agent) => !agent.canSee && agent.why === 'the note is sealed')).toBe(true);
    } finally {
      vault.close();
    }
  });

  it('keeps hidden notes out of every list, and refuses a note the caller cannot see', async () => {
    const agent = await open('agent-key');
    const nobody = await Vault.open(root, {});
    const blind = await open('blind-key');
    try {
      expect(() => about(agent, SEALED)).toThrow(AccessError);
      // The same refusal for a note that is not there, so it says nothing about what is hidden.
      expect(() => about(agent, 'Nowhere/none.md')).toThrow(AccessError);
      expect(() => about(blind, ARGUS)).toThrow(AccessError);

      const seen = about(agent, ARGUS);
      expect(seen.linksHere.map((link) => link.path)).not.toContain(SEALED);
      expect(seen.linksHere.map((link) => link.path)).toContain('Private/diary.md');
      // Anyone but the owner hears only of what it did itself, and of itself among the agents.
      expect(seen.readers).toEqual([{ actor: 'agent', count: 2, last: at(4, 10, 6) }]);
      expect(seen.leadsHere).toEqual([{ from: null, query: '审计', count: 1 }]);
      expect(seen.agents).toEqual([{ name: 'agent', canSee: true, why: null }]);

      const outsider = about(nobody, ARGUS);
      expect(outsider.linksHere.map((link) => link.path).sort()).toEqual([PLAIN, 'Projects/Argus/2026_11_03_接入.md'].sort());
      expect(outsider.linksHereCount).toBe(2);
      // The note it names is private.
      expect(outsider.namedHere).toEqual([]);
      expect(outsider.aboutSame.map((item) => item.path).some((rel) => rel.startsWith('Private/') || rel.startsWith('Sealed/'))).toBe(false);
    } finally {
      agent.close();
      nobody.close();
      blind.close();
    }
    const owner = await open();
    try {
      expect(() => about(owner, 'Nowhere/none.md')).toThrow(/No note/);
      expect(() => about(owner, 'Nowhere/none.md')).not.toThrow(AccessError);
    } finally {
      owner.close();
    }
  });
});
