/**
 * `.noto/access.yaml`: who may read and write what.
 *
 * The owner is the person and may do anything. Every other principal is
 * named in the file with the sha256 of its keys, the paths it may read,
 * write and append to, the verbs it may use, and the most sensitive notes it
 * may see. A sealed note is the owner's alone, whatever the file says, and
 * `.noto/` and `.git/` are never writable by anyone else: the scripts in
 * `.noto/scripts` run as code.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { anyMatch, pathMatcher } from './paths.js';
import { parseYamlMap, type YamlValue } from './yaml.js';

export type Sensitivity = 'open' | 'private' | 'sealed';
export const SENSITIVITIES: readonly Sensitivity[] = ['open', 'private', 'sealed'];
const rank = (level: Sensitivity): number => SENSITIVITIES.indexOf(level);

export type Verb = 'read' | 'search' | 'recall' | 'append' | 'propose' | 'write' | 'link' | 'supersede';
export const VERBS: readonly Verb[] = ['read', 'search', 'recall', 'append', 'propose', 'write', 'link', 'supersede'];

export interface Principal {
  readonly name: string;
  readonly owner: boolean;
  readonly verbs: ReadonlySet<Verb>;
  readonly maxSensitivity: Sensitivity;
  canSee(rel: string, sensitivity: Sensitivity): boolean;
  canWrite(rel: string): boolean;
  canAppend(rel: string): boolean;
}

export interface AccessPolicy {
  readonly owner: Principal;
  /** The sensitivity the policy gives a path, before scripts and frontmatter. */
  sensitivityOf(rel: string): Sensitivity;
  /** The `sensitivity:` pattern that gives a path its level; null when the default does. */
  sensitivityRule(rel: string): string | null;
  /** The principal a key names; no key is `default`. Throws on an unknown key. */
  principalFor(key: string | undefined): Principal;
  principal(name: string): Principal | undefined;
  readonly text: string;
}

const PROTECTED = anyMatch(['.noto/', '.git/']);

export const keyHash = (key: string): string => createHash('sha256').update(key.trim()).digest('hex');

const list = (value: YamlValue | undefined): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string')
    : typeof value === 'string' ? [value] : [];

function makeOwner(): Principal {
  return {
    name: 'owner',
    owner: true,
    verbs: new Set(VERBS),
    maxSensitivity: 'sealed',
    canSee: () => true,
    canWrite: () => true,
    canAppend: () => true,
  };
}

function makePrincipal(name: string, raw: Record<string, YamlValue>): Principal & { keys: readonly string[] } {
  const readable = anyMatch(raw.read === undefined ? ['**'] : list(raw.read));
  const writable = anyMatch(list(raw.write));
  const appendable = anyMatch([...list(raw.append), ...list(raw.write)]);
  const max = typeof raw.max_sensitivity === 'string' && (SENSITIVITIES as readonly string[]).includes(raw.max_sensitivity)
    ? raw.max_sensitivity as Sensitivity : 'open';
  // Sealed is the owner's, whatever the file says.
  const maxSensitivity: Sensitivity = max === 'sealed' ? 'private' : max;
  const verbs = new Set(list(raw.verbs).filter((verb): verb is Verb => (VERBS as readonly string[]).includes(verb)));
  if (raw.verbs === undefined) for (const verb of ['read', 'search', 'recall'] as const) verbs.add(verb);
  return {
    name,
    owner: false,
    keys: list(raw.keys),
    verbs,
    maxSensitivity,
    canSee: (rel, sensitivity) => rank(sensitivity) <= rank(maxSensitivity) && readable(rel),
    canWrite: (rel) => !PROTECTED(rel) && writable(rel),
    canAppend: (rel) => !PROTECTED(rel) && appendable(rel),
  };
}

export function accessPath(root: string): string {
  return path.join(root, '.noto', 'access.yaml');
}

export function loadAccess(root: string): AccessPolicy {
  const file = accessPath(root);
  return parseAccess(existsSync(file) ? readFileSync(file, 'utf8') : '');
}

export function parseAccess(text: string): AccessPolicy {
  const raw = parseYamlMap(text);
  const levels = raw.sensitivity !== null && typeof raw.sensitivity === 'object' && !Array.isArray(raw.sensitivity) ? raw.sensitivity : {};
  const fallback = typeof levels.default === 'string' && (SENSITIVITIES as readonly string[]).includes(levels.default)
    ? levels.default as Sensitivity : 'open';
  // Longest matching prefix wins, so a folder can be opened inside a private one.
  const rules: { pattern: string; level: Sensitivity; match: (rel: string) => boolean }[] = [];
  for (const level of SENSITIVITIES) {
    for (const pattern of list(levels[level])) rules.push({ pattern, level, match: pathMatcher(pattern) });
  }
  rules.sort((left, right) => right.pattern.length - left.pattern.length);
  const sensitivityOf = (rel: string): Sensitivity => rules.find((rule) => rule.match(rel))?.level ?? fallback;
  const sensitivityRule = (rel: string): string | null => rules.find((rule) => rule.match(rel))?.pattern ?? null;

  const owner = makeOwner();
  const principals = new Map<string, Principal & { keys: readonly string[] }>();
  const entries = raw.principals !== null && typeof raw.principals === 'object' && !Array.isArray(raw.principals) ? raw.principals : {};
  for (const [name, value] of Object.entries(entries)) {
    if (name === 'owner' || value === null || typeof value !== 'object' || Array.isArray(value)) continue;
    principals.set(name, makePrincipal(name, value));
  }
  if (!principals.has('default')) principals.set('default', makePrincipal('default', {}));

  return {
    owner,
    text,
    sensitivityOf,
    sensitivityRule,
    principal: (name) => (name === 'owner' ? owner : principals.get(name)),
    principalFor(key) {
      if (key === undefined || key.trim() === '') return principals.get('default')!;
      const hash = keyHash(key);
      for (const principal of principals.values()) if (principal.keys.includes(hash)) return principal;
      throw new Error('This key names no principal in .noto/access.yaml.');
    },
  };
}
