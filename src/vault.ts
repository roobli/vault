/**
 * A vault, opened as one principal: the eight verbs, plus the views built on
 * the same index (backlinks, where, graph, suggestions, proposals).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadAccess, type AccessPolicy, type Principal, type Sensitivity, type Verb } from './access.js';
import { loadConfig, type BrainConfig, type Kind, type Source } from './config.js';
import { addRelationLines, appendEntry, datedPath, relationWord } from './edit.js';
import { recordEvents, newSession, type EventVerb } from './events.js';
import { acceptProposal, createProposal, findRepo, listProposals, proposalDiff, rejectProposal, type AcceptResult, type FileChange, type GitRepo, type Proposal } from './git.js';
import { refresh, type IndexContext, type RefreshStats } from './indexer.js';
import { decay } from './memory.js';
import { isMarkdown, nameOf, normalise } from './paths.js';
import { aliasKey, wikiLinkTo, buildResolveIndex } from './resolve.js';
import { loadScripts, scriptContext, type LoadedScripts } from './scripts.js';
import { indexPath, SCHEMA_VERSION, Store } from './store.js';
import { looseExpression, matchExpression, queryPieces } from './tokenize.js';

export class AccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AccessError';
  }
}

export class ConflictError extends Error {
  constructor(message: string, readonly currentHash: string | null) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface NoteRow {
  readonly path: string;
  readonly title: string;
  readonly id: string | null;
  readonly kind: Kind;
  readonly source: Source | null;
  readonly sensitivity: Sensitivity;
  readonly status: string | null;
  readonly date: string | null;
  readonly hash: string;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
}

export interface NoteHeat {
  readonly heat: number;
  readonly reads: number;
  readonly writes: number;
  readonly lastRead: string | null;
  readonly lastWrite: string | null;
}

export interface ReadResult extends NoteRow, NoteHeat {
  readonly text: string;
  readonly links: readonly { target: string; resolved: string | null; relation: string | null; line: number }[];
  readonly backlinks: readonly { path: string; title: string; relation: string | null }[];
}

export interface SearchHit {
  readonly path: string;
  readonly title: string;
  readonly kind: Kind;
  readonly score: number;
  readonly snippet: string;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly kind?: Kind;
  readonly folder?: string;
  readonly mode?: 'all' | 'any';
}

export interface OpenOptions {
  /** Act as the owner. The CLI does this unless a key names someone else. */
  readonly owner?: boolean;
  /** A principal's key, from `NOTO_VAULT_KEY`. */
  readonly key?: string;
  /** Groups this process's events into one sitting. */
  readonly session?: string;
  /** Refresh the index on open (default true). */
  readonly refresh?: boolean;
}

const sha = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

interface RawNoteRow {
  nid: number; path: string; title: string; id: string | null; kind: Kind; source: Source | null; sensitivity: Sensitivity;
  status: string | null; date: string | null; hash: string; tags: string; aliases: string;
}

function toNote(row: RawNoteRow): NoteRow {
  return {
    path: row.path, title: row.title, id: row.id, kind: row.kind, source: row.source, sensitivity: row.sensitivity,
    status: row.status, date: row.date, hash: row.hash, tags: JSON.parse(row.tags) as string[], aliases: JSON.parse(row.aliases) as string[],
  };
}

export class Vault {
  readonly session: string;
  private readonly repoCache: { value: GitRepo | null | undefined } = { value: undefined };

  private constructor(
    readonly root: string,
    readonly store: Store,
    readonly config: BrainConfig,
    readonly access: AccessPolicy,
    readonly scripts: LoadedScripts,
    readonly principal: Principal,
    private readonly fingerprint: string,
    session: string | undefined,
  ) {
    this.session = session ?? newSession();
  }

  static async open(root: string, options: OpenOptions = {}): Promise<Vault> {
    const absolute = path.resolve(root);
    if (!existsSync(absolute)) throw new Error(`There is no folder at ${absolute}.`);
    const { config, text } = loadConfig(absolute);
    const access = loadAccess(absolute);
    const scripts = await loadScripts(absolute);
    const principal = options.owner ? access.owner : access.principalFor(options.key);
    const fingerprint = sha([String(SCHEMA_VERSION), text, access.text, scripts.fingerprint].join('\0'));
    const store = Store.open(indexPath(absolute));
    const vault = new Vault(absolute, store, config, access, scripts, principal, fingerprint, options.session);
    if (options.refresh !== false) vault.refresh();
    return vault;
  }

  close(): void {
    this.store.close();
  }

  private get context(): IndexContext {
    return {
      root: this.root, store: this.store, config: this.config, access: this.access, scripts: this.scripts,
      scriptContext: scriptContext(this.root, this.config), fingerprint: this.fingerprint,
    };
  }

  private get repo(): GitRepo | null {
    if (this.repoCache.value === undefined) this.repoCache.value = findRepo(this.root);
    return this.repoCache.value;
  }

  refresh(options: { full?: boolean; paths?: readonly string[] } = {}): RefreshStats {
    return refresh(this.context, options);
  }

  // ---------- access ----------

  /** Throw unless this principal may use the verb. */
  requireVerb(verb: Verb): void {
    if (!this.principal.verbs.has(verb)) {
      throw new AccessError(`${this.principal.name} may not ${verb} in this vault${verb === 'write' || verb === 'link' || verb === 'supersede' ? '; propose the change instead' : ''}.`);
    }
  }

  /** Whether this principal may see a note. */
  canSee(note: { path: string; sensitivity: Sensitivity }): boolean {
    return this.principal.canSee(note.path, note.sensitivity);
  }

  /** Record events as this principal, in this sitting. */
  recordEvent(verb: EventVerb, paths: readonly string[], extra: { query?: string; from?: string } = {}): void {
    if (paths.length === 0) return;
    try {
      recordEvents(this.root, paths.map((rel) => ({ actor: this.principal.name, verb, path: rel, session: this.session, ...extra })));
    } catch {
      // A vault on a read-only disk still answers; it only forgets that it was asked.
    }
  }

  // ---------- notes ----------

  private noteRow(rel: string): RawNoteRow | undefined {
    return this.store.db.prepare('SELECT nid, path, title, id, kind, source, sensitivity, status, date, hash, tags, aliases FROM notes WHERE path = ?').get(rel) as RawNoteRow | undefined;
  }

  /** The note a reference means: a path, an id, an alias, a unique name, or a title. Null when none or not visible. */
  find(ref: string): NoteRow | null {
    const clean = normalise(ref.trim().replace(/^\[\[|\]\]$/g, '').split('|')[0]!.split('#')[0]!);
    const tries: (() => RawNoteRow | undefined)[] = [
      () => this.noteRow(clean),
      () => this.noteRow(`${clean}.md`),
      () => this.store.db.prepare('SELECT n.nid, n.path, n.title, n.id, n.kind, n.source, n.sensitivity, n.status, n.date, n.hash, n.tags, n.aliases FROM aliases a JOIN notes n ON n.path = a.path WHERE a.key = ? ORDER BY a.origin = \'id\' DESC LIMIT 1').get(aliasKey(clean)) as RawNoteRow | undefined,
      () => {
        const rows = this.store.db.prepare("SELECT nid, path, title, id, kind, source, sensitivity, status, date, hash, tags, aliases FROM notes WHERE path = ? OR path LIKE ? ESCAPE '\\'")
          .all(`${clean}.md`, `%/${clean.replace(/[\\%_]/g, '\\$&')}.md`) as unknown as RawNoteRow[];
        return rows.length === 1 ? rows[0] : rows.find((row) => row.kind === 'card');
      },
      () => {
        const rows = this.store.db.prepare('SELECT nid, path, title, id, kind, source, sensitivity, status, date, hash, tags, aliases FROM notes WHERE lower(title) = lower(?)').all(ref.trim()) as unknown as RawNoteRow[];
        return rows.length === 1 ? rows[0] : undefined;
      },
    ];
    for (const attempt of tries) {
      const row = attempt();
      if (row && this.canSee(row)) return toNote(row);
    }
    return null;
  }

  heatOf(rel: string, now = Date.now()): NoteHeat {
    const row = this.store.db.prepare('SELECT value, reads, writes, last_read, last_write FROM heat WHERE path = ?').get(rel) as
      { value: number; reads: number; writes: number; last_read: number | null; last_write: number | null } | undefined;
    if (!row) return { heat: 0, reads: 0, writes: 0, lastRead: null, lastWrite: null };
    const at = Number(this.store.meta('weights_at') ?? now);
    const kind = (this.noteRow(rel)?.kind ?? 'note') as Kind;
    return {
      heat: row.value * decay(now - at, this.config.halfLife.heat[kind]),
      reads: row.reads, writes: row.writes, lastRead: iso(row.last_read), lastWrite: iso(row.last_write),
    };
  }

  read(ref: string): ReadResult {
    this.requireVerb('read');
    const note = this.find(ref);
    if (!note) throw new Error(`No note in this vault answers to "${ref}".`);
    const text = readFileSync(path.join(this.root, note.path), 'utf8');
    const links = (this.store.db.prepare('SELECT target, resolved, relation, line FROM links WHERE src = ? ORDER BY start').all(note.path) as
      { target: string; resolved: string | null; relation: string | null; line: number }[]);
    this.recordEvent('read', [note.path]);
    return {
      ...note,
      hash: sha(text),
      ...this.heatOf(note.path),
      text,
      links: links.map((link) => ({ ...link, resolved: link.resolved && this.visiblePath(link.resolved) ? link.resolved : link.resolved ? '(hidden)' : null })),
      backlinks: this.backlinks(note.path),
    };
  }

  private visiblePath(rel: string): boolean {
    const row = this.noteRow(rel);
    return row ? this.canSee(row) : this.principal.owner;
  }

  backlinks(rel: string): { path: string; title: string; relation: string | null }[] {
    const rows = this.store.db.prepare(`SELECT DISTINCT l.src AS path, n.title, n.sensitivity, l.relation FROM links l JOIN notes n ON n.path = l.src
      WHERE l.resolved = ? AND l.src != ? ORDER BY n.path`).all(rel, rel) as { path: string; title: string; sensitivity: Sensitivity; relation: string | null }[];
    return rows.filter((row) => this.canSee(row)).map(({ path: src, title, relation }) => ({ path: src, title, relation }));
  }

  search(query: string, options: SearchOptions = {}): SearchHit[] {
    this.requireVerb('search');
    const limit = options.limit ?? 20;
    const run = (mode: 'all' | 'any' | 'loose') => {
      const expression = mode === 'loose' ? looseExpression(query) : matchExpression(query, mode);
      if (!expression) return [];
      return this.store.db.prepare(`SELECT n.nid, n.path, n.title, n.id, n.kind, n.source, n.sensitivity, n.status, n.date, n.hash, n.tags, n.aliases,
          bm25(fts, 8.0, 3.0, 1.0) AS rank
        FROM fts JOIN notes n ON n.nid = fts.rowid WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(expression, Math.max(200, limit * 5)) as unknown as (RawNoteRow & { rank: number })[];
    };
    let rows = run(options.mode ?? 'all');
    if (rows.length === 0 && (options.mode ?? 'all') === 'all') rows = run('any');
    if (rows.length === 0) rows = run('loose');
    const wanted = query.trim().toLowerCase();
    const now = Date.now();
    const scored = rows
      .filter((row) => this.canSee(row))
      .filter((row) => !options.kind || row.kind === options.kind)
      .filter((row) => !options.folder || row.path.startsWith(options.folder.replace(/\/?$/, '/')))
      .map((row) => {
        const aliases = JSON.parse(row.aliases) as string[];
        const exact = row.title.toLowerCase() === wanted || aliases.some((alias) => alias.toLowerCase() === wanted) || nameOf(row.path).toLowerCase() === wanted;
        const heat = this.heatOf(row.path, now).heat;
        const superseded = this.isSuperseded(row.path) ? 0.5 : 1;
        return { row, score: -row.rank * (exact ? 2.5 : 1) * (1 + 0.1 * Math.log1p(heat)) * superseded };
      })
      .sort((left, right) => right.score - left.score)
      .slice(0, limit);
    return scored.map(({ row, score }) => ({
      path: row.path, title: row.title, kind: row.kind, score: Math.round(score * 100) / 100,
      snippet: snippetOf(this.textOf(row.path) ?? '', queryPieces(query)),
    }));
  }

  textOf(rel: string): string | null {
    try { return readFileSync(path.join(this.root, rel), 'utf8'); } catch { return null; }
  }

  /** Whether a note has been superseded: a note says it supersedes this one, or this one says what superseded it. */
  isSuperseded(rel: string): boolean {
    const row = this.store.db.prepare(`SELECT 1 FROM links WHERE (resolved = ? AND relation = 'supersedes') OR (src = ? AND relation = 'superseded_by' AND resolved IS NOT NULL) LIMIT 1`).get(rel, rel);
    return row !== undefined || this.noteRow(rel)?.status === 'superseded';
  }

  /** Where an id, alias or name lives now. */
  where(ref: string): { path: string; folder: string; title: string; kind: Kind; via: string } | null {
    const key = aliasKey(ref);
    const row = this.store.db.prepare(`SELECT a.path, a.origin FROM aliases a JOIN notes n ON n.path = a.path WHERE a.key = ?
      ORDER BY n.kind = 'card' DESC, a.origin = 'id' DESC LIMIT 1`).get(key) as { path: string; origin: string } | undefined;
    const note = row ? this.find(row.path) : this.find(ref);
    if (!note) return null;
    return { path: note.path, folder: path.posix.dirname(note.path), title: note.title, kind: note.kind, via: row?.origin ?? 'name' };
  }

  status(): Record<string, unknown> {
    const count = (sql: string) => (this.store.db.prepare(sql).get() as { n: number }).n;
    const kinds = this.store.db.prepare('SELECT kind, count(*) AS n FROM notes GROUP BY kind ORDER BY n DESC').all() as { kind: string; n: number }[];
    return {
      root: this.root,
      principal: this.principal.name,
      notes: count('SELECT count(*) AS n FROM notes'),
      kinds: Object.fromEntries(kinds.map((row) => [row.kind, row.n])),
      links: count('SELECT count(*) AS n FROM links'),
      broken: count("SELECT count(*) AS n FROM links WHERE resolved IS NULL AND kind != 'img' AND NOT (kind = 'md' AND target LIKE '/%')"),
      offsite: count("SELECT count(*) AS n FROM links WHERE resolved IS NULL AND kind = 'md' AND target LIKE '/%'"),
      ambiguous: count('SELECT count(*) AS n FROM links WHERE ambiguous = 1'),
      viaAlias: count("SELECT count(*) AS n FROM links WHERE via = 'alias'"),
      commits: count('SELECT count(*) AS n FROM commits'),
      events: count('SELECT count(*) AS n FROM events'),
      edges: count('SELECT count(*) AS n FROM edges'),
      refreshed: this.store.meta('refreshed'),
      gitHead: this.store.meta('git_head'),
      scripts: this.scripts.scripts.map((script) => script.name),
    };
  }

  /** Record that the person opened a note: what an editor calls on every open. */
  visit(rel: string, options: { from?: string } = {}): void {
    this.recordEvent('open', [rel], options.from ? { from: options.from } : {});
  }

  // ---------- graph ----------

  graph(options: { minWeight?: number; types?: readonly string[] } = {}): GraphExport {
    const now = Date.now();
    const at = Number(this.store.meta('weights_at') ?? now);
    const rows = this.store.db.prepare('SELECT nid, path, title, id, kind, source, sensitivity, status, date, hash, tags, aliases FROM notes').all() as unknown as RawNoteRow[];
    const visible = new Map(rows.filter((row) => this.canSee(row)).map((row) => [row.path, row]));
    const degree = new Map<string, number>();
    const edges: GraphEdge[] = [];
    const wanted = options.types ? new Set(options.types) : null;
    const min = options.minWeight ?? 0;
    const add = (edge: GraphEdge) => {
      if (!visible.has(edge.source) || !visible.has(edge.target) || edge.source === edge.target) return;
      if (wanted && !wanted.has(edge.type)) return;
      if (edge.weight < min) return;
      edges.push(edge);
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    };
    const linkRows = this.store.db.prepare(`SELECT src, resolved, relation, count(*) AS n FROM links WHERE resolved IS NOT NULL AND kind != 'img'
      GROUP BY src, resolved, relation`).all() as { src: string; resolved: string; relation: string | null; n: number }[];
    for (const row of linkRows) {
      add({ source: row.src, target: row.resolved, type: row.relation ? 'relation' : 'link', relation: row.relation ?? undefined, weight: row.relation ? 1.5 : 1, count: row.n });
    }
    const half: Record<string, number> = { visit: this.config.halfLife.visit, co_change: this.config.halfLife.coChange };
    for (const row of this.store.db.prepare('SELECT a, b, type, weight, count, last FROM edges').all() as { a: string; b: string; type: string; weight: number; count: number; last: number }[]) {
      add({ source: row.a, target: row.b, type: row.type, weight: round(row.weight * decay(now - at, half[row.type] ?? 60)), count: row.count, last: iso(row.last) ?? undefined });
    }
    const nodes: GraphNode[] = [...visible.values()].map((row) => {
      const heat = this.heatOf(row.path, now);
      return {
        id: row.path, title: row.title, kind: row.kind, folder: path.posix.dirname(row.path), source: row.source,
        heat: round(heat.heat), reads: heat.reads, writes: heat.writes, lastRead: heat.lastRead, lastWrite: heat.lastWrite, degree: degree.get(row.path) ?? 0,
      };
    });
    return { generatedAt: new Date(now).toISOString(), halfLifeDays: { heat: this.config.halfLife.heat, visit: this.config.halfLife.visit, coChange: this.config.halfLife.coChange }, nodes, edges };
  }

  // ---------- writes ----------

  private writeFile(rel: string, content: string): void {
    const file = path.join(this.root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.noto-${process.pid}.tmp`;
    writeFileSync(temporary, content, 'utf8');
    renameSync(temporary, file);
  }

  private checkPath(rel: string): string {
    const clean = normalise(rel);
    if (!clean || clean.startsWith('..') || path.isAbsolute(rel)) throw new AccessError(`${rel} is not a path inside the vault.`);
    if (!isMarkdown(clean)) throw new AccessError(`${rel} is not a Markdown note.`);
    return clean;
  }

  /** Replace or create a note, given the hash it was read at (null to create one that is not there). */
  write(rel: string, content: string, baseHash: string | null): { path: string; hash: string } {
    this.requireVerb('write');
    const clean = this.checkPath(rel);
    if (!this.principal.canWrite(clean)) throw new AccessError(`${this.principal.name} may not write ${clean}; propose the change instead.`);
    const current = this.textOf(clean);
    const currentHash = current === null ? null : sha(current);
    if (currentHash !== baseHash) throw new ConflictError(`${clean} changed since it was read.`, currentHash);
    this.writeFile(clean, content);
    this.recordEvent('write', [clean]);
    this.refresh({ paths: [clean] });
    return { path: clean, hash: sha(content) };
  }

  /** Add a timestamped entry to a log note, by default today's in the configured place. */
  append(text: string, options: { to?: string; now?: Date } = {}): { path: string } {
    this.requireVerb('append');
    const now = options.now ?? new Date();
    const rel = this.checkPath(options.to ?? datedPath(this.config.append.path, now));
    if (!this.principal.canAppend(rel)) throw new AccessError(`${this.principal.name} may not append to ${rel}.`);
    const stamp = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const who = this.principal.owner ? '' : ` · ${this.principal.name}`;
    const entry = `### ${stamp}${who}\n\n${text.trim()}`;
    const current = this.textOf(rel);
    this.writeFile(rel, appendEntry(current, entry, nameOf(rel).replace(/[_-]+/g, ' ')));
    this.recordEvent('append', [rel]);
    this.refresh({ paths: [rel] });
    return { path: rel };
  }

  /** The relation line `from` gets for a link to `to`, written the vault's way. */
  relationLine(to: NoteRow, relation: string): string {
    const files = this.store.db.prepare('SELECT path FROM files').all() as { path: string }[];
    const index = buildResolveIndex(files.map((row) => row.path));
    return `- ${relationWord(relation, this.config.relations)} ${wikiLinkTo(index, to.path, to.title)}`;
  }

  /** Changes for a typed relation from one note to another; written directly or returned for a proposal. */
  linkChanges(fromRef: string, toRef: string, relation = 'related'): FileChange[] {
    const from = this.find(fromRef);
    const to = this.find(toRef);
    if (!from) throw new Error(`No note answers to "${fromRef}".`);
    if (!to) throw new Error(`No note answers to "${toRef}".`);
    const text = this.textOf(from.path) ?? '';
    return [{ path: from.path, content: addRelationLines(text, [this.relationLine(to, relation)], this.config.relationsHeading) }];
  }

  link(fromRef: string, toRef: string, relation = 'related'): { path: string } {
    this.requireVerb('link');
    const changes = this.linkChanges(fromRef, toRef, relation);
    for (const change of changes) {
      if (!this.principal.canWrite(change.path)) throw new AccessError(`${this.principal.name} may not write ${change.path}; propose the link instead.`);
    }
    for (const change of changes) this.writeFile(change.path, change.content!);
    this.recordEvent('write', changes.map((change) => change.path));
    this.refresh({ paths: changes.map((change) => change.path) });
    return { path: changes[0]!.path };
  }

  supersedeChanges(oldRef: string, newRef: string): FileChange[] {
    const older = this.find(oldRef);
    const newer = this.find(newRef);
    if (!older) throw new Error(`No note answers to "${oldRef}".`);
    if (!newer) throw new Error(`No note answers to "${newRef}".`);
    const heading = this.config.relationsHeading;
    return [
      { path: newer.path, content: addRelationLines(this.textOf(newer.path) ?? '', [this.relationLine(older, 'supersedes')], heading) },
      { path: older.path, content: addRelationLines(this.textOf(older.path) ?? '', [this.relationLine(newer, 'superseded_by')], heading) },
    ];
  }

  supersede(oldRef: string, newRef: string): { paths: string[] } {
    this.requireVerb('supersede');
    const changes = this.supersedeChanges(oldRef, newRef);
    for (const change of changes) {
      if (!this.principal.canWrite(change.path)) throw new AccessError(`${this.principal.name} may not write ${change.path}; propose it instead.`);
    }
    for (const change of changes) this.writeFile(change.path, change.content!);
    this.recordEvent('write', changes.map((change) => change.path));
    this.refresh({ paths: changes.map((change) => change.path) });
    return { paths: changes.map((change) => change.path) };
  }

  // ---------- proposals ----------

  private requireRepo(): GitRepo {
    const repo = this.repo;
    if (!repo) throw new Error('Proposals need the vault to be in a git repository.');
    return repo;
  }

  propose(changes: readonly FileChange[], message: string): { id: string; files: string[] } {
    this.requireVerb('propose');
    const repo = this.requireRepo();
    const clean = changes.map((change) => ({ path: this.checkPath(change.path), content: change.content }));
    for (const change of clean) {
      const note = this.noteRow(change.path);
      if (note && !this.canSee(note)) throw new AccessError(`${this.principal.name} may not see ${change.path}.`);
      if (!this.principal.owner && !this.principal.canSee(change.path, this.access.sensitivityOf(change.path))) {
        throw new AccessError(`${this.principal.name} may not change ${change.path}.`);
      }
    }
    const author = this.principal.owner
      ? { name: 'owner', email: 'owner@noto.local' }
      : { name: this.principal.name, email: `${this.principal.name}@noto.local` };
    const { id } = createProposal(repo, this.root, clean, message.trim() || 'Proposed change', author);
    this.recordEvent('propose', clean.map((change) => change.path));
    return { id, files: clean.map((change) => change.path) };
  }

  proposals(): Proposal[] {
    const repo = this.repo;
    return repo ? listProposals(repo) : [];
  }

  proposalDiff(id: string): string {
    return proposalDiff(this.requireRepo(), id);
  }

  accept(id: string): AcceptResult {
    if (!this.principal.owner) throw new AccessError('Only the owner accepts proposals.');
    const repo = this.requireRepo();
    const files = this.proposals().find((proposal) => proposal.id === id)?.files.map((file) => file.path) ?? [];
    const result = acceptProposal(repo, this.root, id);
    this.recordEvent(result.conflicts.length === 0 ? 'accept' : 'propose', files);
    if (result.applied.length > 0) this.refresh({ paths: result.applied });
    return result;
  }

  reject(id: string): void {
    if (!this.principal.owner) throw new AccessError('Only the owner rejects proposals.');
    const files = this.proposals().find((proposal) => proposal.id === id)?.files.map((file) => file.path) ?? [];
    rejectProposal(this.requireRepo(), id);
    this.recordEvent('reject', files);
  }

}

export interface GraphNode {
  readonly id: string;
  readonly title: string;
  readonly kind: Kind;
  readonly folder: string;
  readonly source: Source | null;
  readonly heat: number;
  readonly reads: number;
  readonly writes: number;
  readonly lastRead: string | null;
  readonly lastWrite: string | null;
  readonly degree: number;
}

export interface GraphEdge {
  readonly source: string;
  readonly target: string;
  readonly type: string;
  readonly relation?: string | undefined;
  readonly weight: number;
  readonly count: number;
  readonly last?: string | undefined;
}

export interface GraphExport {
  readonly generatedAt: string;
  readonly halfLifeDays: { readonly heat: Readonly<Record<Kind, number>>; readonly visit: number; readonly coChange: number };
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** A line or two around the first place the query's pieces occur. */
export function snippetOf(text: string, pieces: readonly string[], width = 160): string {
  const flat = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const lower = flat.toLowerCase();
  let at = -1;
  for (const piece of pieces) {
    const hit = lower.indexOf(piece.toLowerCase());
    if (hit >= 0 && (at < 0 || hit < at)) at = hit;
  }
  if (at < 0) return flat.replace(/\s+/g, ' ').trim().slice(0, width);
  const start = Math.max(0, at - Math.floor(width / 3));
  const piece = flat.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${piece}${start + width < flat.length ? '…' : ''}`;
}

