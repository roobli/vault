/**
 * The index: one SQLite file in `.noto/`, a cache of what the files, git and
 * the event logs say. Delete it and the next refresh rebuilds it. A schema
 * change bumps `SCHEMA_VERSION`, which makes the next open start over.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files(path TEXT PRIMARY KEY, note INTEGER NOT NULL, size INTEGER NOT NULL, mtime INTEGER NOT NULL);
CREATE TABLE notes(
  nid INTEGER PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  id TEXT,
  kind TEXT NOT NULL,
  source TEXT,
  sensitivity TEXT NOT NULL,
  status TEXT,
  date TEXT,
  chars INTEGER NOT NULL,
  frontmatter TEXT NOT NULL,
  headings TEXT NOT NULL,
  tags TEXT NOT NULL,
  aliases TEXT NOT NULL
);
CREATE INDEX notes_id ON notes(id);
CREATE TABLE links(
  src TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL,
  anchor TEXT NOT NULL,
  label TEXT,
  relation TEXT,
  line INTEGER NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  resolved TEXT,
  ambiguous INTEGER NOT NULL DEFAULT 0,
  via TEXT
);
CREATE INDEX links_src ON links(src);
CREATE INDEX links_resolved ON links(resolved);
CREATE TABLE aliases(key TEXT NOT NULL, path TEXT NOT NULL, origin TEXT NOT NULL);
CREATE INDEX aliases_key ON aliases(key);
CREATE INDEX aliases_path ON aliases(path);
CREATE TABLE renames(old TEXT NOT NULL, new TEXT NOT NULL, time INTEGER NOT NULL, origin TEXT NOT NULL);
CREATE INDEX renames_old ON renames(old);
CREATE VIRTUAL TABLE fts USING fts5(title, path, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TABLE commits(hash TEXT PRIMARY KEY, time INTEGER NOT NULL, author TEXT NOT NULL, subject TEXT NOT NULL, files INTEGER NOT NULL);
CREATE TABLE changes(hash TEXT NOT NULL, time INTEGER NOT NULL, author TEXT NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, old TEXT);
CREATE INDEX changes_path ON changes(path);
CREATE INDEX changes_hash ON changes(hash);
CREATE UNIQUE INDEX changes_once ON changes(hash, path);
CREATE TABLE events(time INTEGER NOT NULL, actor TEXT NOT NULL, verb TEXT NOT NULL, path TEXT NOT NULL, session TEXT, from_path TEXT, query TEXT);
CREATE INDEX events_path ON events(path);
CREATE TABLE event_files(file TEXT PRIMARY KEY, offset INTEGER NOT NULL);
CREATE TABLE heat(path TEXT PRIMARY KEY, value REAL NOT NULL, reads INTEGER NOT NULL, writes INTEGER NOT NULL, last_read INTEGER, last_write INTEGER);
CREATE TABLE edges(a TEXT NOT NULL, b TEXT NOT NULL, type TEXT NOT NULL, weight REAL NOT NULL, count INTEGER NOT NULL, last INTEGER NOT NULL, PRIMARY KEY(a, b, type)) WITHOUT ROWID;
CREATE INDEX edges_b ON edges(b);
`;

export function indexPath(root: string): string {
  return path.join(root, '.noto', 'index.sqlite');
}

export class Store {
  readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open the index, creating or recreating it when its schema is not this version's. */
  static open(file: string): Store {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    const db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;');
    const store = new Store(db);
    let version = 0;
    try {
      const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
      version = row ? Number(row.value) : 0;
    } catch {
      version = 0;
    }
    if (version !== SCHEMA_VERSION) store.reset();
    return store;
  }

  /** Drop everything and lay down the schema. */
  reset(): void {
    const tables = this.db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'fts_%'").all() as { name: string; type: string }[];
    this.db.exec('BEGIN');
    try {
      for (const table of tables) this.db.exec(`DROP ${table.type === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS "${table.name}"`);
      this.db.exec(SCHEMA);
      this.db.prepare("INSERT INTO meta(key, value) VALUES ('schema', ?)").run(String(SCHEMA_VERSION));
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  meta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Run `work` in one transaction. */
  transaction<T>(work: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }
}
