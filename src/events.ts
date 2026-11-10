/**
 * Reads, visits and recalls: what git cannot see.
 *
 * One JSON object per line in `.noto/events/<host>/<yyyy-mm>.jsonl`. The
 * files are per host so that two machines syncing a vault never write the
 * same file, and append-only so that a reader can resume from a byte offset.
 * A line is far below the size the system appends atomically, so processes
 * writing at once do not interleave.
 *
 * Two things keep the files short. What one call did to several notes at once
 * (a recall that returns eight) is one line with `paths`. And the same event
 * again soon after (a note opened again with nothing opened between) is
 * counted rather than written again: `EventLog` writes the first at once, so
 * the index sees it straight away, and the rest of the run as one line with
 * `repeat` once the run ends. Nothing already written is ever changed.
 *
 * Every event names who caused it. The person is `owner`; an agent is its
 * principal when it connects with a key, or, when it runs the command line
 * on the person's behalf, the name `agentActor` finds for it, so what an
 * agent did is never counted as the person's reading.
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
  /** `owner` for the person, or an agent's name. */
  readonly actor: string;
  readonly verb: EventVerb;
  /** Vault-relative path. */
  readonly path: string;
  readonly session?: string;
  /** The note this one was reached from, by a link. */
  readonly from?: string;
  /** The cue, for a recall. */
  readonly query?: string;
  /** The proposal a `propose`, `accept` or `reject` is about. */
  readonly proposal?: string;
  /** Who made the proposal, on an `accept` or `reject`: its git author, read before the proposal goes. */
  readonly author?: string;
  /** Why the person decided as they did, in a word or a few, as they gave it. */
  readonly reason?: string;
  /** How long the person looked at it before deciding, in milliseconds, as they measured it. */
  readonly reviewMs?: number;
  /** The same event this many times in a row, the first at `time` and the last at `until`; one when absent. */
  readonly repeat?: number;
  readonly until?: string;
}

/** A name for an actor or a principal: what a folder name and a YAML key both take. */
export const ACTOR_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** The same event again within this long of the last of its run is counted on the run's line. */
export const REPEAT_MS = 60_000;

/** The most rows one line stands for, its notes times its run: a reader cuts a line claiming more, so a writer never writes one. */
export const EVENT_LINE_MAX = 1000;

/** The most characters of a decision's reason a line keeps. */
export const REASON_MAX = 200;

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

/** Everything but the path: events alike in this share a line. */
const sameCall = (left: VaultEvent, right: VaultEvent): boolean =>
  left.time === right.time && left.actor === right.actor && left.verb === right.verb && left.session === right.session
  && left.from === right.from && left.query === right.query && left.repeat === right.repeat && left.until === right.until
  && left.proposal === right.proposal && left.author === right.author && left.reason === right.reason && left.reviewMs === right.reviewMs;

function lineOf(events: readonly VaultEvent[], now: string): string {
  const first = events[0]!;
  const line: Record<string, unknown> = { time: first.time ?? now, actor: first.actor, verb: first.verb };
  if (events.length === 1) line.path = first.path;
  else line.paths = events.map((event) => event.path);
  if (first.session) line.session = first.session;
  if (first.from) line.from = first.from;
  if (first.query) line.query = first.query.slice(0, 500);
  if (first.proposal) line.proposal = first.proposal;
  if (first.author) line.author = first.author;
  if (first.reason) line.reason = first.reason.slice(0, REASON_MAX);
  if (first.reviewMs !== undefined && Number.isFinite(first.reviewMs) && first.reviewMs >= 0) line.reviewMs = Math.round(first.reviewMs);
  if (first.repeat !== undefined && first.repeat > 1) {
    line.repeat = Math.floor(first.repeat);
    if (first.until) line.until = first.until;
  }
  return JSON.stringify(line);
}

/**
 * Append events; they all go to the file of the first one's month. Events
 * next to each other that differ only in their path are one line. A folder
 * that does not keep memory (it has no `.noto/`) is left as it is: false.
 */
export function recordEvents(root: string, events: readonly VaultEvent[], host: string = hostName()): boolean {
  if (events.length === 0) return true;
  const now = new Date().toISOString();
  const lines: string[] = [];
  let run: VaultEvent[] = [];
  for (const event of events) {
    if (run.length > 0 && !sameCall(run[0]!, event)) {
      lines.push(lineOf(run, now));
      run = [];
    }
    run.push(event);
  }
  lines.push(lineOf(run, now));
  const file = eventFile(root, host, new Date(events[0]!.time ?? now));
  const text = `${lines.join('\n')}\n`;
  // One call when the folders are there, as they are after the first line; an editor does this on every open.
  try {
    appendFileSync(file, text, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Each folder made only inside one that is there, so a .noto taken away a moment ago is never made anew.
  if (!folderIn(eventsDir(root)) || !folderIn(path.dirname(file))) return false;
  appendFileSync(file, text, 'utf8');
  return true;
}

/** Make a folder that may be there already; false when its parent is not, so a `.noto` taken away is never made anew. */
export function folderIn(dir: string): boolean {
  try {
    mkdirSync(dir);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return true;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
}

export function recordEvent(root: string, event: VaultEvent, host?: string): boolean {
  return recordEvents(root, [event], host);
}

/** A short random id for a sitting. */
export function newSession(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * Who is running this process on the person's behalf, when it is not the
 * person: `NOTO_ACTOR` when set (`owner` says it is the person), else an
 * agent that says so in the environment it gives its commands. Claude Code
 * sets `CLAUDECODE`, and Codex `CODEX_THREAD_ID`; each sitting of either is
 * one session. Null for the person at a terminal.
 */
export function agentActor(env: NodeJS.ProcessEnv = process.env): { actor: string; session?: string } | null {
  const named = env.NOTO_ACTOR?.trim();
  if (named) {
    if (named === 'owner' || !ACTOR_NAME.test(named)) return null;
    return { actor: named };
  }
  const sitting = (value: string | undefined) => (value && /^[A-Za-z0-9._:-]{1,80}$/.test(value) ? { session: value } : {});
  if (env.CLAUDECODE === '1') return { actor: 'claude-code', ...sitting(env.CLAUDE_CODE_SESSION_ID) };
  if (env.CODEX_THREAD_ID) return { actor: 'codex', ...sitting(env.CODEX_THREAD_ID) };
  return null;
}

interface Run {
  readonly key: string;
  readonly event: VaultEvent;
  readonly paths: readonly string[];
  /** Seen again after the first, which was written when it came. */
  more: number;
  firstMore: number;
  last: number;
}

const live = new Set<EventLog>();
let exitHooked = false;

/**
 * A writer for a process that lives a while (an editor, a server): each event
 * is written when it comes, except one that repeats the last exactly (same
 * actor, verb, paths, session, link and cue) within `REPEAT_MS` of it, which
 * is counted. The count is written when a different event comes, when a
 * minute passes without another, on `flush`, and when the process exits.
 */
export class EventLog {
  private run: Run | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly root: string,
    private readonly host: string = hostName(),
    private readonly clock: () => number = Date.now,
    private readonly repeatMs: number = REPEAT_MS,
  ) {}

  /** Record what one call did to `events` (alike but for their paths); false when the folder does not keep memory. */
  record(events: readonly VaultEvent[]): boolean {
    if (events.length === 0) return true;
    const now = this.clock();
    const first = events[0]!;
    const key = JSON.stringify([first.actor, first.verb, first.session ?? '', first.from ?? '', first.query ?? '', first.proposal ?? '', first.author ?? '',
      first.reason ?? '', first.reviewMs ?? '', events.map((event) => event.path)]);
    if (this.run && this.run.key === key && now - this.run.last <= this.repeatMs) {
      if (this.run.more === 0) this.run.firstMore = now;
      this.run.more += 1;
      this.run.last = now;
      // A run as long as a line may count is written, and the next repeat begins a new one.
      if (this.run.more >= Math.floor(EVENT_LINE_MAX / this.run.paths.length)) this.flush();
      else this.arm();
      return true;
    }
    this.flush();
    const time = new Date(now).toISOString();
    const written = recordEvents(this.root, events.map((event) => ({ ...event, time: event.time ?? time })), this.host);
    if (!written) return false;
    this.run = { key, event: { ...first, time }, paths: events.map((event) => event.path), more: 0, firstMore: now, last: now };
    this.arm();
    return true;
  }

  /** Write the count of the run so far, if it repeated, and start afresh. */
  flush(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const run = this.run;
    this.run = null;
    live.delete(this);
    if (!run || run.more === 0) return;
    const { event } = run;
    const repeated = { ...event, time: new Date(run.firstMore).toISOString(), repeat: run.more, until: new Date(run.last).toISOString() };
    try {
      recordEvents(this.root, run.paths.map((rel) => ({ ...repeated, path: rel })), this.host);
    } catch {
      // A disk that went read-only forgets the count, as it would the event.
    }
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.repeatMs);
    this.timer.unref?.();
    live.add(this);
    if (!exitHooked) {
      exitHooked = true;
      process.once('exit', () => { for (const log of [...live]) log.flush(); });
    }
  }
}
