/**
 * Reads, visits and recalls: what git cannot see.
 *
 * One JSON object per line in `.noto/events/<host>/<yyyy-mm>.jsonl`. The
 * files are per host so that two machines syncing a vault never write the
 * same file, and append-only so that a reader can resume from a byte offset.
 * A line is far below the size the system appends atomically, so processes
 * writing at once do not interleave.
 *
 * This module has no dependency on the index, so an editor can record a
 * visit without opening SQLite.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type EventVerb = 'open' | 'read' | 'recall' | 'cite' | 'write' | 'append' | 'propose' | 'accept' | 'reject';

export interface VaultEvent {
  /** ISO 8601; filled in when absent. */
  readonly time?: string;
  /** `owner` for the person, or an agent's principal. */
  readonly actor: string;
  readonly verb: EventVerb;
  /** Vault-relative path. */
  readonly path: string;
  readonly session?: string;
  /** The note this one was reached from, by a link. */
  readonly from?: string;
  /** The cue, for a recall. */
  readonly query?: string;
}

/** A host name that is safe as a folder name. */
export function hostName(): string {
  return os.hostname().replace(/\.local$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase() || 'host';
}

export function eventsDir(root: string): string {
  return path.join(root, '.noto', 'events');
}

function eventFile(root: string, host: string, time: Date): string {
  const month = `${time.getUTCFullYear()}-${String(time.getUTCMonth() + 1).padStart(2, '0')}`;
  return path.join(eventsDir(root), host, `${month}.jsonl`);
}

/** Append events; they all go to the file of the first one's month. */
export function recordEvents(root: string, events: readonly VaultEvent[], host: string = hostName()): void {
  if (events.length === 0) return;
  const now = new Date();
  const lines = events.map((event) => {
    const line: Record<string, string> = { time: event.time ?? now.toISOString(), actor: event.actor, verb: event.verb, path: event.path };
    if (event.session) line.session = event.session;
    if (event.from) line.from = event.from;
    if (event.query) line.query = event.query.slice(0, 500);
    return JSON.stringify(line);
  });
  const file = eventFile(root, host, new Date(events[0]!.time ?? now));
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${lines.join('\n')}\n`, 'utf8');
}

export function recordEvent(root: string, event: VaultEvent, host?: string): void {
  recordEvents(root, [event], host);
}

/** A short random id for a sitting. */
export function newSession(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}
