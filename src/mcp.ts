/**
 * The vault as an MCP server over stdio.
 *
 * Dual-era: a client that opens with `initialize` (protocol 2025-11-25 and
 * earlier) gets the handshake; a client that sends per-request `_meta`
 * (2026-07-28) is served statelessly, and `server/discover` answers either.
 * Messages are one JSON-RPC object per line. The tools are the eight verbs,
 * listed only as far as the principal may use them. Nothing but protocol
 * messages goes to stdout.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { Verb } from './access.js';
import { formatRead, formatRecall, formatSearch } from './format.js';
import { recall } from './recall.js';
import type { Vault } from './vault.js';

const MODERN = ['2026-07-28'];
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SUPPORTED = [...MODERN, ...LEGACY];
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const SERVER_INFO = { name: 'noto-vault', version: '0.1.0' };

const INSTRUCTIONS = [
  'A vault of Markdown notes kept as long-term memory. Notes are files; links are [[wiki links]].',
  'Start with recall: give it the task or question as a cue and it returns the notes most likely to matter, with where each came from and why.',
  'Use search for exact words, read for a whole note (it returns the hash to write against).',
  'Prefer propose over write: a proposal waits for the person to accept it. Append adds a dated entry to a log note.',
  'Cite notes by path. Notes marked heard are second-hand; lived and seen are the person\'s own.',
].join(' ');

interface Tool {
  readonly verb: Verb;
  readonly description: string;
  readonly properties: Record<string, unknown>;
  readonly required: readonly string[];
  readonly readOnly: boolean;
}

const TOOLS: Readonly<Record<string, Tool>> = {
  recall: {
    verb: 'recall', readOnly: true,
    description: 'The notes most likely to matter for a task or question, packed to a budget, each with its path, kind, source and why it was chosen. Call this first.',
    properties: {
      cue: { type: 'string', description: 'The task, question or topic, in the words you would use.' },
      from: { type: 'string', description: 'A note you are already in; its neighbours count.' },
      budget: { type: 'integer', description: 'Characters of excerpt to return (default 6000).', minimum: 500, maximum: 40000 },
    },
    required: ['cue'],
  },
  search: {
    verb: 'search', readOnly: true,
    description: 'Full-text search over the vault, Chinese by two-character words. Returns titles, paths and a snippet.',
    properties: {
      query: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
      kind: { type: 'string', enum: ['log', 'note', 'card', 'decision'] },
      folder: { type: 'string', description: 'Only notes under this folder.' },
    },
    required: ['query'],
  },
  read: {
    verb: 'read', readOnly: true,
    description: 'One note in full, by path, id, alias or unique name, with its hash, links in and out, and how often it is used.',
    properties: { ref: { type: 'string' } },
    required: ['ref'],
  },
  append: {
    verb: 'append', readOnly: false,
    description: 'Add a dated entry to the end of a log note (today\'s inbox log unless `to` names one).',
    properties: { text: { type: 'string' }, to: { type: 'string', description: 'A log note path within your append scope.' } },
    required: ['text'],
  },
  propose: {
    verb: 'propose', readOnly: false,
    description: 'Propose changes to notes for the person to review; nothing on disk changes until they accept. Give each file\'s full new text, or null to delete it.',
    properties: {
      message: { type: 'string', description: 'What the change is and why, in one or two sentences.' },
      changes: {
        type: 'array', minItems: 1,
        items: { type: 'object', properties: { path: { type: 'string' }, content: { type: ['string', 'null'] } }, required: ['path', 'content'] },
      },
    },
    required: ['message', 'changes'],
  },
  write: {
    verb: 'write', readOnly: false,
    description: 'Replace a note within your write scope, given the hash `read` returned (null to create a new note).',
    properties: { path: { type: 'string' }, content: { type: 'string' }, base_hash: { type: ['string', 'null'] } },
    required: ['path', 'content', 'base_hash'],
  },
  link: {
    verb: 'link', readOnly: false,
    description: 'Add a typed relation line from one note to another (part_of, supports, contradicts, depends_on, derived_from, example_of, related).',
    properties: { from: { type: 'string' }, to: { type: 'string' }, relation: { type: 'string' } },
    required: ['from', 'to'],
  },
  supersede: {
    verb: 'supersede', readOnly: false,
    description: 'Mark an old note as superseded by a newer one, linking both ways, so recall prefers the newer.',
    properties: { old: { type: 'string' }, new: { type: 'string' } },
    required: ['old', 'new'],
  },
};

type Json = Record<string, unknown>;

export function toolList(vault: Vault): Json[] {
  return Object.entries(TOOLS)
    .filter(([, tool]) => vault.principal.verbs.has(tool.verb))
    .map(([name, tool]) => ({
      name,
      description: tool.description,
      inputSchema: { type: 'object', properties: tool.properties, required: tool.required, additionalProperties: false },
      annotations: { readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly && tool.verb === 'write', openWorldHint: false },
    }));
}

const str = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim() === '') throw new ToolInputError(`${name} must be a non-empty string.`);
  return value;
};
const optStr = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value : undefined);
const optNum = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

class ToolInputError extends Error {}

/** Run one tool; text for the model and structured content for the client. */
export function callTool(vault: Vault, name: string, args: Json): { text: string; structured: unknown } {
  const tool = TOOLS[name];
  if (!tool) throw new ToolInputError(`There is no tool named ${name}.`);
  vault.requireVerb(tool.verb);
  switch (name) {
    case 'recall': {
      const budget = optNum(args.budget);
      const from = optStr(args.from);
      const pack = recall(vault, str(args.cue, 'cue'), { ...(budget ? { budget } : {}), ...(from ? { from } : {}) });
      return { text: formatRecall(pack), structured: pack };
    }
    case 'search': {
      const limit = optNum(args.limit);
      const kind = optStr(args.kind) as 'log' | 'note' | 'card' | 'decision' | undefined;
      const folder = optStr(args.folder);
      const hits = vault.search(str(args.query, 'query'), { ...(limit ? { limit } : {}), ...(kind ? { kind } : {}), ...(folder ? { folder } : {}) });
      return { text: formatSearch(hits), structured: { hits } };
    }
    case 'read': {
      const note = vault.read(str(args.ref, 'ref'));
      return { text: formatRead(note), structured: { ...note, text: undefined } };
    }
    case 'append': {
      const to = optStr(args.to);
      const result = vault.append(str(args.text, 'text'), to ? { to } : {});
      return { text: `Appended to ${result.path}.`, structured: result };
    }
    case 'propose': {
      if (!Array.isArray(args.changes) || args.changes.length === 0) throw new ToolInputError('changes must be a non-empty list.');
      const changes = args.changes.map((change: unknown) => {
        const item = change as Json;
        if (item.content !== null && typeof item.content !== 'string') throw new ToolInputError('Each change needs content: the new text, or null.');
        return { path: str(item.path, 'path'), content: item.content as string | null };
      });
      const result = vault.propose(changes, str(args.message, 'message'));
      return { text: `Proposed ${result.files.length} file${result.files.length === 1 ? '' : 's'} as ${result.id}; the person reviews it before anything changes.`, structured: result };
    }
    case 'write': {
      const base = args.base_hash === null ? null : str(args.base_hash, 'base_hash');
      const result = vault.write(str(args.path, 'path'), typeof args.content === 'string' ? args.content : str(args.content, 'content'), base);
      return { text: `Wrote ${result.path}; its hash is now ${result.hash}.`, structured: result };
    }
    case 'link': {
      const result = vault.link(str(args.from, 'from'), str(args.to, 'to'), optStr(args.relation) ?? 'related');
      return { text: `Linked from ${result.path}.`, structured: result };
    }
    case 'supersede': {
      const result = vault.supersede(str(args.old, 'old'), str(args.new, 'new'));
      return { text: `Marked ${result.paths[1]} as superseded by ${result.paths[0]}.`, structured: result };
    }
    default:
      throw new ToolInputError(`There is no tool named ${name}.`);
  }
}

export interface ServeOptions {
  readonly input?: NodeJS.ReadableStream;
  readonly output?: NodeJS.WritableStream;
  /** Refresh the index before a call when the last refresh is older than this. */
  readonly refreshAfterMs?: number;
  /**
   * Open the vault again, under the access policy, config and scripts as they
   * are now. Called when one of them changed, so a revoked key or a tightened
   * policy holds without a restart.
   */
  readonly reopen?: () => Promise<Vault>;
}

/** Serve until stdin closes. */
export function serve(initial: Vault, options: ServeOptions = {}): Promise<void> {
  let vault = initial;
  let broken: string | null = null;
  /**
   * The folder's `.noto` is gone: it stopped keeping memory (Noto's Turn Off
   * moves it to the Trash). Nothing is served then, and the vault is not
   * opened again, which would make `.noto` anew under no policy at all and
   * give an agent without a key every open note, one that had been turned off
   * among them. Putting `.noto` back serves again.
   */
  let gone = false;
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const refreshAfter = options.refreshAfterMs ?? 2000;
  let refreshedAt = Date.now();
  const send = (message: Json) => output.write(`${JSON.stringify(message)}\n`);
  const reply = (id: unknown, result: Json) => send({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } });
  const fail = (id: unknown, code: number, message: string, data?: unknown) =>
    send({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });

  const handle = (message: Json) => {
    const id = message.id;
    const method = typeof message.method === 'string' ? message.method : '';
    const params = (message.params && typeof message.params === 'object' ? message.params : {}) as Json;
    const isRequest = id !== undefined && id !== null;
    if (!isRequest) return; // Notifications need no answer: initialized, cancelled, progress.
    const meta = (params._meta && typeof params._meta === 'object' ? params._meta : {}) as Json;
    const requested = meta[VERSION_KEY];
    if (typeof requested === 'string' && !SUPPORTED.includes(requested)) {
      fail(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested });
      return;
    }
    switch (method) {
      case 'initialize': {
        const asked = typeof params.protocolVersion === 'string' ? params.protocolVersion : LEGACY[0]!;
        reply(id, { protocolVersion: LEGACY.includes(asked) ? asked : LEGACY[0], capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
        return;
      }
      case 'server/discover':
        reply(id, { supportedVersions: SUPPORTED, capabilities: { tools: {} }, _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO }, instructions: INSTRUCTIONS });
        return;
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, { tools: toolList(vault) });
        return;
      case 'tools/call': {
        const name = typeof params.name === 'string' ? params.name : '';
        if (!TOOLS[name] || !vault.principal.verbs.has(TOOLS[name]!.verb)) {
          fail(id, -32602, `Unknown tool: ${name}`);
          return;
        }
        try {
          if (gone) throw new Error('This folder no longer keeps memory: its .noto folder was removed. Nothing is served until it keeps memory again.');
          if (broken) throw new Error(broken);
          if (Date.now() - refreshedAt > refreshAfter) { vault.refresh(); refreshedAt = Date.now(); }
          const result = callTool(vault, name, (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Json);
          reply(id, { content: [{ type: 'text', text: result.text }], structuredContent: result.structured, isError: false });
          if (!TOOLS[name]!.readOnly) refreshedAt = Date.now();
        } catch (error) {
          reply(id, { content: [{ type: 'text', text: (error as Error).message }], isError: true });
        }
        return;
      }
      default:
        fail(id, -32601, `Method not found: ${method}`);
    }
  };

  /** Before a call: when the policy changed, serve under the new one, or refuse if the key no longer counts. */
  const recheck = async () => {
    gone = !existsSync(path.join(vault.root, '.noto'));
    if (gone || !options.reopen || !vault.stale()) return;
    try {
      const next = await options.reopen();
      vault.close();
      vault = next;
      broken = null;
    } catch (error) {
      broken = `The vault's access policy changed and this server can no longer serve: ${(error as Error).message}`;
    }
  };

  // One message at a time, in order: a reopen must finish before the next call reads the vault.
  let queue: Promise<void> = Promise.resolve();
  return new Promise((resolve) => {
    const lines = createInterface({ input, crlfDelay: Infinity });
    lines.on('close', () => {
      void queue.then(() => {
        // The vault this server opened again is its own to close; the first is the caller's.
        if (vault !== initial) vault.close();
        resolve();
      });
    });
    lines.on('line', (line) => { queue = queue.then(() => receive(line)); });
  });

  async function receive(line: string): Promise<void> {
    if (!line.trim()) return;
    {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        fail(null, -32700, 'Parse error');
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        fail(null, -32600, 'Invalid request: one JSON-RPC object per line');
        return;
      }
      const message = parsed as Json;
      try {
        if (message.method === 'tools/call') await recheck();
        handle(message);
      } catch (error) {
        fail(message.id ?? null, -32603, (error as Error).message);
      }
    }
  }
}
