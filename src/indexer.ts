/**
 * Keeping the index in step with the files, git and the event logs.
 *
 * A refresh walks the vault, stats each note, and reparses only those whose
 * size or modification time changed and whose hash then differs. Links are
 * re-resolved for the changed notes, or for every note when the set of files
 * changed, since a new file can change what a bare name means. New commits
 * and new event lines are read from where the last refresh stopped. When any
 * of that brought something new, heat and edges are recomputed.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import type { AccessPolicy, Sensitivity } from './access.js';
import { SENSITIVITIES } from './access.js';
import { KINDS, SOURCES, type BrainConfig, type Kind, type Source } from './config.js';
import { eventsDir } from './events.js';
import { commitsSince, findRepo, headCommit, isAncestor, type GitRepo } from './git.js';
import { dateFromName, parseNote, stringList, type Link } from './markdown.js';
import { recomputeWeights } from './memory.js';
import { anyMatch, baseOf, dirOf, isMarkdown } from './paths.js';
import { aliasKey, buildResolveIndex, resolveLink, type ResolveIndex } from './resolve.js';
import { deriveWith, type LoadedScripts, type ScriptContext } from './scripts.js';
import type { Store } from './store.js';
import { indexText } from './tokenize.js';

export interface IndexContext {
  readonly root: string;
  readonly store: Store;
  readonly config: BrainConfig;
  readonly access: AccessPolicy;
  readonly scripts: LoadedScripts;
  readonly scriptContext: ScriptContext;
  /** Config, access policy and scripts: when it changes, every note is derived again. */
  readonly fingerprint: string;
}

export interface RefreshStats {
  readonly notes: number;
  readonly parsed: number;
  readonly removed: number;
  readonly moved: number;
  readonly relinked: 'none' | 'changed' | 'all';
  readonly commits: number;
  readonly events: number;
  readonly ms: number;
}

interface FileStat {
  readonly note: boolean;
  readonly size: number;
  readonly mtime: number;
}

const MAX_NOTE_BYTES = 8 * 1024 * 1024;

/** Every file in the vault that is not in a dot-folder, `node_modules`, or ignored. */
export function walkVault(root: string, ignored: (rel: string) => boolean): Map<string, FileStat> {
  const out = new Map<string, FileStat>();
  const stack = [''];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(path.join(root, dir), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!ignored(`${rel}/`)) stack.push(rel);
      } else if (entry.isFile() && !ignored(rel)) {
        if (isMarkdown(rel)) {
          try {
            const stat = lstatSync(path.join(root, rel));
            out.set(rel, { note: true, size: stat.size, mtime: Math.floor(stat.mtimeMs) });
          } catch {
            // Gone between the listing and the stat.
          }
        } else out.set(rel, { note: false, size: 0, mtime: 0 });
      }
    }
  }
  return out;
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const higher = (left: Sensitivity, right: Sensitivity | undefined | null): Sensitivity =>
  right && SENSITIVITIES.indexOf(right) > SENSITIVITIES.indexOf(left) ? right : left;

function kindOf(rel: string, fm: Record<string, unknown>, config: BrainConfig): Kind {
  for (const field of config.kinds.fields) {
    const value = fm[field];
    if (typeof value === 'string' && config.kinds.map[value]) return config.kinds.map[value]!;
  }
  const isCardName = config.kinds.cards.includes(baseOf(rel));
  if (fm.moc === true || (isCardName && (fm.id !== undefined || fm.moc !== undefined))) return 'card';
  if (config.kinds.datedNamesAreLogs && dateFromName(rel)) return 'log';
  return 'note';
}

/** How long a note is, as a reader counts: each CJK character, and each other word. */
function countChars(text: string): number {
  let count = 0;
  let inWord = false;
  for (let at = 0; at < text.length; at += 1) {
    const code = text.charCodeAt(at);
    const cjk = (code >= 0x3400 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7af) || (code >= 0x3040 && code <= 0x30ff);
    if (cjk) { count += 1; inWord = false; continue; }
    const wordChar = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code >= 0xc0;
    if (wordChar && !inWord) count += 1;
    inWord = wordChar;
  }
  return count;
}

interface Built {
  readonly row: {
    path: string; hash: string; title: string; id: string | null; kind: Kind; source: Source | null; sensitivity: Sensitivity;
    status: string | null; date: string | null; chars: number; frontmatter: string; headings: string; tags: string; aliases: string;
  };
  readonly links: readonly (Link & { readonly derived?: boolean })[];
  readonly aliases: readonly string[];
  readonly fts: { title: string; path: string; body: string };
}

function buildNote(ix: IndexContext, rel: string, text: string, hash: string): Built {
  const parsed = parseNote(rel, text, { relations: ix.config.relations });
  const fm = parsed.frontmatter;
  const scriptNote = { path: rel, title: parsed.title, frontmatter: fm, body: parsed.body, headings: parsed.headings, links: parsed.links };
  const derived = deriveWith(ix.scripts.scripts, scriptNote, ix.scriptContext);
  let searchText = parsed.body;
  for (const script of ix.scripts.scripts) if (script.text) searchText = script.text({ ...scriptNote, body: searchText });

  const kind = derived.kind && KINDS.includes(derived.kind) ? derived.kind : kindOf(rel, fm, ix.config);
  const fmSource = typeof fm.source === 'string' && (SOURCES as readonly string[]).includes(fm.source) ? fm.source as Source : null;
  const source = derived.source !== undefined ? derived.source : fmSource;
  // The folder sets a floor; a script or the note itself may only raise it.
  const fmSensitivity = typeof fm.sensitivity === 'string' && (SENSITIVITIES as readonly string[]).includes(fm.sensitivity) ? fm.sensitivity as Sensitivity : null;
  const sensitivity = higher(higher(ix.access.sensitivityOf(rel), derived.sensitivity), fmSensitivity);
  const id = typeof fm.id === 'string' || typeof fm.id === 'number' ? String(fm.id).trim() || null : null;
  const status = derived.status !== undefined ? derived.status : typeof fm.status === 'string' ? fm.status : null;
  const fmDate = typeof fm.date === 'string' ? fm.date : typeof fm.created === 'string' ? fm.created : null;
  const date = derived.date !== undefined ? derived.date : fmDate ?? dateFromName(rel);
  const aliases = [...new Set([...stringList(fm.aliases), ...(derived.aliases ?? []), ...(id ? [id] : [])].map((alias) => alias.trim()).filter(Boolean))];
  const tags = [...new Set([...stringList(fm.tags), ...(derived.tags ?? [])])];
  const links: (Link & { derived?: boolean })[] = [...parsed.links];
  for (const relation of derived.relations ?? []) {
    links.push({ kind: 'wiki', start: -1, end: -1, target: relation.target, anchor: '', label: null, line: 0, relation: relation.type, derived: true });
  }
  return {
    row: {
      path: rel, hash, title: parsed.title, id, kind, source, sensitivity, status, date,
      chars: countChars(parsed.body),
      frontmatter: JSON.stringify(fm),
      headings: JSON.stringify(parsed.headings),
      tags: JSON.stringify(tags),
      aliases: JSON.stringify(aliases),
    },
    links,
    aliases,
    fts: {
      title: indexText([parsed.title, ...aliases].join(' ')),
      path: indexText(rel.replace(/\.(md|markdown)$/i, '').replace(/[/_-]+/g, ' ')),
      body: indexText(searchText),
    },
  };
}

function readText(file: string): { text: string; hash: string } | null {
  try {
    const buffer = readFileSync(file);
    if (buffer.length > MAX_NOTE_BYTES) return { text: buffer.subarray(0, MAX_NOTE_BYTES).toString('utf8'), hash: sha(buffer) };
    return { text: buffer.toString('utf8'), hash: sha(buffer) };
  } catch {
    return null;
  }
}

/** Old path to where the note is now, following renames from git and from moves seen here. */
export function renameResolver(store: Store, exists: (rel: string) => boolean): (rel: string) => string | null {
  const latest = new Map<string, { to: string; time: number }>();
  for (const row of store.db.prepare('SELECT old, new, time FROM renames ORDER BY time').all() as { old: string; new: string; time: number }[]) {
    const known = latest.get(row.old);
    if (!known || row.time >= known.time) latest.set(row.old, { to: row.new, time: row.time });
  }
  const cache = new Map<string, string | null>();
  return (rel) => {
    if (exists(rel)) return rel;
    const hit = cache.get(rel);
    if (hit !== undefined) return hit;
    let at = rel;
    const seen = new Set<string>();
    let result: string | null = null;
    while (!seen.has(at)) {
      seen.add(at);
      const next = latest.get(at);
      if (!next) break;
      at = next.to;
      if (exists(at)) { result = at; break; }
    }
    cache.set(rel, result);
    return result;
  };
}

/** Phase timings on stderr when NOTO_VAULT_PROFILE is set. */
function profiler(): (phase: string) => void {
  if (!process.env.NOTO_VAULT_PROFILE) return () => {};
  let last = performance.now();
  return (phase) => {
    const now = performance.now();
    process.stderr.write(`[noto-vault] ${phase}: ${Math.round(now - last)} ms\n`);
    last = now;
  };
}

export function refresh(ix: IndexContext, options: { full?: boolean; paths?: readonly string[] } = {}): RefreshStats {
  const started = performance.now();
  const lap = profiler();
  const { store, root } = ix;
  const db = store.db;
  const ignoredByConfig = anyMatch(ix.config.ignore);
  const ignored = (rel: string) => ignoredByConfig(rel) || ix.scripts.scripts.some((script) => script.ignore?.(rel) === true);

  const fingerprintChanged = store.meta('fingerprint') !== ix.fingerprint;
  const full = options.full === true || fingerprintChanged;

  const known = new Map<string, FileStat>();
  for (const row of db.prepare('SELECT path, note, size, mtime FROM files').all() as { path: string; note: number; size: number; mtime: number }[]) {
    known.set(row.path, { note: row.note === 1, size: row.size, mtime: row.mtime });
  }

  // What is on disk: the whole vault, or only the paths a watcher named.
  let disk: Map<string, FileStat>;
  if (options.paths && !full) {
    disk = new Map(known);
    for (const raw of options.paths) {
      const rel = raw.replace(/\\/g, '/').replace(/^\/+/, '');
      const file = path.join(root, rel);
      let stat;
      try { stat = statSync(file); } catch { stat = null; }
      if (stat?.isDirectory()) {
        for (const [inner, value] of walkVault(file, (sub) => ignored(`${rel}/${sub}`))) disk.set(`${rel}/${inner}`, value);
        for (const prior of known.keys()) if (prior.startsWith(`${rel}/`) && !existsSync(path.join(root, prior))) disk.delete(prior);
      } else if (stat?.isFile() && !rel.split('/').some((part) => part.startsWith('.')) && !ignored(rel)) {
        disk.set(rel, isMarkdown(rel) ? { note: true, size: stat.size, mtime: Math.floor(stat.mtimeMs) } : { note: false, size: 0, mtime: 0 });
      } else disk.delete(rel);
    }
  } else disk = walkVault(root, ignored);

  lap('walk');
  const removed = [...known.keys()].filter((rel) => !disk.has(rel));
  const added = [...disk.keys()].filter((rel) => !known.has(rel));
  const fileSetChanged = removed.length > 0 || added.length > 0 || full;

  const hashes = new Map<string, string>();
  for (const row of db.prepare('SELECT path, hash FROM notes').all() as { path: string; hash: string }[]) hashes.set(row.path, row.hash);

  const candidates = [...disk].filter(([rel, stat]) => {
    if (!stat.note) return false;
    if (full) return true;
    const before = known.get(rel);
    return !before || before.size !== stat.size || before.mtime !== stat.mtime;
  }).map(([rel]) => rel);

  const insertFile = db.prepare('INSERT INTO files(path, note, size, mtime) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET note = excluded.note, size = excluded.size, mtime = excluded.mtime');
  const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');
  const noteId = db.prepare('SELECT nid FROM notes WHERE path = ?');
  const deleteNote = db.prepare('DELETE FROM notes WHERE nid = ?');
  const deleteFts = db.prepare('DELETE FROM fts WHERE rowid = ?');
  const deleteLinks = db.prepare('DELETE FROM links WHERE src = ?');
  const deleteAliases = db.prepare("DELETE FROM aliases WHERE path = ? AND origin IN ('id', 'alias')");
  const upsertNote = db.prepare(`INSERT INTO notes(path, hash, title, id, kind, source, sensitivity, status, date, chars, frontmatter, headings, tags, aliases)
    VALUES (@path, @hash, @title, @id, @kind, @source, @sensitivity, @status, @date, @chars, @frontmatter, @headings, @tags, @aliases)
    ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, title = excluded.title, id = excluded.id, kind = excluded.kind, source = excluded.source,
      sensitivity = excluded.sensitivity, status = excluded.status, date = excluded.date, chars = excluded.chars, frontmatter = excluded.frontmatter,
      headings = excluded.headings, tags = excluded.tags, aliases = excluded.aliases
    RETURNING nid`);
  const insertFts = db.prepare('INSERT INTO fts(rowid, title, path, body) VALUES (?, ?, ?, ?)');
  const insertLink = db.prepare('INSERT INTO links(src, kind, target, anchor, label, relation, line, start, end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertAlias = db.prepare('INSERT INTO aliases(key, path, origin) VALUES (?, ?, ?)');
  const insertRename = db.prepare('INSERT INTO renames(old, new, time, origin) VALUES (?, ?, ?, ?)');

  const changedNotes = new Set<string>();
  let parsed = 0;
  let moved = 0;
  const now = Date.now();

  store.transaction(() => {
    if (full) {
      // FTS5's own command: deleting a contentless table's rows one by one is slow.
      db.exec("DELETE FROM notes; INSERT INTO fts(fts) VALUES ('delete-all'); DELETE FROM links; DELETE FROM aliases WHERE origin IN ('id', 'alias'); DELETE FROM files;");
      lap('clear');
      hashes.clear();
    }
    const removedHashes = new Map<string, string>();
    for (const rel of removed) {
      const hash = hashes.get(rel);
      if (hash) removedHashes.set(hash, rel);
      const row = noteId.get(rel) as { nid: number } | undefined;
      if (row) { deleteFts.run(row.nid); deleteNote.run(row.nid); }
      deleteLinks.run(rel);
      deleteAliases.run(rel);
      deleteFile.run(rel);
    }
    // FTS5 flushes what it holds at every savepoint, and an upsert opens one: written
    // between them, each note would become its own segment. So the full text goes in
    // batches, with nothing else in between.
    const ftsQueue: { nid: number; title: string; path: string; body: string }[] = [];
    let ftsQueued = 0;
    const flushFts = () => {
      const mark = performance.now();
      for (const row of ftsQueue) insertFts.run(row.nid, row.title, row.path, row.body);
      ftsQueue.length = 0;
      ftsQueued = 0;
      ftsMs += performance.now() - mark;
    };
    const queueFts = (nid: number, fts: Built['fts']) => {
      ftsQueue.push({ nid, ...fts });
      ftsQueued += fts.body.length + fts.title.length + fts.path.length;
      if (ftsQueued > 8_000_000) flushFts();
    };
    let readMs = 0;
    let buildMs = 0;
    let ftsMs = 0;
    const loopStart = performance.now();
    for (const rel of candidates) {
      const stat = disk.get(rel)!;
      let mark = performance.now();
      const read = readText(path.join(root, rel));
      readMs += performance.now() - mark;
      if (!read) continue;
      insertFile.run(rel, 1, stat.size, stat.mtime);
      if (!full && hashes.get(rel) === read.hash) continue;
      mark = performance.now();
      const built = buildNote(ix, rel, read.text, read.hash);
      buildMs += performance.now() - mark;
      const prior = noteId.get(rel) as { nid: number } | undefined;
      if (prior) deleteFts.run(prior.nid);
      deleteLinks.run(rel);
      deleteAliases.run(rel);
      const { nid } = upsertNote.get(built.row) as { nid: number };
      queueFts(nid, built.fts);
      for (const link of built.links) {
        insertLink.run(rel, link.kind, link.target, link.anchor, link.label, link.relation, link.line, link.start, link.end);
      }
      for (const alias of built.aliases) insertAlias.run(aliasKey(alias), rel, alias === built.row.id ? 'id' : 'alias');
      // A note that vanished and one that appeared with the same bytes is one note, moved.
      const from = known.has(rel) ? undefined : removedHashes.get(read.hash);
      if (from) { insertRename.run(from, rel, now, 'moved'); moved += 1; }
      changedNotes.add(rel);
      parsed += 1;
    }
    flushFts();
    for (const [rel, stat] of disk) {
      if (!stat.note && (full || !known.has(rel))) insertFile.run(rel, 0, 0, 0);
    }
    if (parsed > 0) lap(`notes loop: read ${Math.round(readMs)} ms, parse ${Math.round(buildMs)} ms, full text ${Math.round(ftsMs)} ms, other writes ${Math.round(performance.now() - loopStart - readMs - buildMs - ftsMs)} ms`);
  });

  lap(`notes (${parsed} parsed)`);
  // Git: new commits since the last refresh.
  const repo = findRepo(root);
  let commits = 0;
  if (repo) commits = ingestGit(ix, repo, full);
  lap(`git (${commits} commits)`);
  const renamesChanged = commits > 0 || moved > 0 || full;
  if (renamesChanged) rebuildRenameAliases(ix, new Set(disk.keys()));
  lap('rename aliases');

  // Links: every note's when the set of files or the aliases changed, else the changed notes'.
  const relinked: RefreshStats['relinked'] = fileSetChanged || renamesChanged ? 'all' : changedNotes.size > 0 ? 'changed' : 'none';
  if (relinked !== 'none') resolveLinks(ix, new Set(disk.keys()), relinked === 'all' ? null : changedNotes);
  lap(`links (${relinked})`);

  const events = ingestEvents(ix);
  lap(`events (${events})`);
  if (events > 0 || commits > 0 || fileSetChanged) {
    const exists = new Set([...disk].filter(([, stat]) => stat.note).map(([rel]) => rel));
    recomputeWeights(store, ix.config, renameResolver(store, (rel) => exists.has(rel)), now);
    lap('weights');
  }

  store.setMeta('fingerprint', ix.fingerprint);
  store.setMeta('refreshed', new Date(now).toISOString());
  const notes = (db.prepare('SELECT count(*) AS n FROM notes').get() as { n: number }).n;
  return { notes, parsed, removed: removed.length, moved, relinked, commits, events, ms: Math.round(performance.now() - started) };
}

function ingestGit(ix: IndexContext, repo: GitRepo, full: boolean): number {
  const { store } = ix;
  const head = headCommit(repo);
  const last = full ? null : store.meta('git_head');
  if (!head || head === last) return 0;
  let since = last;
  if (full || (since && !isAncestor(repo, since, head))) {
    // A full rebuild, or history rewritten under us: read it again from the start.
    store.db.exec("DELETE FROM commits; DELETE FROM changes; DELETE FROM renames WHERE origin = 'git';");
    since = null;
  }
  const commits = commitsSince(repo, since);
  const insertCommit = store.db.prepare('INSERT OR IGNORE INTO commits(hash, time, author, subject, files) VALUES (?, ?, ?, ?, ?)');
  const insertChange = store.db.prepare('INSERT INTO changes(hash, time, author, path, status, old) VALUES (?, ?, ?, ?, ?, ?)');
  const insertRename = store.db.prepare('INSERT INTO renames(old, new, time, origin) VALUES (?, ?, ?, ?)');
  store.transaction(() => {
    for (const commit of commits) {
      const notes = commit.changes.filter((change) => isMarkdown(change.path));
      insertCommit.run(commit.hash, commit.time, commit.author, commit.subject, notes.length);
      // A commit of hundreds of notes is a snapshot or a sweep, not anyone writing them:
      // only its renames are kept, so that links to the old paths still resolve.
      const bulk = notes.length > ix.config.git.bulkNotes;
      for (const change of notes) {
        if (!bulk) insertChange.run(commit.hash, commit.time, commit.author, change.path, change.status, change.old);
        if (change.status === 'R' && change.old && change.old !== change.path) insertRename.run(change.old, change.path, commit.time, 'git');
      }
    }
    store.setMeta('git_head', head);
  });
  return commits.length;
}

function rebuildRenameAliases(ix: IndexContext, files: ReadonlySet<string>): void {
  const { store } = ix;
  const current = renameResolver(store, (rel) => files.has(rel));
  const olds = store.db.prepare('SELECT DISTINCT old FROM renames').all() as { old: string }[];
  const baseTaken = new Set([...files].map((rel) => baseOf(rel).replace(/\.(md|markdown)$/i, '').toLowerCase()));
  const insert = store.db.prepare('INSERT INTO aliases(key, path, origin) VALUES (?, ?, ?)');
  store.transaction(() => {
    store.db.exec("DELETE FROM aliases WHERE origin IN ('old_path', 'old_name')");
    for (const { old } of olds) {
      if (files.has(old)) continue;
      const now = current(old);
      if (!now) continue;
      insert.run(aliasKey(old), now, 'old_path');
      const oldName = baseOf(old).replace(/\.(md|markdown)$/i, '');
      if (oldName.toLowerCase() !== baseOf(now).replace(/\.(md|markdown)$/i, '').toLowerCase() && !baseTaken.has(oldName.toLowerCase())) {
        insert.run(aliasKey(oldName), now, 'old_name');
      }
    }
  });
}

export function loadResolveIndex(store: Store, files: Iterable<string>): ResolveIndex {
  const aliases = new Map<string, string[]>();
  for (const row of store.db.prepare('SELECT key, path FROM aliases').all() as { key: string; path: string }[]) {
    (aliases.get(row.key) ?? aliases.set(row.key, []).get(row.key)!).push(row.path);
  }
  return buildResolveIndex(files, aliases);
}

function resolveLinks(ix: IndexContext, files: ReadonlySet<string>, only: ReadonlySet<string> | null): void {
  const { store } = ix;
  const index = loadResolveIndex(store, files);
  const rows = store.db.prepare('SELECT rowid AS id, src, kind, target, resolved, ambiguous, via FROM links').all() as
    { id: number; src: string; kind: Link['kind']; target: string; resolved: string | null; ambiguous: number; via: string | null }[];
  const update = store.db.prepare('UPDATE links SET resolved = ?, ambiguous = ?, via = ? WHERE rowid = ?');
  store.transaction(() => {
    for (const row of rows) {
      if (only && !only.has(row.src)) continue;
      const hit = resolveLink(index, dirOf(row.src), { target: row.target, kind: row.kind });
      const resolved = hit?.path ?? null;
      const ambiguous = hit?.ambiguous ? 1 : 0;
      const via = hit?.via ?? null;
      if (resolved !== row.resolved || ambiguous !== row.ambiguous || via !== row.via) update.run(resolved, ambiguous, via, row.id);
    }
  });
}

function ingestEvents(ix: IndexContext): number {
  const { store, root } = ix;
  const dir = eventsDir(root);
  if (!existsSync(dir)) return 0;
  const offsets = new Map<string, number>();
  for (const row of store.db.prepare('SELECT file, offset FROM event_files').all() as { file: string; offset: number }[]) offsets.set(row.file, row.offset);
  const files: { rel: string; size: number }[] = [];
  for (const host of readdirSync(dir, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const entry of readdirSync(path.join(dir, host.name), { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const rel = `${host.name}/${entry.name}`;
      files.push({ rel, size: statSync(path.join(dir, rel)).size });
    }
  }
  // A file that shrank was rewritten: start the events over.
  if (files.some((file) => (offsets.get(file.rel) ?? 0) > file.size)) {
    store.db.exec('DELETE FROM events; DELETE FROM event_files;');
    offsets.clear();
  }
  const insert = store.db.prepare('INSERT INTO events(time, actor, verb, path, session, from_path, query) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const setOffset = store.db.prepare('INSERT INTO event_files(file, offset) VALUES (?, ?) ON CONFLICT(file) DO UPDATE SET offset = excluded.offset');
  let count = 0;
  store.transaction(() => {
    for (const file of files) {
      const offset = offsets.get(file.rel) ?? 0;
      if (file.size <= offset) continue;
      const fd = openSync(path.join(dir, file.rel), 'r');
      const buffer = Buffer.alloc(file.size - offset);
      try { readSync(fd, buffer, 0, buffer.length, offset); } finally { closeSync(fd); }
      const end = buffer.lastIndexOf(0x0a);
      if (end < 0) continue;
      for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
        const time = Date.parse(String(event.time));
        if (!Number.isFinite(time) || typeof event.path !== 'string' || typeof event.verb !== 'string') continue;
        insert.run(time, String(event.actor ?? 'owner'), event.verb, event.path,
          typeof event.session === 'string' ? event.session : null,
          typeof event.from === 'string' ? event.from : null,
          typeof event.query === 'string' ? event.query : null);
        count += 1;
      }
      setOffset.run(file.rel, offset + end + 1);
    }
  });
  return count;
}
