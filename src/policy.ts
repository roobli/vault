/**
 * Changing `.noto/access.yaml` from an editor: adding an agent with a key,
 * taking its key back, and saying how private a folder is.
 *
 * The file is the person's, often with comments, so it is changed line by
 * line where the change is and left as it was everywhere else, rather than
 * read in and written back out. What these write is what `access.ts` reads;
 * a running MCP server notices the file changed and reads it again before
 * its next answer, so a key taken back stops working on the agent's next
 * request.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accessPath, keyHash, parseAccess, SENSITIVITIES, type Sensitivity } from './access.js';
import { parseYamlMap, type YamlValue } from './yaml.js';

/** What an agent may do, from least to most. */
export type AgentReach = 'read' | 'propose' | 'write';

export interface AgentSpec {
  /** Letters, digits, `.`, `_` and `-`. */
  readonly name: string;
  /** The most private notes it may read: open ones, or private ones too. Sealed ones never. */
  readonly reads: 'open' | 'private';
  readonly may: AgentReach;
  /** For `write`: the folder it writes in directly (a daily log, say); everywhere else it proposes. */
  readonly writeIn?: string;
}

export interface AgentEntry {
  readonly name: string;
  /** How many keys name it; 0 for `default`, which is whoever brings none. */
  readonly keys: number;
  readonly reads: Sensitivity;
  readonly verbs: readonly string[];
  readonly writes: readonly string[];
  /** When its keys were taken back, or null. */
  readonly revoked: string | null;
  /** `default` is not in the file: what any agent without a key gets. */
  readonly implicit: boolean;
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;

const TEMPLATE = [
  '# Who may read what in this folder. Changed by hand or from Noto.',
  'sensitivity:',
  '  default: open',
  '  private: []',
  '  sealed: []',
  '',
  'principals:',
  '',
].join('\n');

const read = (root: string): string => (existsSync(accessPath(root)) ? readFileSync(accessPath(root), 'utf8') : TEMPLATE);

function save(root: string, lines: readonly string[]): void {
  mkdirSync(path.dirname(accessPath(root)), { recursive: true });
  const text = lines.join('\n');
  writeFileSync(accessPath(root), text.endsWith('\n') ? text : `${text}\n`, 'utf8');
}

const isTop = (line: string) => /^[^\s#]/.test(line);
const indentOf = (line: string) => line.length - line.trimStart().length;
const quoted = (items: readonly string[]) => `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;

/** A top-level section's lines: its `key:` line and where it ends (the next top-level line). */
function section(lines: readonly string[], key: string): { start: number; end: number } | null {
  const start = lines.findIndex((line) => new RegExp(`^${key}:(\\s|$)`).test(line));
  if (start < 0) return null;
  let end = lines.length;
  for (let at = start + 1; at < lines.length; at += 1) if (isTop(lines[at]!)) { end = at; break; }
  return { start, end };
}

/** A key's lines inside a section, at the given indent: its line, and its children's (deeper) lines after it. */
function entry(lines: readonly string[], within: { start: number; end: number }, key: string, indent: number): { start: number; end: number } | null {
  const pattern = new RegExp(`^ {${indent}}${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\s|$)`);
  for (let at = within.start + 1; at < within.end; at += 1) {
    if (!pattern.test(lines[at]!)) continue;
    let end = at + 1;
    while (end < within.end && (lines[end]!.trim() === '' || indentOf(lines[end]!) > indent)) end += 1;
    // Blank lines at the end belong to whatever follows.
    while (end > at + 1 && lines[end - 1]!.trim() === '') end -= 1;
    return { start: at, end };
  }
  return null;
}

/** The end of a section's content, before the blank lines that close it. */
function sectionTail(lines: readonly string[], within: { start: number; end: number }): number {
  let end = within.end;
  while (end > within.start + 1 && lines[end - 1]!.trim() === '') end -= 1;
  return end;
}

function verbsFor(may: AgentReach): string[] {
  if (may === 'read') return ['read', 'search', 'recall'];
  if (may === 'propose') return ['read', 'search', 'recall', 'propose'];
  return ['read', 'search', 'recall', 'append', 'propose', 'write'];
}

/** A folder as the policy names it: forward slashes, no leading `./` or trailing `/`, never up and out. */
function folderOf(folder: string): string {
  const clean = folder.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.split('/').includes('..') || clean.split('/').some((part) => part.startsWith('.'))) {
    throw new Error(`"${folder}" is not a folder of the vault that a policy can name.`);
  }
  return clean;
}

/**
 * Add an agent and make its key, shown to the person once; only its hash
 * is kept. An agent whose keys were taken back is given a fresh block under
 * the same name; one that still has a key is refused, to be revoked first.
 */
export function addAgent(root: string, spec: AgentSpec): { name: string; key: string } {
  if (!NAME.test(spec.name) || spec.name === 'owner' || spec.name === 'default') {
    throw new Error(`An agent's name is letters, digits, ".", "_" and "-", and not "owner" or "default": "${spec.name}" is not one.`);
  }
  if (spec.reads !== 'open' && spec.reads !== 'private') throw new Error('An agent reads open notes, or private ones too.');
  const writeIn = spec.may === 'write' ? folderOf(spec.writeIn ?? '') : null;
  const key = randomBytes(24).toString('base64url');
  const lines = read(root).split('\n');
  const block = [
    `  ${spec.name}:`,
    `    keys: [${keyHash(key)}]`,
    '    read: ["**"]',
    `    max_sensitivity: ${spec.reads}`,
    `    append: ${quoted(writeIn ? [`${writeIn}/**`] : [])}`,
    `    write: ${quoted(writeIn ? [`${writeIn}/**`] : [])}`,
    `    verbs: [${verbsFor(spec.may).join(', ')}]`,
  ];
  let principals = section(lines, 'principals');
  if (!principals) {
    if (lines.length > 0 && lines[lines.length - 1]!.trim() !== '') lines.push('');
    lines.push('principals:');
    principals = section(lines, 'principals')!;
  }
  // `principals: {}` written on one line holds nothing yet: it becomes a block.
  if (/^principals:\s*\{\s*\}\s*$/.test(lines[principals.start]!)) lines[principals.start] = 'principals:';
  const existing = entry(lines, principals, spec.name, 2);
  if (existing) {
    const raw = parseYamlMap(read(root)).principals as Record<string, YamlValue> | undefined;
    const keys = raw && typeof raw === 'object' && !Array.isArray(raw) ? list((raw[spec.name] as Record<string, YamlValue> | undefined)?.keys) : [];
    if (keys.length > 0) throw new Error(`There is an agent named ${spec.name} already. Take its key back first, or choose another name.`);
    lines.splice(existing.start, existing.end - existing.start, ...block);
  } else {
    lines.splice(sectionTail(lines, principals), 0, ...block);
  }
  save(root, lines);
  // What was written must read back as meant: a key that names no one would be a key that does nothing.
  if (parseAccess(read(root)).principal(spec.name)?.maxSensitivity !== spec.reads) {
    throw new Error(`.noto/access.yaml did not read back as ${spec.name} was written; it is left for you to look at.`);
  }
  return { name: spec.name, key };
}

/**
 * Take an agent's keys back: its block keeps what it was allowed, with no
 * key and the time it was revoked, so the list can say so. For `default`
 * (whoever brings no key) there is no key to take: it is given nothing to
 * read instead. Resolves with whether anything changed.
 */
export function revokeAgent(root: string, name: string, now: Date = new Date()): boolean {
  const lines = read(root).split('\n');
  let principals = section(lines, 'principals');
  if (name === 'default') {
    if (!principals) { lines.push('', 'principals:'); principals = section(lines, 'principals')!; }
    if (/^principals:\s*\{\s*\}\s*$/.test(lines[principals.start]!)) lines[principals.start] = 'principals:';
    const block = ['  default:', '    read: []', '    verbs: []', `    revoked: ${now.toISOString()}`];
    const existing = entry(lines, principals, 'default', 2);
    if (existing) lines.splice(existing.start, existing.end - existing.start, ...block);
    else lines.splice(sectionTail(lines, principals), 0, ...block);
    save(root, lines);
    return true;
  }
  if (!principals) return false;
  const existing = entry(lines, principals, name, 2);
  if (!existing) return false;
  // An agent written on one line (`name: { keys: [...] }`) has no lines to take its keys out of.
  if (!/:\s*$/.test(lines[existing.start]!.replace(/\s+#.*$/, ''))) {
    throw new Error(`${name} is written on one line in .noto/access.yaml; take its keys out there by hand.`);
  }
  const body = lines.slice(existing.start + 1, existing.end);
  const kept: string[] = [];
  for (let at = 0; at < body.length; at += 1) {
    const line = body[at]!;
    if (/^ {4}revoked:/.test(line)) continue;
    if (/^ {4}keys:/.test(line)) {
      // A block list's items go with it.
      while (at + 1 < body.length && /^ {6,}- /.test(body[at + 1]!)) at += 1;
      continue;
    }
    kept.push(line);
  }
  lines.splice(existing.start, existing.end - existing.start, lines[existing.start]!, '    keys: []', `    revoked: ${now.toISOString()}`, ...kept);
  save(root, lines);
  return true;
}

/**
 * Say how private a folder is. Whatever the policy said of that folder
 * itself is taken out of every list, and it is put in the one asked for
 * only if it would not be that already (the default, or a folder around
 * it): the longest matching pattern wins, so a folder can be opened inside a
 * private one. Lists are written back on one line each.
 */
export function setFolderSensitivity(root: string, folder: string, level: Sensitivity): void {
  if (!SENSITIVITIES.includes(level)) throw new Error(`"${level}" is not open, private or sealed.`);
  const name = folderOf(folder);
  const own = new Set([name, `${name}/`, `${name}/**`]);
  const text = read(root);
  const raw = parseYamlMap(text).sensitivity;
  const levels = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, YamlValue> : {};
  const next: Record<Sensitivity, string[]> = {
    open: list(levels.open).filter((pattern) => !own.has(pattern)),
    private: list(levels.private).filter((pattern) => !own.has(pattern)),
    sealed: list(levels.sealed).filter((pattern) => !own.has(pattern)),
  };
  const lines = text.split('\n');
  let block = section(lines, 'sensitivity');
  if (!block) {
    lines.unshift('sensitivity:', '  default: open', '');
    block = section(lines, 'sensitivity')!;
  }
  const write = (key: Sensitivity) => {
    const current = section(lines, 'sensitivity')!;
    const at = entry(lines, current, key, 2);
    const line = `  ${key}: ${quoted(next[key])}`;
    if (at) lines.splice(at.start, at.end - at.start, line);
    else lines.splice(sectionTail(lines, current), 0, line);
  };
  for (const key of SENSITIVITIES) write(key);
  // Without its own pattern, does the folder already come out as asked?
  const probe = `${name}/note.md`;
  if (parseAccess(lines.join('\n')).sensitivityOf(probe) !== level) {
    next[level].push(`${name}/`);
    write(level);
  }
  save(root, lines);
}

/** How private a folder is, and whether its own pattern says so (rather than the default or a folder around it). */
export function folderSensitivity(root: string, folder: string): { level: Sensitivity; own: boolean } {
  const name = folderOf(folder);
  const access = parseAccess(read(root));
  const rule = access.sensitivityRule(`${name}/note.md`);
  return { level: access.sensitivityOf(`${name}/note.md`), own: rule !== null && [name, `${name}/`, `${name}/**`].includes(rule) };
}

/** The agents the policy names, `default` among them, in the file's order. */
export function agentList(root: string): AgentEntry[] {
  const text = read(root);
  const policy = parseAccess(text);
  const raw = parseYamlMap(text).principals;
  const entries = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, YamlValue> : {};
  return policy.principals.map((principal) => {
    const own = entries[principal.name];
    const fields = own !== null && typeof own === 'object' && !Array.isArray(own) ? own as Record<string, YamlValue> : {};
    return {
      name: principal.name,
      keys: list(fields.keys).length,
      reads: principal.maxSensitivity,
      verbs: [...principal.verbs],
      writes: list(fields.write),
      revoked: typeof fields.revoked === 'string' ? fields.revoked : null,
      implicit: !(principal.name in entries),
    };
  });
}

function list(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}
