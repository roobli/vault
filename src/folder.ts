/**
 * What the vault knows about one folder, for a pane beside it in an editor:
 * how many notes it holds, which are warmest and which are read most, which
 * no note links to and link nowhere themselves, and how many of its links
 * are broken. It asks the index by the folder's prefix in a few queries and
 * never reads a note's text, so a folder of thousands answers at once. What
 * the folder's history is, git says, not this. Nothing here records an event.
 */

import type { Kind } from './config.js';
import { decay } from './memory.js';
import type { Vault } from './vault.js';

export interface FolderNote {
  readonly path: string;
  readonly title: string;
  /** Warmth now: reads and writes, each fading by its kind's half-life. */
  readonly heat: number;
  readonly reads: number;
  readonly lastRead: string | null;
}

export interface FolderAbout {
  /** As asked, without a trailing `/`; `''` is the whole vault. */
  readonly folder: string;
  readonly notes: number;
  readonly warmest: readonly FolderNote[];
  readonly mostRead: readonly FolderNote[];
  /** Notes no other note links to and that link to no note: the ones nothing leads to or from. */
  readonly orphans: { readonly count: number; readonly items: readonly FolderNote[] };
  /** Links in the folder's notes that name nothing in the vault. */
  readonly broken: number;
}

export interface FolderAboutOptions {
  /** The time heat is decayed to, in milliseconds; now by default. */
  readonly now?: number;
  /** Items per list, default 8. */
  readonly limit?: number;
}

interface Row {
  path: string;
  title: string;
  kind: Kind;
  sensitivity: 'open' | 'private' | 'sealed';
  value: number | null;
  reads: number | null;
  last_read: number | null;
}

/** A LIKE pattern for every path under `folder`, with LIKE's own characters taken literally. */
function under(folder: string): string {
  return folder === '' ? '%' : `${folder.replace(/[\\%_]/g, (ch) => `\\${ch}`)}/%`;
}

export function folderAbout(vault: Vault, folder: string, options: FolderAboutOptions = {}): FolderAbout {
  vault.requireVerb('read');
  const name = folder.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  const limit = options.limit ?? 8;
  const now = options.now ?? Date.now();
  const db = vault.store.db;
  const pattern = under(name);
  const rows = (db.prepare(`SELECT n.path, n.title, n.kind, n.sensitivity, h.value, h.reads, h.last_read
    FROM notes n LEFT JOIN heat h ON h.path = n.path WHERE n.path LIKE ? ESCAPE '\\'`).all(pattern) as unknown as Row[])
    .filter((row) => vault.canSee(row));
  const at = Number(vault.store.meta('weights_at') ?? now);
  const notes: FolderNote[] = rows.map((row) => ({
    path: row.path,
    title: row.title,
    heat: (row.value ?? 0) * decay(now - at, vault.config.halfLife.heat[row.kind]),
    reads: row.reads ?? 0,
    lastRead: row.last_read === null ? null : new Date(row.last_read).toISOString(),
  }));
  const seen = new Set(notes.map((note) => note.path));
  const byPath = new Map(notes.map((note) => [note.path, note]));

  const linked = new Set<string>();
  for (const row of db.prepare(`SELECT DISTINCT src, resolved FROM links WHERE resolved IS NOT NULL AND kind != 'img'
    AND (src LIKE ? ESCAPE '\\' OR resolved LIKE ? ESCAPE '\\')`).all(pattern, pattern) as { src: string; resolved: string }[]) {
    if (row.src === row.resolved) continue;
    linked.add(row.src);
    linked.add(row.resolved);
  }
  const orphans = notes.filter((note) => !linked.has(note.path)).sort((left, right) => left.path.localeCompare(right.path));

  const broken = (db.prepare(`SELECT src FROM links WHERE resolved IS NULL AND kind != 'img'
    AND NOT (kind = 'md' AND target LIKE '/%') AND src LIKE ? ESCAPE '\\'`).all(pattern) as { src: string }[])
    .filter((row) => seen.has(row.src)).length;

  const top = (score: (note: FolderNote) => number) => notes.filter((note) => score(note) > 0)
    .sort((left, right) => score(right) - score(left) || left.path.localeCompare(right.path)).slice(0, limit);
  return {
    folder: name,
    notes: notes.length,
    warmest: top((note) => note.heat),
    mostRead: top((note) => note.reads),
    orphans: { count: orphans.length, items: orphans.slice(0, limit).map((note) => byPath.get(note.path)!) },
    broken,
  };
}
