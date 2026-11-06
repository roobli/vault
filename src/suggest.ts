/**
 * The links a vault is missing, as suggestions a person accepts or not.
 *
 * Three kinds, plus whatever the vault's scripts add:
 *
 * - `mention`: a note names another, by its title, a card's id or an alias,
 *   in running text, and does not link to it. The fix wraps the first mention.
 * - `together`: two notes are opened one after the other, or changed in the
 *   same small commits, again and again, and neither links to the other. The
 *   fix adds a `related` line.
 * - `stale`: a link still reaches its note only through an old path or name
 *   from git's renames. The fix writes the link the way the note is called now.
 *
 * Nothing here writes notes. `toChanges` turns accepted suggestions into file
 * changes, which the caller writes or proposes. A suggestion the person says
 * no to is kept in `.noto/dismissed.jsonl` and not made again.
 */

import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Kind } from './config.js';
import type { Sensitivity } from './access.js';
import { addRelationLines, applySplices, type Splice } from './edit.js';
import type { FileChange } from './git.js';
import { maskCode, splitFrontmatter } from './markdown.js';
import { decay } from './memory.js';
import { dirOf, nameOf } from './paths.js';
import { buildResolveIndex, wikiLinkTo, type ResolveIndex } from './resolve.js';
import { hasCjk } from './tokenize.js';
import { scriptContext } from './scripts.js';
import { AccessError, type Vault } from './vault.js';

export type SuggestionType = 'mention' | 'together' | 'stale' | 'script';

export interface Suggestion {
  /**
   * Short and stable: the same kind of suggestion between the same two notes
   * has the same id on every run, so it can be named to accept or dismiss.
   */
  readonly id: string;
  readonly type: SuggestionType;
  readonly from: string;
  readonly to: string;
  readonly toTitle: string;
  readonly score: number;
  readonly reason: string;
  /** 1-based line of the mention or the stale link. */
  readonly line?: number;
  /** The text around it, on its line. */
  readonly context?: string;
  /** The same text in three parts: before the mention, the mention, after it. */
  readonly around?: readonly [string, string, string];
  /** The exact change in `from`, for mentions and stale links. */
  readonly splice?: Splice;
  /** The relation a `together` or script suggestion adds. */
  readonly relation?: string;
}

export interface SuggestOptions {
  readonly types?: readonly SuggestionType[];
  /** Only suggestions from these notes. */
  readonly from?: readonly string[];
  readonly limit?: number;
  /** Include what the person dismissed. */
  readonly dismissed?: boolean;
}

interface NoteLite {
  path: string;
  title: string;
  kind: Kind;
  source: string | null;
  sensitivity: Sensitivity;
  aliases: string[];
  id: string | null;
}

/** Names too common to say which note they mean. */
const GENERIC = new Set([
  '索引', '00_索引', 'readme', 'index', 'todo', 'notes', 'note', '笔记', '总结', '记录', '草稿', '想法', '问题', '方案', '计划', '日志',
  'draft', 'summary', 'overview', '总览', '概述', '简介', 'intro', 'introduction', 'changelog', '目录', '附录', '参考', '参考资料', '待办',
]);

/** How distinctive a name is: zero when it should not be matched at all. */
function distinctive(name: string, fromCard: boolean): number {
  const text = name.trim();
  if (text.length < 2 || /[[\]|#\n]/.test(text) || GENERIC.has(text.toLowerCase())) return 0;
  if (/^[\d\s_\-./:]+$/.test(text)) return 0;
  const cjk = [...text].filter((ch) => hasCjk(ch)).length;
  if (cjk > 0) return cjk >= 4 || (fromCard && cjk >= 2) ? 1 + Math.log2(cjk) : 0;
  const letters = text.replace(/[^A-Za-z0-9]/g, '').length;
  if (fromCard) return letters >= 3 ? 1 + Math.log2(letters) / 2 : 0;
  // One lowercase English word is a word before it is a name: backup, channels, inbound.
  if (/^[a-z]+$/.test(text)) return 0;
  return letters >= 6 && /[A-Za-z]/.test(text) ? 1 + Math.log2(letters) / 3 : 0;
}

// ---------- Aho-Corasick over lowercased text ----------

interface AcNode { next: Map<string, number>; fail: number; out: number[] }

class Matcher {
  private readonly nodes: AcNode[] = [{ next: new Map(), fail: 0, out: [] }];
  readonly patterns: string[] = [];

  add(pattern: string): number {
    let state = 0;
    for (const ch of pattern) {
      let next = this.nodes[state]!.next.get(ch);
      if (next === undefined) {
        next = this.nodes.length;
        this.nodes.push({ next: new Map(), fail: 0, out: [] });
        this.nodes[state]!.next.set(ch, next);
      }
      state = next;
    }
    this.patterns.push(pattern);
    this.nodes[state]!.out.push(this.patterns.length - 1);
    return this.patterns.length - 1;
  }

  build(): void {
    const queue: number[] = [];
    for (const child of this.nodes[0]!.next.values()) queue.push(child);
    while (queue.length > 0) {
      const state = queue.shift()!;
      for (const [ch, child] of this.nodes[state]!.next) {
        queue.push(child);
        let fail = this.nodes[state]!.fail;
        while (fail !== 0 && !this.nodes[fail]!.next.has(ch)) fail = this.nodes[fail]!.fail;
        const target = this.nodes[fail]!.next.get(ch);
        this.nodes[child]!.fail = target !== undefined && target !== child ? target : 0;
        this.nodes[child]!.out.push(...this.nodes[this.nodes[child]!.fail]!.out);
      }
    }
  }

  /** Every match as [start, end, pattern], over code units of `text`. */
  *scan(text: string): Generator<[number, number, number]> {
    let state = 0;
    let at = 0;
    for (const ch of text) {
      while (state !== 0 && !this.nodes[state]!.next.has(ch)) state = this.nodes[state]!.fail;
      state = this.nodes[state]!.next.get(ch) ?? 0;
      at += ch.length;
      for (const pattern of this.nodes[state]!.out) yield [at - this.patterns[pattern]!.length, at, pattern];
    }
  }
}

const lowerKeepLength = (text: string): string => {
  const lowered = text.toLowerCase();
  if (lowered.length === text.length) return lowered;
  let out = '';
  for (const ch of text) {
    const low = ch.toLowerCase();
    out += low.length === ch.length ? low : ch;
  }
  return out;
};

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_]/.test(ch);

export function suggestionId(type: SuggestionType, from: string, to: string): string {
  return createHash('sha1').update(`${type}\0${from}\0${to}`).digest('hex').slice(0, 7);
}

const dismissedPath = (root: string) => path.join(root, '.noto', 'dismissed.jsonl');

/**
 * The ids of the suggestions the person said no to. The file keeps the type
 * and both paths, not the id, so it reads without this code.
 * yagni: a dismissal is by path, so it lapses when either note moves; key it
 * by the note's id or content hash if moves turn out to bring them back.
 */
function dismissedIds(root: string): Set<string> {
  const ids = new Set<string>();
  let text: string;
  try { text = readFileSync(dismissedPath(root), 'utf8'); } catch { return ids; }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: SuggestionType; from?: string; to?: string };
      if (entry.type && entry.from && entry.to) ids.add(suggestionId(entry.type, entry.from, entry.to));
    } catch { /* A line someone broke by hand says nothing; the rest still count. */ }
  }
  return ids;
}

/** Say no to suggestions, for good. Only the owner writes under `.noto/`. */
export function dismiss(vault: Vault, items: readonly Suggestion[]): number {
  if (!vault.principal.owner) throw new AccessError(`${vault.principal.name} may not dismiss suggestions; only the owner writes under .noto/.`);
  const known = dismissedIds(vault.root);
  const time = new Date().toISOString();
  const lines = items.filter((item) => !known.has(item.id) && known.add(item.id))
    .map((item) => JSON.stringify({ type: item.type, from: item.from, to: item.to, time }));
  if (lines.length === 0) return 0;
  mkdirSync(path.dirname(dismissedPath(vault.root)), { recursive: true });
  appendFileSync(dismissedPath(vault.root), `${lines.join('\n')}\n`);
  return lines.length;
}

/**
 * How near two notes sit. In one folder, or inside one area, a title is usually the note's name;
 * across areas it is as often an ordinary phrase that happens to be a title
 * somewhere else (一些思考, 工程规范), so it counts for less. A day's log names
 * whatever the day touched, and a card's written id or alias is a name someone
 * gave it to be called by, so neither is far. A card's title is not enough: a
 * folder's index is called what the folder is, and 设计与方案 is many folders.
 */
function nearness(from: NoteLite, to: NoteLite, named: boolean): number {
  if (dirOf(from.path) === dirOf(to.path)) return 1;
  const a = dirOf(from.path).split('/').filter(Boolean);
  const b = dirOf(to.path).split('/').filter(Boolean);
  let shared = 0;
  while (shared < a.length && shared < b.length && a[shared] === b[shared]) shared++;
  const near = shared >= 2 ? 1 : shared === 1 ? 0.8 : 0.45;
  return from.kind === 'log' || named ? Math.max(near, 0.8) : near;
}

interface Target { path: string; weight: number; name: string; card: boolean }

/**
 * The notes this principal can see, and once asked for, the matcher over
 * their names. Building the matcher over every title is most of what one
 * note's mentions cost, and it stays the same until a note is added, removed,
 * renamed, retitled or seen differently, which the index marks with a new
 * token in its `names` meta key. So an open vault keeps the table between
 * calls, as an editor that asks on every note switch needs.
 */
interface NameTable {
  readonly version: string | null;
  readonly notes: readonly NoteLite[];
  readonly byPath: ReadonlyMap<string, NoteLite>;
  matcher?: { readonly matcher: Matcher; readonly targets: readonly Target[]; readonly index: ResolveIndex };
}

const tables = new WeakMap<Vault, NameTable>();

function nameTable(vault: Vault): NameTable {
  const version = vault.store.meta('names');
  const kept = tables.get(vault);
  if (kept && version !== null && kept.version === version) return kept;
  const notes = (vault.store.db.prepare('SELECT path, title, kind, source, sensitivity, aliases, id FROM notes').all() as
    { path: string; title: string; kind: Kind; source: string | null; sensitivity: Sensitivity; aliases: string; id: string | null }[])
    .map((row) => ({ ...row, aliases: JSON.parse(row.aliases) as string[] }))
    .filter((row) => vault.canSee(row)) as NoteLite[];
  const table: NameTable = { version, notes, byPath: new Map(notes.map((note) => [note.path, note])) };
  // An index from before the token says nothing about when it changes: build afresh each time.
  if (version !== null) tables.set(vault, table);
  return table;
}

export function suggest(vault: Vault, options: SuggestOptions = {}): Suggestion[] {
  vault.requireVerb('search');
  const db = vault.store.db;
  const types = new Set(options.types ?? ['mention', 'together', 'stale', 'script']);
  const hidden = options.dismissed ? new Set<string>() : dismissedIds(vault.root);
  const table = nameTable(vault);
  const { notes, byPath } = table;
  const fromSet = options.from ? new Set(options.from.map((ref) => vault.find(ref)?.path).filter((rel): rel is string => !!rel)) : null;
  const sources = fromSet ? notes.filter((note) => fromSet.has(note.path)) : notes;

  // Who already links to whom, either way: for the whole vault every link read
  // once, for a few notes each one's links asked of the index when needed.
  const linked = fromSet ? null : new Set((db.prepare("SELECT DISTINCT src, resolved FROM links WHERE resolved IS NOT NULL AND kind != 'img'").all() as
    { src: string; resolved: string }[]).map((row) => `${row.src}\0${row.resolved}`));
  const linksOf = db.prepare("SELECT DISTINCT resolved FROM links WHERE src = ? AND resolved IS NOT NULL AND kind != 'img'");
  const asked = new Map<string, Set<string>>();
  const links = (a: string, b: string): boolean => {
    if (linked) return linked.has(`${a}\0${b}`);
    let out = asked.get(a);
    if (!out) asked.set(a, out = new Set((linksOf.all(a) as { resolved: string }[]).map((row) => row.resolved)));
    return out.has(b);
  };
  const now = Date.now();
  const heat = (rel: string) => vault.heatOf(rel, now).heat;
  const out: Suggestion[] = [];

  if (types.has('mention')) out.push(...mentions(vault, table, sources, links, heat));

  if (types.has('together')) {
    const weightsAt = Number(vault.store.meta('weights_at') ?? now);
    const rows = db.prepare('SELECT a, b, type, weight, count FROM edges WHERE count >= 3').all() as { a: string; b: string; type: string; weight: number; count: number }[];
    const pairs = new Map<string, { a: string; b: string; weight: number; count: number; types: Set<string> }>();
    for (const row of rows) {
      const half = row.type === 'visit' ? vault.config.halfLife.visit : vault.config.halfLife.coChange;
      const weight = row.weight * decay(now - weightsAt, half);
      const key = `${row.a}\0${row.b}`;
      const pair = pairs.get(key) ?? pairs.set(key, { a: row.a, b: row.b, weight: 0, count: 0, types: new Set() }).get(key)!;
      pair.weight += weight;
      pair.count += row.count;
      pair.types.add(row.type);
    }
    for (const pair of pairs.values()) {
      // The note a suggestion is from is one of the two, so a pair outside the asked notes can go before any link is looked up.
      if (fromSet && !fromSet.has(pair.a) && !fromSet.has(pair.b)) continue;
      if (pair.weight < 0.8 || links(pair.a, pair.b) || links(pair.b, pair.a)) continue;
      const a = byPath.get(pair.a);
      const b = byPath.get(pair.b);
      if (!a || !b) continue;
      // A log points at its card; otherwise the warmer note points at the other.
      const [from, to] = b.kind === 'card' && a.kind !== 'card' ? [a, b] : a.kind === 'card' && b.kind !== 'card' ? [b, a] : heat(a.path) >= heat(b.path) ? [a, b] : [b, a];
      if (fromSet && !fromSet.has(from.path)) continue;
      const how = [...pair.types].map((type) => (type === 'visit' ? 'opened one after the other' : 'changed in the same commits')).join(' and ');
      out.push({
        id: suggestionId('together', from.path, to.path), type: 'together', from: from.path, to: to.path, toTitle: to.title, relation: 'related',
        score: Math.round(Math.min(3, pair.weight) * 100) / 100,
        reason: `${how} ${pair.count} times, with no link between them`,
      });
    }
  }

  if (types.has('stale')) {
    const files = (db.prepare('SELECT path FROM files').all() as { path: string }[]).map((row) => row.path);
    const index = buildResolveIndex(files);
    const rows = db.prepare(`SELECT l.src, l.kind, l.target, l.anchor, l.label, l.line, l.start, l.end, l.resolved FROM links l
      WHERE l.via = 'alias' AND l.start >= 0`).all() as { src: string; kind: 'wiki' | 'md'; target: string; anchor: string; label: string | null; line: number; start: number; end: number; resolved: string }[];
    for (const row of rows) {
      const from = byPath.get(row.src);
      const to = byPath.get(row.resolved);
      if (!from || !to || (fromSet && !fromSet.has(from.path))) continue;
      const origin = db.prepare("SELECT origin FROM aliases WHERE path = ? AND origin IN ('old_path', 'old_name') LIMIT 1").get(to.path) as { origin: string } | undefined;
      if (!origin) continue;
      let replacement: string;
      if (row.kind === 'wiki') {
        const written = wikiLinkTo(index, to.path).slice(2, -2);
        replacement = `[[${written}${row.anchor}${row.label !== null ? `|${row.label}` : ''}]]`;
      } else {
        // Keep the link's own style: an absolute path stays absolute, a `:line` suffix stays.
        const absolute = row.target.startsWith('/');
        const line = /:\d+$/.exec(row.target)?.[0] ?? '';
        let where: string;
        if (absolute) {
          const vaultRoot = vault.root.replace(/\\/g, '/');
          const marker = row.target.indexOf(`/${path.posix.basename(vaultRoot)}/`);
          where = marker >= 0 ? `${row.target.slice(0, marker + path.posix.basename(vaultRoot).length + 2)}${to.path}${line}` : `${vaultRoot}/${to.path}${line}`;
        } else where = `${path.posix.relative(dirOf(from.path) || '.', to.path)}${line}`;
        replacement = `[${row.label ?? ''}](${where.replace(/ /g, '%20')}${row.anchor})`;
      }
      out.push({
        id: suggestionId('stale', from.path, to.path), type: 'stale', from: from.path, to: to.path, toTitle: to.title, line: row.line,
        score: 2, reason: `the link names "${row.target}", which is where the note used to be`,
        splice: { start: row.start, end: row.end, replacement },
      });
    }
  }

  if (types.has('script') && vault.scripts.scripts.some((script) => script.suggest)) {
    const ctx = scriptContext(vault.root, vault.config);
    for (const note of sources) {
      const text = vault.textOf(note.path);
      if (text === null) continue;
      const { body } = splitFrontmatter(text);
      for (const script of vault.scripts.scripts) {
        if (!script.suggest) continue;
        const items = script.suggest({ path: note.path, title: note.title, frontmatter: {}, body, headings: [], links: [] }, ctx) ?? [];
        for (const item of items) {
          const to = vault.find(item.target);
          if (!to || to.path === note.path || links(note.path, to.path)) continue;
          out.push({
            id: suggestionId('script', note.path, to.path), type: 'script', from: note.path, to: to.path, toTitle: to.title, relation: item.relation ?? 'related',
            score: item.score ?? 1, reason: `${script.name ?? 'a script'}: ${item.reason}`,
          });
        }
      }
    }
  }

  const kept = out.filter((item) => !hidden.has(item.id));
  kept.sort((left, right) => right.score - left.score || left.from.localeCompare(right.from));
  return options.limit ? kept.slice(0, options.limit) : kept;
}

/** The matcher over every name a note can be mentioned by, built once per name table. */
function mentionMatcher(vault: Vault, table: NameTable): NonNullable<NameTable['matcher']> {
  if (table.matcher) return table.matcher;
  const { notes } = table;
  const matcher = new Matcher();
  const targets: Target[] = [];
  const seen = new Map<string, number>();
  const add = (name: string, note: NoteLite, fromCard: boolean) => {
    const weight = distinctive(name, fromCard);
    if (weight === 0) return;
    const key = lowerKeepLength(name.trim());
    const known = seen.get(key);
    if (known !== undefined) {
      // Two notes share the name: it says neither.
      if (targets[known]!.path !== note.path) targets[known]!.weight = 0;
      return;
    }
    seen.set(key, matcher.add(key));
    targets.push({ path: note.path, weight, name: name.trim(), card: fromCard });
  };
  // Names a person wrote: titles, and the id and aliases in frontmatter. Aliases a script
  // derives (folder names, say) find notes, but are too loose to claim a mention.
  const written = new Map<string, string[]>();
  for (const row of vault.store.db.prepare('SELECT path, frontmatter FROM notes').all() as { path: string; frontmatter: string }[]) {
    const fm = JSON.parse(row.frontmatter) as Record<string, unknown>;
    const names = [fm.id, ...(Array.isArray(fm.aliases) ? fm.aliases : typeof fm.aliases === 'string' ? fm.aliases.split(/[,，]/) : [])]
      .filter((name): name is string | number => typeof name === 'string' || typeof name === 'number').map(String);
    if (names.length > 0) written.set(row.path, names);
  }
  for (const note of notes) {
    const card = note.kind === 'card';
    add(note.title, note, false);
    if (nameOf(note.path) !== note.title) add(nameOf(note.path), note, false);
    for (const alias of written.get(note.path) ?? []) add(alias, note, card);
  }
  matcher.build();
  table.matcher = { matcher, targets, index: buildResolveIndex(notes.map((note) => note.path)) };
  return table.matcher;
}

function mentions(vault: Vault, table: NameTable, sources: readonly NoteLite[], links: (a: string, b: string) => boolean, heat: (rel: string) => number): Suggestion[] {
  const { notes, byPath } = table;
  const { matcher, targets, index } = mentionMatcher(vault, table);
  const perNote: { from: NoteLite; start: number; end: number; pattern: number; text: string }[] = [];
  const documentFrequency = new Map<number, number>();
  for (const from of sources) {
    // A copy of someone else's text is kept as it was copied.
    if (from.source === 'heard') continue;
    const text = vault.textOf(from.path);
    if (text === null) continue;
    const { frontmatter } = splitFrontmatter(text);
    // Only running text: no frontmatter, code, headings, or text that is already a link.
    let masked = maskCode(text);
    masked = ' '.repeat(frontmatter.length) + masked.slice(frontmatter.length);
    masked = masked.replace(/^#{1,6} .*$/gm, (line) => ' '.repeat(line.length));
    // Links, tags, URLs and file paths written as text: none of them is prose naming a note.
    // Links go first and whole: a path matched from the prose before one would
    // swallow its opening brackets and leave the label to be read as prose.
    const blank = (part: string) => ' '.repeat(part.length);
    masked = masked.replace(/!?\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>|https?:\/\/\S+/g, blank);
    masked = masked.replace(/[^\s()（）"'`[\]|，。、；：！？「」《》]*\/[^\s()（）"'`[\]|，。、；：！？「」《》]*|\S+\.(?:md|markdown)\b/g, blank);
    const lower = lowerKeepLength(masked);
    const hits: [number, number, number][] = [];
    for (const hit of matcher.scan(lower)) {
      const target = targets[hit[2]]!;
      if (target.weight === 0 || target.path === from.path) continue;
      if (!hasCjk(target.name) && (isWordChar(lower[hit[0] - 1]) || isWordChar(lower[hit[1]]))) continue;
      hits.push(hit);
    }
    // Longest first at each place, then no overlaps; one suggestion per target per note.
    hits.sort((left, right) => left[0] - right[0] || (right[1] - right[0]) - (left[1] - left[0]));
    let reach = -1;
    const taken = new Set<string>();
    const counted = new Set<number>();
    for (const [start, end, pattern] of hits) {
      if (start < reach) continue;
      reach = end;
      if (!counted.has(pattern)) { counted.add(pattern); documentFrequency.set(pattern, (documentFrequency.get(pattern) ?? 0) + 1); }
      const target = targets[pattern]!;
      if (taken.has(target.path) || links(from.path, target.path)) continue;
      taken.add(target.path);
      perNote.push({ from, start, end, pattern, text });
    }
  }

  // A name that turns up in many notes is a word, not a reference.
  const ceiling = Math.max(15, Math.ceil(notes.length * 0.005));
  const out: Suggestion[] = [];
  for (const { from, start, end, pattern, text } of perNote) {
    const target = targets[pattern]!;
    const to = byPath.get(target.path);
    if (!to) continue;
    const frequency = documentFrequency.get(pattern) ?? 0;
    const card = target.card;
    if (frequency > ceiling) continue;
    const written = text.slice(start, end);
    const link = wikiLinkTo(index, to.path).slice(2, -2);
    const replacement = link === written ? `[[${written}]]` : `[[${link}|${written}]]`;
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const lineEnd = text.indexOf('\n', end);
    // In a table row a label's `|` would end the cell, and the escaped form is not a link to the vault's tools.
    if (replacement.includes('|') && /^\s*\|/.test(text.slice(lineStart, start))) continue;
    const line = text.slice(0, start).split('\n').length;
    const stop = lineEnd < 0 ? text.length : lineEnd;
    const head = text.slice(Math.max(lineStart, start - 60), start);
    const tail = text.slice(end, Math.min(stop, end + 60));
    const around = [`${start - 60 > lineStart ? '…' : ''}${head.trimStart()}`, written, `${tail.trimEnd()}${end + 60 < stop ? '…' : ''}`] as const;
    // Inside a run of Chinese on both sides, a title is as often part of a
    // longer phrase as a name for the note: 强化学习方案, 执行计划学习探讨.
    const embedded = hasCjk(written[0]!) && hasCjk(written[written.length - 1]!) && hasCjk(text[start - 1] ?? '') && hasCjk(text[end] ?? '');
    out.push({
      id: suggestionId('mention', from.path, to.path), type: 'mention', from: from.path, to: to.path, toTitle: to.title, line,
      context: around.join(''),
      around,
      // A page of a copied handbook is a weaker target than one's own note.
      score: Math.round(target.weight * (card ? 1.3 : 1) * (to.source === 'heard' ? 0.6 : 1) * (1 + 0.1 * Math.log1p(heat(to.path)))
        * nearness(from, to, card) * (embedded ? 0.6 : 1) / Math.max(1, Math.log2(1 + frequency)) * 100) / 100,
      reason: `mentions "${written}" without linking to it`,
      splice: { start, end, replacement },
    });
  }
  return out;
}

/**
 * File changes for a set of accepted suggestions: splices for mentions and
 * stale links, relation lines for the rest, one change per note.
 */
export function toChanges(vault: Vault, suggestions: readonly Suggestion[]): FileChange[] {
  const byNote = new Map<string, Suggestion[]>();
  for (const suggestion of suggestions) (byNote.get(suggestion.from) ?? byNote.set(suggestion.from, []).get(suggestion.from)!).push(suggestion);
  const changes: FileChange[] = [];
  for (const [rel, items] of byNote) {
    const original = vault.textOf(rel);
    if (original === null) continue;
    let text = applySplices(original, items.filter((item) => item.splice).map((item) => item.splice!)).text;
    const lines: string[] = [];
    for (const item of items.filter((entry) => !entry.splice)) {
      const to = vault.find(item.to);
      if (to) lines.push(vault.relationLine(to, item.relation ?? 'related'));
    }
    if (lines.length > 0) text = addRelationLines(text, lines, vault.config.relationsHeading);
    if (text !== original) changes.push({ path: rel, content: text });
  }
  return changes;
}

