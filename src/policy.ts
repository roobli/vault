/**
 * Changing `.noto/access.yaml` from an editor: adding an agent with a key,
 * taking its key back, and saying how private a folder is.
 *
 * The file is the person's, often with comments, so a change is made on the
 * lines it touches, in the file's own indent, and the rest is left as
 * written. Every change is proved before it is saved: the edited text is
 * read with the parser the server uses and must mean exactly what the old
 * text meant with only the asked-for change applied. A file in a shape the
 * edit cannot follow (a key written twice, a list where a map belongs) fails
 * that proof and is left untouched, with a message saying to change it by
 * hand. The new text goes to a fresh file renamed over the old one, so a
 * server reading at that moment sees the old policy or the new and never
 * half of one, and a link standing in for the file or its folder is refused
 * rather than written through.
 *
 * A running MCP server notices the file changed and reads it again before
 * its next answer, so a key taken back stops working on the agent's next
 * request.
 */

import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accessPath, keyHash, parseAccess, SENSITIVITIES, type Sensitivity } from './access.js';
import { parseYamlMap, scalar, splitKey, stripComment, type YamlValue } from './yaml.js';

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

/** The policy could not be changed as asked, and was left as it was. */
export class PolicyEditError extends Error {
  override readonly name = 'PolicyEditError';
}

const NAME = /^[A-Za-z0-9._-]{1,64}$/;
/** Names a policy cannot hold: the two it reserves, and the ones a parsed map treats as its own machinery. */
const RESERVED = new Set(['owner', 'default', '__proto__', 'constructor', 'prototype']);

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

type Map_ = { [key: string]: YamlValue };
const isMap = (value: YamlValue | undefined): value is Map_ => value !== null && typeof value === 'object' && !Array.isArray(value);

function list(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' && value !== '' ? [value] : [];
}

function verbsFor(may: AgentReach): string[] {
  if (may === 'read') return ['read', 'search', 'recall'];
  if (may === 'propose') return ['read', 'search', 'recall', 'propose'];
  return ['read', 'search', 'recall', 'append', 'propose', 'write'];
}

/** A folder as the policy names it: forward slashes, no leading `./` or trailing `/`, never up and out or into a dot folder. */
function folderOf(folder: string): string {
  const clean = folder.replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  if (!clean || clean.startsWith('/') || clean.split('/').some((part) => part === '' || part.startsWith('.'))) {
    throw new PolicyEditError(`"${folder}" is not a folder of the vault that a policy can name.`);
  }
  return clean;
}

/**
 * A folder a policy can write a pattern for. `*` and `?` in a pattern are
 * wildcards and the policy has no way to say them literally, so a folder
 * with one in its name would be given a pattern that is not its own.
 */
function nameableFolder(folder: string): string {
  const clean = folderOf(folder);
  if (/[*?]/.test(clean)) throw new PolicyEditError(`"${clean}" has * or ? in its name, which a policy reads as a wildcard; rename the folder to set this from Noto.`);
  if (/[\u0000-\u001f\u007f]/.test(clean)) throw new PolicyEditError(`"${JSON.stringify(clean)}" has a control character in its name.`);
  return clean;
}

// ---------------------------------------------------------------------------
// The file, as lines that can be edited where a key is.

interface Doc {
  readonly lines: string[];
  readonly eol: string;
  readonly bom: boolean;
  /** The file's indent step, from its first indented key; 2 when it has none. */
  readonly unit: number;
}

/** A key's lines: the key at `start`, its value through `end` (exclusive), at `indent`. */
interface Span { readonly start: number; readonly end: number; readonly indent: number }

const indentOf = (line: string) => line.length - line.replace(/^ +/, '').length;
const isFiller = (line: string) => /^\s*(#.*)?$/.test(line);
const isSeqItem = (content: string) => content === '-' || content.startsWith('- ');

function parseDoc(text: string): Doc {
  const bom = text.startsWith('﻿');
  const body = bom ? text.slice(1) : text;
  const lines = body.split(/\r?\n/);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const first = lines.find((line) => !isFiller(line) && indentOf(line) > 0);
  return { lines, eol: body.includes('\r\n') ? '\r\n' : '\n', bom, unit: first ? indentOf(first) : 2 };
}

const docText = (doc: Doc) => `${doc.bom ? '﻿' : ''}${doc.lines.join(doc.eol)}${doc.eol}`;

const shapeError = (what: string) => new PolicyEditError(`${what} in .noto/access.yaml is written in a way Noto cannot change safely; nothing was changed. Change it there by hand.`);

/** The key on a line at exactly this indent, and what follows its colon. */
function keyAt(line: string, indent: number): [string, string] | null {
  if (indentOf(line) !== indent) return null;
  return splitKey(line.slice(indent));
}

/**
 * Where a key's value ends. Lines indented past the key belong to it, as
 * the parser reads them (a block, a block scalar, a flow list run on), and
 * so does a sequence written at the key's own column when the key has no
 * value on its line. Blank lines and comments at the key's column or less
 * at the end belong to what follows.
 */
function spanOf(lines: readonly string[], start: number, indent: number, limit: number): Span {
  const [, rest] = keyAt(lines[start]!, indent)!;
  const empty = stripComment(rest).trim() === '';
  let end = start + 1;
  let seqAtKey: boolean | null = null;
  while (end < limit) {
    const line = lines[end]!;
    if (isFiller(line)) { end += 1; continue; }
    const at = indentOf(line);
    if (at > indent) { end += 1; continue; }
    if (at === indent && empty && isSeqItem(line.slice(indent))) {
      if (seqAtKey === null) seqAtKey = true;
      if (seqAtKey) { end += 1; continue; }
    }
    break;
  }
  while (end > start + 1 && isFiller(lines[end - 1]!) && (lines[end - 1]!.trim() === '' || indentOf(lines[end - 1]!) <= indent)) end -= 1;
  return { start, end, indent };
}

/** The keys of a block map: the document's when `parent` is null, else the value of the key at `parent`. */
function entries(doc: Doc, parent: Span | null, what: string): { indent: number; keys: Map<string, Span[]>; tail: number } {
  const from = parent ? parent.start + 1 : 0;
  const to = parent ? parent.end : doc.lines.length;
  let indent = parent ? -1 : 0;
  const keys = new Map<string, Span[]>();
  let tail = parent ? parent.end : from;
  for (let at = from; at < to;) {
    const line = doc.lines[at]!;
    if (isFiller(line)) { at += 1; continue; }
    if (indent < 0) indent = indentOf(line);
    const pair = keyAt(line, indent);
    if (!pair) throw shapeError(what);
    const span = spanOf(doc.lines, at, indent, to);
    keys.set(pair[0], [...(keys.get(pair[0]) ?? []), span]);
    at = span.end;
    tail = span.end;
  }
  if (indent < 0) indent = (parent?.indent ?? 0) + doc.unit;
  return { indent, keys, tail };
}

/** A scalar written so the parser gives it back as the same string: bare when it is a plain word, quoted otherwise. */
function word(text: string): string {
  return /^[A-Za-z0-9._-]+$/.test(text) && scalar(text) === text ? text : JSON.stringify(text);
}

function flow(value: YamlValue): string {
  if (Array.isArray(value)) return `[${value.map(flow).join(', ')}]`;
  if (isMap(value)) return `{ ${Object.entries(value).map(([key, item]) => `${word(key)}: ${flow(item)}`).join(', ')} }`;
  if (typeof value === 'string') return word(value);
  return value === null ? 'null' : String(value);
}

/** A key and its value as lines at `indent`: a map as a block, anything else on the key's line. */
function render(key: string, value: YamlValue, indent: number, unit: number): string[] {
  const pad = ' '.repeat(indent);
  if (!isMap(value)) return [`${pad}${word(key)}: ${flow(value)}`];
  return [`${pad}${word(key)}:`, ...Object.entries(value).flatMap(([child, item]) => render(child, item, indent + unit, unit))];
}

/** Replace a key's lines, keeping the comments written among them and the one at the end of its line. */
function replace(doc: Doc, span: Span, lines: string[]): void {
  const pad = ' '.repeat(span.indent);
  const header = doc.lines[span.start]!;
  const trailing = header.slice(stripComment(header).length).trim();
  const comments = doc.lines.slice(span.start + 1, span.end).filter((line) => line.trim().startsWith('#')).map((line) => `${pad}${line.trim()}`);
  const next = [...lines];
  if (trailing) next[0] = `${next[0]}  ${trailing}`;
  doc.lines.splice(span.start, span.end - span.start, ...comments, ...next);
}

/** The value written at a key, read on its own. */
function valueAt(doc: Doc, span: Span): YamlValue {
  const text = doc.lines.slice(span.start, span.end).map((line) => line.slice(Math.min(span.indent, indentOf(line)))).join('\n');
  const parsed = parseYamlMap(text);
  return Object.values(parsed)[0] ?? null;
}

/**
 * Set `keys` to `value` in the file, making the maps on the way when they
 * are missing. A map written on one line (`principals: {}`, or an agent as
 * `{ keys: [...] }`) is written out as a block first, so a key can go in it.
 */
function setIn(doc: Doc, keys: readonly string[], value: YamlValue, parent: Span | null = null): void {
  const [key, ...rest] = keys;
  const what = parent ? `"${keys.join('.')}"` : `"${key}"`;
  const map = entries(doc, parent, what);
  const found = map.keys.get(key!);
  if (found && found.length > 1) throw shapeError(`"${key}", written more than once,`);
  if (rest.length === 0) {
    const lines = render(key!, value, map.indent, doc.unit);
    if (found) replace(doc, found[0]!, lines);
    else insert(doc, parent, map.tail, lines);
    return;
  }
  if (!found) {
    let nested: YamlValue = value;
    for (const name of [...rest].reverse()) nested = { [name]: nested };
    insert(doc, parent, map.tail, render(key!, nested, map.indent, doc.unit));
    return;
  }
  let span = found[0]!;
  const [, after] = keyAt(doc.lines[span.start]!, span.indent)!;
  if (stripComment(after).trim() !== '') {
    const current = valueAt(doc, span);
    if (!isMap(current)) throw shapeError(`"${key}"`);
    replace(doc, span, render(key!, current, span.indent, doc.unit));
    span = entries(doc, parent, what).keys.get(key!)![0]!;
  } else if (span.end > span.start + 1 && !isMap(valueAt(doc, span))) {
    throw shapeError(`"${key}"`);
  }
  setIn(doc, rest, value, span);
}

function insert(doc: Doc, parent: Span | null, at: number, lines: string[]): void {
  if (parent === null) {
    let end = doc.lines.length;
    while (end > 0 && doc.lines[end - 1]!.trim() === '') end -= 1;
    doc.lines.splice(end, doc.lines.length - end, ...(end > 0 ? [''] : []), ...lines);
    return;
  }
  doc.lines.splice(at, 0, ...lines);
}

// ---------------------------------------------------------------------------
// Proving a change, and saving it.

function same(left: YamlValue | undefined, right: YamlValue | undefined): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, at) => same(item, right[at]));
  }
  if (isMap(left) || isMap(right)) {
    if (!isMap(left) || !isMap(right)) return false;
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key) => Object.hasOwn(right, key) && same(left[key], right[key]));
  }
  return left === right;
}

/** `model` with `keys` set to `value`, the maps on the way made when they are missing. */
function withValue(model: Map_, keys: readonly string[], value: YamlValue): Map_ {
  const out = structuredClone(model);
  let at: Map_ = out;
  for (const key of keys.slice(0, -1)) {
    if (!isMap(at[key])) at[key] = {};
    at = at[key] as Map_;
  }
  at[keys[keys.length - 1]!] = value;
  return out;
}

/** The policy as it stands, refusing a file or folder that is a link to somewhere else. */
function load(root: string): { doc: Doc; model: Map_; mode: number | null } {
  const file = accessPath(root);
  let mode: number | null = null;
  for (const target of [path.dirname(file), file]) {
    try {
      const stat = lstatSync(target);
      if (stat.isSymbolicLink()) throw new PolicyEditError(`${path.relative(root, target)} is a link to somewhere else; Noto changes the policy only in the folder's own .noto/access.yaml.`);
      if (target === file) mode = stat.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const text = mode === null ? TEMPLATE : readFileSync(file, 'utf8');
  return { doc: parseDoc(text), model: parseYamlMap(text), mode };
}

/**
 * Save the edited policy if it means `expected` and nothing else. The text
 * goes to a new file in `.noto/` that is renamed over the old one.
 */
function commit(root: string, doc: Doc, expected: Map_, mode: number | null, what: string): string {
  const text = docText(doc);
  if (!same(parseYamlMap(text), expected)) throw shapeError(what);
  const file = accessPath(root);
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.access.yaml.${process.pid}.${randomBytes(4).toString('hex')}`);
  writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx', mode: mode ?? 0o644 });
  try {
    renameSync(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return text;
}

// ---------------------------------------------------------------------------
// The changes.

/**
 * Add an agent and make its key, shown to the person once; only its hash
 * is kept. An agent whose keys were taken back is given a fresh block under
 * the same name; one that still has a key is refused, to be revoked first.
 */
export function addAgent(root: string, spec: AgentSpec): { name: string; key: string } {
  if (!NAME.test(spec.name) || RESERVED.has(spec.name)) {
    throw new PolicyEditError(`An agent's name is letters, digits, ".", "_" and "-", and not "owner" or "default": "${spec.name}" is not one.`);
  }
  if (spec.reads !== 'open' && spec.reads !== 'private') throw new PolicyEditError('An agent reads open notes, or private ones too.');
  const writeIn = spec.may === 'write' ? nameableFolder(spec.writeIn ?? '') : null;
  const { doc, model, mode } = load(root);
  const existing = isMap(model.principals) ? model.principals[spec.name] : undefined;
  if (isMap(existing) && list(existing.keys).length > 0) {
    throw new PolicyEditError(`There is an agent named ${spec.name} already. Take its key back first, or choose another name.`);
  }
  const key = randomBytes(24).toString('base64url');
  const block: Map_ = {
    keys: [keyHash(key)],
    read: ['**'],
    max_sensitivity: spec.reads,
    append: writeIn ? [`${writeIn}/**`] : [],
    write: writeIn ? [`${writeIn}/**`] : [],
    verbs: verbsFor(spec.may),
  };
  setIn(doc, ['principals', spec.name], block);
  const text = commit(root, doc, withValue(model, ['principals', spec.name], block), mode, `"principals"`);
  // The proof above is of the file's meaning; this is of the key: a key that names no one does nothing.
  if (parseAccess(text).principalFor(key).name !== spec.name) throw shapeError(`"principals.${spec.name}"`);
  return { name: spec.name, key };
}

/**
 * Take an agent's keys back: its block keeps what it was allowed, with no
 * key and the time it was revoked, so the list can say so. For `default`
 * (whoever brings no key) there is no key to take: it is given nothing to
 * read instead. Resolves with whether there was such an agent.
 */
export function revokeAgent(root: string, name: string, now: Date = new Date()): boolean {
  if (RESERVED.has(name) && name !== 'default') return false;
  const { doc, model, mode } = load(root);
  const principals = isMap(model.principals) ? model.principals : {};
  const changes: [string, YamlValue][] = name === 'default'
    ? [['read', []], ['verbs', []], ['revoked', now.toISOString()]]
    : [['keys', []], ['revoked', now.toISOString()]];
  if (name !== 'default' && !isMap(principals[name])) return false;
  let expected = model;
  for (const [field, value] of changes) {
    setIn(doc, ['principals', name, field], value);
    expected = withValue(expected, ['principals', name, field], value);
  }
  const text = commit(root, doc, expected, mode, `"principals.${name}"`);
  const after = parseAccess(text).principal(name);
  if (!after || (name === 'default' ? after.canSee('x.md', 'open') : false)) throw shapeError(`"principals.${name}"`);
  return true;
}

/**
 * Say how private a folder is. Whatever the policy said of that folder
 * itself is taken out of every list, and it is put in the one asked for
 * only if it would not be that already (the default, or a folder around
 * it): the longest matching pattern wins, so a folder can be opened inside a
 * private one. A list that changes is written back on one line; the others
 * are left as written.
 */
export function setFolderSensitivity(root: string, folder: string, level: Sensitivity): void {
  if (!SENSITIVITIES.includes(level)) throw new PolicyEditError(`"${level}" is not open, private or sealed.`);
  const name = nameableFolder(folder);
  const own = new Set([name, `${name}/`, `${name}/**`]);
  const { doc, model, mode } = load(root);
  const levels = isMap(model.sensitivity) ? model.sensitivity : {};
  const probe = `${name}/note.md`;

  const attempt = (withOwn: boolean) => {
    const edited: Doc = { ...doc, lines: [...doc.lines] };
    let expected = model;
    for (const key of SENSITIVITIES) {
      const next = list(levels[key]).filter((pattern) => !own.has(pattern));
      if (withOwn && key === level) next.push(`${name}/`);
      const present = Object.hasOwn(levels, key);
      if (present ? same(levels[key], next) || (typeof levels[key] === 'string' && same([levels[key]], next)) : next.length === 0) continue;
      setIn(edited, ['sensitivity', key], next);
      expected = withValue(expected, ['sensitivity', key], next);
    }
    return { edited, expected };
  };

  let { edited, expected } = attempt(false);
  if (parseAccess(docText(edited)).sensitivityOf(probe) !== level) ({ edited, expected } = attempt(true));
  if (parseAccess(docText(edited)).sensitivityOf(probe) !== level) throw shapeError(`"sensitivity"`);
  if (same(expected, model)) return;
  commit(root, edited, expected, mode, `"sensitivity"`);
}

/** The policy's text as the server reads it: through a link, if it is one, and none when there is no file. */
const readText = (root: string): string => (existsSync(accessPath(root)) ? readFileSync(accessPath(root), 'utf8') : '');

/** How private a folder is, and whether its own pattern says so (rather than the default or a folder around it). */
export function folderSensitivity(root: string, folder: string): { level: Sensitivity; own: boolean } {
  const name = folderOf(folder);
  const access = parseAccess(readText(root));
  const rule = access.sensitivityRule(`${name}/note.md`);
  return { level: access.sensitivityOf(`${name}/note.md`), own: rule !== null && [name, `${name}/`, `${name}/**`].includes(rule) };
}

/** The agents the policy names, `default` among them, in the file's order. */
export function agentList(root: string): AgentEntry[] {
  const text = readText(root);
  const model = parseYamlMap(text);
  const policy = parseAccess(text);
  const entriesOf = isMap(model.principals) ? model.principals : {};
  return policy.principals.map((principal) => {
    const own = entriesOf[principal.name];
    const fields = isMap(own) ? own : {};
    return {
      name: principal.name,
      keys: list(fields.keys).length,
      reads: principal.maxSensitivity,
      verbs: [...principal.verbs],
      writes: list(fields.write),
      revoked: typeof fields.revoked === 'string' ? fields.revoked : null,
      implicit: !Object.hasOwn(entriesOf, principal.name),
    };
  });
}
