import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { about } from '../src/about.js';
import { run } from '../src/cli.js';
import { agentActor, EventLog, recordEvents } from '../src/events.js';
import { eventRows } from '../src/indexer.js';
import { recall } from '../src/recall.js';
import { Vault } from '../src/vault.js';

let root: string;
/** Every line written, whichever host wrote it. */
const lines = (): Record<string, unknown>[] => {
  const dir = path.join(root, '.noto', 'events');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((host) => readdirSync(path.join(dir, host)).flatMap((file) =>
    readFileSync(path.join(dir, host, file), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)));
};

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-events-'));
  mkdirSync(path.join(root, '.noto'));
  writeFileSync(path.join(root, 'a.md'), '# Alpha\n\nArgus audits the search indexes.\n');
  writeFileSync(path.join(root, 'b.md'), '# Beta\n\nArgus again, with more on the indexes.\n');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('writing events', () => {
  it('writes what one call did to several notes as one line, and one note as before', () => {
    const at = '2026-11-06T10:00:00.000Z';
    recordEvents(root, [
      { time: at, actor: 'owner', verb: 'recall', path: 'a.md', query: 'argus' },
      { time: at, actor: 'owner', verb: 'recall', path: 'b.md', query: 'argus' },
      { time: at, actor: 'owner', verb: 'open', path: 'a.md' },
    ], 'h');
    expect(lines()).toEqual([
      { time: at, actor: 'owner', verb: 'recall', paths: ['a.md', 'b.md'], query: 'argus' },
      { time: at, actor: 'owner', verb: 'open', path: 'a.md' },
    ]);
  });

  it('leaves a folder that does not keep memory as it is', () => {
    rmSync(path.join(root, '.noto'), { recursive: true });
    expect(recordEvents(root, [{ actor: 'owner', verb: 'open', path: 'a.md' }], 'h')).toBe(false);
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
  });

  it('counts the same event again soon after, and writes the count when the run ends', () => {
    let now = Date.parse('2026-11-06T10:00:00.000Z');
    const log = new EventLog(root, 'h', () => now, 60_000);
    const open = (rel: string) => log.record([{ actor: 'owner', verb: 'open', path: rel, session: 's' }]);
    open('a.md');
    now += 2_000; open('a.md');
    now += 3_000; open('a.md');
    // Written at once, so the index sees the first straight away.
    expect(lines()).toHaveLength(1);
    now += 1_000; open('b.md');
    now += 120_000; open('b.md');
    log.flush();
    expect(lines()).toEqual([
      { time: '2026-11-06T10:00:00.000Z', actor: 'owner', verb: 'open', path: 'a.md', session: 's' },
      { time: '2026-11-06T10:00:02.000Z', actor: 'owner', verb: 'open', path: 'a.md', session: 's', repeat: 2, until: '2026-11-06T10:00:05.000Z' },
      { time: '2026-11-06T10:00:06.000Z', actor: 'owner', verb: 'open', path: 'b.md', session: 's' },
      // Two minutes on is a visit of its own.
      { time: '2026-11-06T10:02:06.000Z', actor: 'owner', verb: 'open', path: 'b.md', session: 's' },
    ]);
  });
});

describe('a run as long as a line may count', () => {
  it('is written when it reaches the most a reader counts, and the next repeat begins a new one', () => {
    let now = Date.parse('2026-11-06T10:00:00.000Z');
    const log = new EventLog(root, 'h', () => now, 60_000);
    for (let at = 0; at < 1002; at += 1) {
      log.record([{ actor: 'codex', verb: 'read', path: 'a.md', session: 's' }]);
      now += 10;
    }
    log.flush();
    expect(lines().map((line) => line.repeat ?? 1)).toEqual([1, 1000, 1]);
  });
});

describe('reading events', () => {
  it('stands a line for each note it names and each time it repeats, spread over its run', () => {
    expect(eventRows({ time: '2026-11-06T10:00:00.000Z', actor: 'codex', verb: 'recall', paths: ['a.md', 'b.md'], query: 'q' }).map((row: { path: string }) => row.path)).toEqual(['a.md', 'b.md']);
    expect(eventRows({ time: '2026-11-06T10:00:00.000Z', verb: 'open', path: 'a.md', repeat: 3, until: '2026-11-06T10:00:10.000Z' }).map((row: { actor: string; time: number }) => [row.actor, row.time]))
      .toEqual([['owner', Date.parse('2026-11-06T10:00:00.000Z')], ['owner', Date.parse('2026-11-06T10:00:05.000Z')], ['owner', Date.parse('2026-11-06T10:00:10.000Z')]]);
    // A line that claims more than any run is cut short, and one without a note is nothing.
    expect(eventRows({ time: '2026-11-06T10:00:00.000Z', verb: 'open', paths: ['a.md', 'b.md'], repeat: 1e9 })).toHaveLength(1000);
    expect(eventRows({ time: '2026-11-06T10:00:00.000Z', verb: 'open' })).toEqual([]);
  });

  it('counts runs and calls in what it says about a note, and reads a log again that was rewritten', async () => {
    const file = path.join(root, '.noto', 'events', 'h', '2026-11.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, [
      { time: '2026-11-05T10:00:00.000Z', actor: 'owner', verb: 'open', path: 'a.md' },
      { time: '2026-11-05T10:00:02.000Z', actor: 'owner', verb: 'open', path: 'a.md', repeat: 2, until: '2026-11-05T10:00:04.000Z' },
      { time: '2026-11-05T11:00:00.000Z', actor: 'owner', verb: 'recall', paths: ['a.md', 'b.md'], query: 'argus' },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const vault = await Vault.open(root, { owner: true });
    try {
      expect(about(vault, 'a.md', {})!.readers).toEqual([{ actor: 'owner', count: 4, last: '2026-11-05T11:00:00.000Z' }]);
      // The same file, as long, with the agent's lines named for the agent: read again from the start.
      writeFileSync(file, readFileSync(file, 'utf8').replace('"owner","verb":"recall"', '"codex","verb":"recall"'));
      vault.refresh();
      expect(about(vault, 'a.md', {})!.readers.map((reader) => [reader.actor, reader.count])).toEqual([['owner', 3], ['codex', 1]]);
      // Another host's file that went away (a checkout without it) takes its lines with it.
      const other = path.join(root, '.noto', 'events', 'other', '2026-11.jsonl');
      mkdirSync(path.dirname(other), { recursive: true });
      writeFileSync(other, `${JSON.stringify({ time: '2026-11-05T12:00:00.000Z', actor: 'owner', verb: 'open', path: 'a.md' })}\n`);
      vault.refresh();
      expect(about(vault, 'a.md', {})!.readers[0]).toMatchObject({ actor: 'owner', count: 4 });
      rmSync(path.dirname(other), { recursive: true });
      vault.refresh();
      expect(about(vault, 'a.md', {})!.readers[0]).toMatchObject({ actor: 'owner', count: 3 });
    } finally {
      vault.close();
    }
  });
});

describe('who an event names', () => {
  it('is the agent that runs the command line, as it says, and otherwise the person', () => {
    expect(agentActor({})).toBeNull();
    expect(agentActor({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'ea01-cb3d' })).toEqual({ actor: 'claude-code', session: 'ea01-cb3d' });
    expect(agentActor({ CODEX_THREAD_ID: 't-9' })).toEqual({ actor: 'codex', session: 't-9' });
    // Named outright, which wins; `owner` says it is the person after all; a name that is not one is ignored.
    expect(agentActor({ NOTO_ACTOR: 'my-script', CLAUDECODE: '1' })).toEqual({ actor: 'my-script' });
    expect(agentActor({ NOTO_ACTOR: 'owner', CLAUDECODE: '1' })).toBeNull();
    expect(agentActor({ NOTO_ACTOR: 'no spaces/here' })).toBeNull();
  });

  it('names the agent for a recall it runs as the person, and an agent with a key by its key', async () => {
    const vault = await Vault.open(root, { owner: true, actor: 'claude-code', session: 'cc1' });
    try {
      recall(vault, 'argus indexes', { limit: 2 });
    } finally {
      vault.close();
    }
    const recalled = lines();
    expect(recalled).toHaveLength(1);
    expect(recalled[0]).toMatchObject({ actor: 'claude-code', verb: 'recall', session: 'cc1', query: 'argus indexes' });
    expect(recalled[0]!.paths ?? [recalled[0]!.path]).toEqual(expect.arrayContaining(['a.md']));
  });
});

describe('noto-vault record', () => {
  const quiet = () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  };
  afterEach(() => { vi.restoreAllMocks(); process.exitCode = undefined; });

  it('records a write by the agent that ran it, in the vault the note is in, and passes over what is not a note there', async () => {
    quiet();
    vi.stubEnv('CLAUDECODE', '1');
    vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'cc2');
    vi.stubEnv('NOTO_SESSION', '');
    vi.stubEnv('NOTO_ACTOR', '');
    const outside = mkdtempSync(path.join(os.tmpdir(), 'noto-outside-'));
    try {
      writeFileSync(path.join(outside, 'loose.md'), '# Loose\n');
      await run(['record', 'write', path.join(root, 'a.md'), path.join(root, 'notes.txt'), path.join(outside, 'loose.md'), path.join(root, '.noto', 'x.md')]);
      expect(process.exitCode).toBe(0);
      expect(lines()).toEqual([expect.objectContaining({ actor: 'claude-code', verb: 'write', path: 'a.md', session: 'cc2' })]);
      expect(existsSync(path.join(outside, '.noto'))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('takes an agent tool hook on stdin as the agent\'s, even with nothing in its environment, and never fails the step', async () => {
    quiet();
    // A hook may not be given the variables the agent's own commands get: the payload is enough.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CODEX_THREAD_ID', '');
    vi.stubEnv('NOTO_SESSION', '');
    vi.stubEnv('NOTO_ACTOR', '');
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    const feed = (text: string) => Object.defineProperty(process, 'stdin', { value: Readable.from([Buffer.from(text)]), configurable: true });
    try {
      feed(JSON.stringify({ session_id: 'cc3', cwd: root, tool_name: 'Edit', tool_input: { file_path: 'b.md', old_string: 'x', new_string: 'y' } }));
      await run(['record', '--hook']);
      feed(JSON.stringify({ session_id: 'cc3', cwd: root, tool_name: 'Read', tool_input: { file_path: path.join(root, 'a.md') } }));
      await run(['record', '--hook']);
      feed(JSON.stringify({ session_id: 'cc3', cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } }));
      await run(['record', '--hook']);
      for (const junk of ['not json', 'null', '[]', '"text"', JSON.stringify({ tool_name: 'Edit', tool_input: null }), JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 7 } })]) {
        feed(junk);
        process.exitCode = undefined;
        await run(['record', '--hook']);
        expect(process.exitCode).toBe(0);
      }
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
    }
    expect(lines().map((line) => [line.actor, line.verb, line.path, line.session])).toEqual([
      ['claude-code', 'write', 'b.md', 'cc3'],
      ['claude-code', 'read', 'a.md', 'cc3'],
    ]);
  });

  it('records nothing while it measures recall', async () => {
    quiet();
    writeFileSync(path.join(root, 'cases.yaml'), '- query: argus indexes\n  expect: [a.md]\n');
    await run(['--root', root, 'eval', path.join(root, 'cases.yaml')]);
    expect(lines()).toEqual([]);
  });
});
