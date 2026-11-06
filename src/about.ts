/**
 * Everything the vault knows about one note, for a pane beside it in an
 * editor and for `noto-vault about`: what the note is and where each of those
 * values came from, what links to it, what it names without a link, what is
 * opened or changed with it, what else is about the same thing, who read it
 * and how they got there, and which agents can see it.
 *
 * It runs on every note switch, so it asks the index by this note's own keys
 * and never reads the vault whole. The matcher behind the mentions is kept
 * between calls (see suggest), and recall gets the title, cut short, as its
 * cue: every word of a long title is one more posting list to merge.
 * Nothing here records an event. Looking a note up is not reading it.
 */

import { SENSITIVITIES, type Principal, type Sensitivity } from './access.js';
import type { Kind, Source } from './config.js';
import type { Origin, Origins } from './indexer.js';
import { decay } from './memory.js';
import { recall } from './recall.js';
import { aliasKey } from './resolve.js';
import { suggest } from './suggest.js';
import { hasCjk, queryPieces } from './tokenize.js';
import { AccessError, type NoteHeat, type Vault } from './vault.js';

export type { Origin } from './indexer.js';

export interface Traced<T> {
  readonly value: T;
  /** Where the value came from, as the index recorded it. */
  readonly from: Origin;
}

export interface AboutOptions {
  /** The time heat and weights are decayed to, in milliseconds; now by default. */
  readonly now?: number;
  /** Items per list, default 8. The counts say how many there are in all. */
  readonly limit?: number;
}

export interface AboutNote {
  readonly path: string;
  readonly title: string;
  readonly id: string | null;
  readonly kind: Traced<Kind>;
  readonly known: Traced<Source | null>;
  readonly sensitivity: Traced<Sensitivity>;
  readonly status: string | null;
  readonly tags: readonly string[];
  readonly aliases: readonly string[];
  /** As `Vault.heatOf`. */
  readonly heat: NoteHeat;
  /** The note that superseded this one, if the caller can see it. */
  readonly supersededBy: { readonly path: string; readonly title: string } | null;
  /** The notes that link here, warmest first; one entry per note, with the relation if any of its links has one. */
  readonly linksHere: readonly { path: string; title: string; relation: string | null; heat: number; reads: number }[];
  readonly linksHereCount: number;
  /** Notes this one names in running text without linking to them, strongest first, as `suggest` finds them. */
  readonly namedHere: readonly { id: string; to: string; title: string; score: number; around: readonly [string, string, string] }[];
  readonly namedHereCount: number;
  /** Notes opened one after the other with this one, or changed in the same commits, and not linking here; one entry per note and type, heaviest first. */
  readonly together: readonly { path: string; title: string; type: string; count: number; weight: number; last: string | null }[];
  readonly togetherCount: number;
  /** What recall finds with this note's title as the cue, from this note, less the note itself and every note in the lists above. */
  readonly aboutSame: readonly { path: string; title: string; why: readonly string[]; excerpt: string }[];
  /** Links in this note, images aside. `broken` holds the first `limit` that reach nothing; `brokenCount` says how many in all. */
  readonly outgoing: { readonly count: number; readonly broken: readonly { target: string; line: number }[]; readonly brokenCount: number };
  /** Opens, reads, recalls and cites of this note per local calendar day, YYYY-MM-DD, for the latest `limit` days that had any, oldest first. */
  readonly reads: readonly { day: string; count: number }[];
  /** Who did those, most first; `last` is ISO. Anyone but the owner hears only of itself. */
  readonly readers: readonly { actor: string; count: number; last: string }[];
  /** The notes this one was reached from by a link, and the cues that recalled it, most first. Anyone but the owner hears only of its own. */
  readonly leadsHere: readonly { from: string | null; query: string | null; count: number }[];
  /**
   * Commits that added or changed it, as heat counts writes, and entries
   * appended to it; and the agents that wrote it, by what they recorded (a
   * write over MCP, or an agent's hook after an edit of its own), most recent
   * first. Git cannot say which commits those were: they are the person's.
   * Anyone but the owner hears only of itself.
   */
  readonly writes: { readonly commits: number; readonly appends: number; readonly agents: readonly { actor: string; count: number; last: string }[] };
  /** Every principal in access.yaml but the owner, and whether it can see this note. Anyone but the owner hears only of itself. */
  readonly agents: readonly { name: string; canSee: boolean; why: string | null }[];
}

/** What counts as a read here: shown to the person, read or cited by an agent, or put into a recall pack. */
const READS = ['open', 'read', 'recall', 'cite'] as const;
/** Characters of the title given to recall: enough to say what a note is about, and a bounded query. */
const CUE_CHARS = 40;

const round = (value: number): number => Math.round(value * 1000) / 1000;
const rank = (level: Sensitivity): number => SENSITIVITIES.indexOf(level);
const marks = (count: number): string => Array.from({ length: count }, () => '?').join(', ');
const latest = <T>(list: readonly T[], limit: number): T[] => list.slice(Math.max(0, list.length - limit));

/** YYYY-MM-DD of the calendar day a time falls on, where this process runs. */
function localDay(ms: number): string {
  const at = new Date(ms);
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`;
}

/**
 * The title's first words as a cue, up to CUE_CHARS characters, less any
 * Chinese character standing alone. A lone 的 or 与 is a particle, and its
 * prefix query reaches every bigram it starts: on 8,000 notes it made one
 * recall take 60 ms instead of 1, for the same notes. So words are kept
 * whole, and a cut never leaves one character of a run behind.
 */
function cueOf(title: string): string {
  const pieces = queryPieces(title);
  const words = pieces.filter((piece) => !(hasCjk(piece) && [...piece].length === 1));
  const kept: string[] = [];
  let length = -1;
  for (const word of words.length > 0 ? words : pieces) {
    const chars = [...word];
    if (kept.length > 0 && length + 1 + chars.length > CUE_CHARS) break;
    kept.push(chars.slice(0, CUE_CHARS).join(''));
    length += 1 + Math.min(chars.length, CUE_CHARS);
  }
  return kept.join(' ');
}

/** Why a principal cannot see a note it was asked about. */
function whyHidden(principal: Principal, sensitivity: Sensitivity): string {
  if (sensitivity === 'sealed') return 'the note is sealed';
  if (rank(sensitivity) > rank(principal.maxSensitivity)) return `the note is ${sensitivity}`;
  return 'the note is outside the paths it may read';
}

export function about(vault: Vault, ref: string, options: AboutOptions = {}): AboutNote {
  vault.requireVerb('read');
  const note = vault.find(ref);
  if (!note) {
    if (vault.principal.owner) throw new Error(`No note in this vault answers to "${ref}".`);
    // The same words whether the note is hidden or not there, so the answer says nothing about what is hidden.
    throw new AccessError(`No note that ${vault.principal.name} may see answers to "${ref}".`);
  }
  const db = vault.store.db;
  const rel = note.path;
  const now = options.now ?? Date.now();
  // A whole number, so that SQL's LIMIT and the slices below cut every list the same way.
  const limit = options.limit !== undefined && Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 8;
  const owner = vault.principal.owner;
  const weightsAt = Number(vault.store.meta('weights_at') ?? now);
  const visible = (path: string, sensitivity: Sensitivity) => vault.canSee({ path, sensitivity });
  // Another process may have removed the note since find saw it; its values then stand without origins.
  const origins = JSON.parse((db.prepare('SELECT origins FROM notes WHERE path = ?').get(rel) as { origins: string } | undefined)?.origins ?? '{}') as Partial<Origins>;

  // Events and commits name a note where it was then. Walk renames back from
  // where it is now, and keep the old paths the index still sends here: one
  // that a newer file took over is that file's.
  const sentHere = new Set((db.prepare("SELECT key FROM aliases WHERE path = ? AND origin = 'old_path'").all(rel) as { key: string }[]).map((row) => row.key));
  const earlier = sentHere.size === 0 ? [] : (db.prepare(`WITH RECURSIVE back(p) AS (SELECT ? UNION SELECT r.old FROM renames r JOIN back ON r.new = back.p)
    SELECT p FROM back`).all(rel) as { p: string }[]).map((row) => row.p).filter((old) => old !== rel && sentHere.has(aliasKey(old)));
  const paths = [rel, ...earlier];
  const atPaths = `path IN (${marks(paths.length)})`;
  const readVerbs = `verb IN (${marks(READS.length)})`;
  // Who else reads a note, and how they came to it, is the owner's to know. Sums over
  // everyone stay whole, the reads per day and the together weights: heat, recall
  // and suggest already show an agent those.
  const mine = owner ? '' : ' AND actor = ?';
  const me = owner ? [] : [vault.principal.name];

  // What links here: one entry per note, warmest first.
  const linking = new Map<string, { path: string; title: string; relation: string | null; heat: number; reads: number }>();
  for (const row of db.prepare(`SELECT l.src, l.relation, n.title, n.kind, n.sensitivity, h.value, h.reads FROM links l
      JOIN notes n ON n.path = l.src LEFT JOIN heat h ON h.path = l.src WHERE l.resolved = ? AND l.src != ?`).all(rel, rel) as
      { src: string; relation: string | null; title: string; kind: Kind; sensitivity: Sensitivity; value: number | null; reads: number | null }[]) {
    if (!visible(row.src, row.sensitivity)) continue;
    const known = linking.get(row.src);
    if (known) { known.relation ??= row.relation; continue; }
    // Heat as heatOf decays it, for each linking note at once.
    const heat = row.value === null ? 0 : row.value * decay(now - weightsAt, vault.config.halfLife.heat[row.kind]);
    linking.set(row.src, { path: row.src, title: row.title, relation: row.relation, heat: round(heat), reads: row.reads ?? 0 });
  }
  const linksHere = [...linking.values()].sort((left, right) => right.heat - left.heat || left.path.localeCompare(right.path));

  // Names in running text that are not links yet. suggest keeps out what the caller cannot see.
  const named = vault.principal.verbs.has('search') ? suggest(vault, { from: [rel], types: ['mention'] }) : [];
  const namedHere = named.map((item) => ({ id: item.id, to: item.to, title: item.toTitle, score: item.score, around: item.around ?? ['', item.toTitle, ''] as const }));

  // What goes with it: association edges either way round, less the notes that link here.
  const half: Readonly<Record<string, number>> = { visit: vault.config.halfLife.visit, co_change: vault.config.halfLife.coChange };
  const together = (db.prepare(`SELECT e.other, n.title, n.sensitivity, e.type, e.weight, e.count, e.last FROM (
      SELECT b AS other, type, weight, count, last FROM edges WHERE a = ? UNION ALL SELECT a AS other, type, weight, count, last FROM edges WHERE b = ?
    ) e JOIN notes n ON n.path = e.other`).all(rel, rel) as
      { other: string; title: string; sensitivity: Sensitivity; type: string; weight: number; count: number; last: number | null }[])
    .filter((row) => row.other !== rel && !linking.has(row.other) && visible(row.other, row.sensitivity))
    .map((row) => ({
      path: row.other, title: row.title, type: row.type, count: row.count,
      weight: round(row.weight * decay(now - weightsAt, half[row.type] ?? 60)), last: row.last === null ? null : new Date(row.last).toISOString(),
    }))
    .sort((left, right) => right.weight - left.weight || right.count - left.count || left.path.localeCompare(right.path));

  // About the same thing, and not in any list above, shown or not.
  const listed = new Set<string>([rel, ...linking.keys(), ...named.map((item) => item.to), ...together.map((item) => item.path)]);
  const pack = vault.principal.verbs.has('recall') && limit > 0
    ? recall(vault, cueOf(note.title), { from: rel, limit, budget: limit * 900, exclude: [...listed], record: false })
    : null;
  const aboutSame = (pack?.items ?? []).map((item) => ({ path: item.path, title: item.title, why: item.why, excerpt: item.excerpt }));

  const successor = (db.prepare(`SELECT n.path, n.title, n.sensitivity FROM links l JOIN notes n ON n.path = CASE WHEN l.relation = 'supersedes' THEN l.src ELSE l.resolved END
    WHERE (l.resolved = ? AND l.relation = 'supersedes') OR (l.src = ? AND l.relation = 'superseded_by' AND l.resolved IS NOT NULL)`).all(rel, rel) as
      { path: string; title: string; sensitivity: Sensitivity }[]).find((row) => row.path !== rel && visible(row.path, row.sensitivity));

  const links = db.prepare("SELECT target, line, resolved, kind FROM links WHERE src = ? AND kind != 'img' ORDER BY start").all(rel) as
    { target: string; line: number; resolved: string | null; kind: string }[];
  // As status counts them: a path from the disk's root points out of the vault, and is not broken.
  const broken = links.filter((link) => link.resolved === null && !(link.kind === 'md' && link.target.startsWith('/')));

  const days = new Map<string, number>();
  for (const row of db.prepare(`SELECT time FROM events WHERE ${atPaths} AND ${readVerbs} ORDER BY time`).all(...paths, ...READS) as { time: number }[]) {
    const day = localDay(row.time);
    days.set(day, (days.get(day) ?? 0) + 1);
  }
  const readers = (db.prepare(`SELECT actor, count(*) AS n, max(time) AS last FROM events WHERE ${atPaths} AND ${readVerbs}${mine}
    GROUP BY actor ORDER BY n DESC, last DESC LIMIT ?`).all(...paths, ...READS, ...me, limit) as { actor: string; n: number; last: number }[])
    .map((row) => ({ actor: row.actor, count: row.n, last: new Date(row.last).toISOString() }));

  // A note an event came from is named where it was then: say where it is now, and only if the caller can see it.
  // Only a path or an old path counts, never a title that happens to read the same.
  // For the owner, a note that is gone still says how it got here.
  const noteAt = db.prepare('SELECT path, sensitivity FROM notes WHERE path = ?');
  const movedTo = db.prepare("SELECT n.path, n.sensitivity FROM aliases a JOIN notes n ON n.path = a.path WHERE a.key = ? AND a.origin = 'old_path' LIMIT 1");
  const whereNow = (old: string): string | null => {
    const row = (noteAt.get(old) ?? movedTo.get(aliasKey(old))) as { path: string; sensitivity: Sensitivity } | undefined;
    if (row) return visible(row.path, row.sensitivity) ? row.path : null;
    return owner ? old : null;
  };
  const leads = new Map<string, { from: string | null; query: string | null; count: number; last: number }>();
  for (const row of db.prepare(`SELECT from_path, query, count(*) AS n, max(time) AS last FROM events WHERE ${atPaths}
      AND (from_path IS NOT NULL OR query IS NOT NULL)${mine} GROUP BY from_path, query`).all(...paths, ...me) as
      { from_path: string | null; query: string | null; n: number; last: number }[]) {
    const from = row.from_path === null ? null : whereNow(row.from_path);
    if (row.from_path !== null && from === null) continue;
    const key = `${from ?? ''}\0${row.query ?? ''}`;
    const known = leads.get(key);
    if (known) { known.count += row.n; known.last = Math.max(known.last, row.last); } else leads.set(key, { from, query: row.query, count: row.n, last: row.last });
  }
  const leadsHere = [...leads.values()].sort((left, right) => right.count - left.count || right.last - left.last)
    .slice(0, limit).map(({ from, query, count }) => ({ from, query, count }));

  const commits = (db.prepare(`SELECT count(DISTINCT hash) AS n FROM changes WHERE ${atPaths} AND status IN ('A', 'M')`).get(...paths) as { n: number }).n;
  const appends = (db.prepare(`SELECT count(*) AS n FROM events WHERE ${atPaths} AND verb = 'append'`).get(...paths) as { n: number }).n;
  const writers = (db.prepare(`SELECT actor, count(*) AS n, max(time) AS last FROM events WHERE ${atPaths} AND verb IN ('write', 'append') AND actor != 'owner'${mine}
    GROUP BY actor ORDER BY last DESC LIMIT ?`).all(...paths, ...me, limit) as { actor: string; n: number; last: number }[])
    .map((row) => ({ actor: row.actor, count: row.n, last: new Date(row.last).toISOString() }));

  const principals = owner ? vault.access.principals : vault.access.principals.filter((principal) => principal.name === vault.principal.name);
  const agents = principals.map((principal) => {
    const canSee = principal.canSee(rel, note.sensitivity);
    return { name: principal.name, canSee, why: canSee ? null : whyHidden(principal, note.sensitivity) };
  });

  return {
    path: rel,
    title: note.title,
    id: note.id,
    kind: { value: note.kind, from: origins.kind ?? 'default' },
    known: { value: note.source, from: origins.known ?? 'default' },
    sensitivity: { value: note.sensitivity, from: origins.sensitivity ?? 'default' },
    status: note.status,
    tags: note.tags,
    aliases: note.aliases,
    heat: vault.heatOf(rel, now),
    supersededBy: successor ? { path: successor.path, title: successor.title } : null,
    linksHere: linksHere.slice(0, limit),
    linksHereCount: linksHere.length,
    namedHere: namedHere.slice(0, limit),
    namedHereCount: namedHere.length,
    together: together.slice(0, limit),
    togetherCount: together.length,
    aboutSame,
    outgoing: { count: links.length, broken: broken.slice(0, limit).map(({ target, line }) => ({ target, line })), brokenCount: broken.length },
    reads: latest([...days].map(([day, count]) => ({ day, count })), limit),
    readers,
    leadsHere,
    writes: { commits, appends, agents: writers },
    agents,
  };
}
