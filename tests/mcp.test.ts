import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { keyHash } from '../src/access.js';
import { serve } from '../src/mcp.js';
import { Vault } from '../src/vault.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'noto-mcp-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  mkdirSync(path.join(root, 'notes'));
  mkdirSync(path.join(root, '.noto'));
  writeFileSync(path.join(root, 'notes', 'argus.md'), '# Argus\n\nThe audit service; its index names carry a date.\n');
  writeFileSync(path.join(root, '.noto', 'access.yaml'), `principals:\n  agent:\n    keys: [${keyHash('k')}]\n    append: ["inbox/**"]\n    verbs: [read, search, recall, append, propose]\n`);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Send lines to a server and collect its answers by id. */
async function talk(vault: Vault, messages: object[]): Promise<Map<unknown, Record<string, any>>> {
  const input = new PassThrough();
  const output = new PassThrough();
  let buffer = '';
  output.on('data', (chunk) => { buffer += chunk.toString('utf8'); });
  const done = serve(vault, { input, output });
  for (const message of messages) input.write(`${JSON.stringify(message)}\n`);
  input.end();
  await done;
  const answers = new Map<unknown, Record<string, any>>();
  for (const line of buffer.split('\n').filter(Boolean)) {
    const answer = JSON.parse(line) as Record<string, any>;
    answers.set(answer.id, answer);
  }
  return answers;
}

const META = { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } };

describe('the vault over MCP', () => {
  it('answers a legacy client\'s handshake and its calls', async () => {
    const vault = await Vault.open(root, { key: 'k' });
    try {
      const answers = await talk(vault, [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'old', version: '1' } } },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'recall', arguments: { cue: 'audit index names' } } },
      ]);
      expect(answers.get(1)!.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'noto-vault' } });
      expect(answers.get(2)!.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['recall', 'search', 'read', 'append', 'propose']);
      expect(answers.get(3)!.result.isError).toBe(false);
      expect(answers.get(3)!.result.content[0].text).toContain('notes/argus.md');
      expect(answers.size).toBe(3);
    } finally {
      vault.close();
    }
  });

  it('serves a modern client statelessly, with discovery and version errors', async () => {
    const vault = await Vault.open(root, { key: 'k' });
    try {
      const answers = await talk(vault, [
        { jsonrpc: '2.0', id: 'd', method: 'server/discover', params: META },
        { jsonrpc: '2.0', id: 's', method: 'tools/call', params: { ...META, name: 'search', arguments: { query: 'audit' } } },
        { jsonrpc: '2.0', id: 'v', method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } } },
        { jsonrpc: '2.0', id: 'w', method: 'tools/call', params: { ...META, name: 'write', arguments: { path: 'notes/argus.md', content: 'x', base_hash: null } } },
        { jsonrpc: '2.0', id: 'e', method: 'tools/call', params: { ...META, name: 'append', arguments: { text: 'hello', to: 'notes/argus.md' } } },
      ]);
      expect(answers.get('d')!.result).toMatchObject({ resultType: 'complete', supportedVersions: expect.arrayContaining(['2026-07-28', '2025-11-25']) });
      expect(answers.get('s')!.result.structuredContent.hits[0].path).toBe('notes/argus.md');
      expect(answers.get('v')!.error).toMatchObject({ code: -32022, data: { requested: '1900-01-01' } });
      // A verb the key does not grant is not a tool at all; a scope it does not grant is a tool error.
      expect(answers.get('w')!.error.code).toBe(-32602);
      expect(answers.get('e')!.result).toMatchObject({ isError: true });
      expect(answers.get('e')!.result.content[0].text).toMatch(/may not append/);
    } finally {
      vault.close();
    }
  });
});

describe('a folder that stops keeping memory', () => {
  /** Two searches by an agent without a key, with .noto taken away between them. */
  async function before_and_after(): Promise<Record<string, any>[]> {
    const vault = await Vault.open(root, {});
    const input = new PassThrough();
    const output = new PassThrough();
    const answers: Record<string, any>[] = [];
    let waiting: (() => void) | null = null;
    let buffer = '';
    output.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines.filter(Boolean)) answers.push(JSON.parse(line));
      waiting?.();
    });
    const next = (count: number) => new Promise<void>((resolve) => { waiting = () => { if (answers.length >= count) resolve(); }; waiting(); });
    const done = serve(vault, { input, output, reopen: () => Vault.open(root, {}) });
    const search = (id: number) => input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { ...META, name: 'search', arguments: { query: 'audit' } } })}\n`);
    try {
      search(1);
      await next(1);
      rmSync(path.join(root, '.noto'), { recursive: true, force: true });
      search(2);
      await next(2);
    } finally {
      input.end();
      await done;
      vault.close();
    }
    return answers;
  }

  it('is not served once its .noto is taken away', async () => {
    const [first, second] = await before_and_after();
    expect(first!.result.isError).toBe(false);
    expect(second!.result.isError).toBe(true);
    expect(second!.result.content[0].text).toMatch(/no longer keeps memory/);
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
  });

  it('does not give an agent that was turned off its reading back, or make .noto anew', async () => {
    writeFileSync(path.join(root, '.noto', 'access.yaml'), 'principals:\n  default:\n    read: []\n    verbs: []\n');
    const [first, second] = await before_and_after();
    expect(first!.result?.isError ?? true).toBe(true);
    expect(second!.result?.isError ?? true).toBe(true);
    expect(existsSync(path.join(root, '.noto'))).toBe(false);
  });
});
