/**
 * The vault's own rules: `.noto/scripts/*.mjs`, loaded in name order.
 *
 * The framework knows a handful of fields (kind, source, sensitivity,
 * status, aliases, tags, typed relations). How a particular vault expresses
 * them, in its own frontmatter keys, folder names and conventions, is a
 * script. Results are cached against the note's hash and a fingerprint of the
 * scripts, so changing a script re-derives every note on the next refresh.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrainConfig, Kind, Source } from './config.js';
import type { Sensitivity } from './access.js';
import type { Heading, Link } from './markdown.js';
import { parseYaml, parseYamlMap, type YamlValue } from './yaml.js';

export interface ScriptNote {
  readonly path: string;
  readonly title: string;
  readonly frontmatter: Readonly<Record<string, YamlValue>>;
  readonly body: string;
  readonly headings: readonly Heading[];
  readonly links: readonly Link[];
}

export interface Derived {
  kind?: Kind;
  source?: Source | null;
  sensitivity?: Sensitivity;
  status?: string | null;
  date?: string | null;
  aliases?: readonly string[];
  tags?: readonly string[];
  /** Typed relations that are not written as relation lines, by link target. */
  relations?: readonly { readonly type: string; readonly target: string }[];
}

export interface ScriptSuggestion {
  /** The note to link to, as a vault path. */
  readonly target: string;
  readonly reason: string;
  readonly score?: number;
  readonly relation?: string;
}

export interface ScriptContext {
  readonly root: string;
  readonly config: BrainConfig;
  readonly yaml: { parse: typeof parseYaml; parseMap: typeof parseYamlMap };
  /** A file in the vault, as text; null when it is not there. */
  readFile(rel: string): string | null;
}

export interface VaultScript {
  readonly name?: string;
  ignore?(rel: string): boolean;
  text?(note: ScriptNote): string;
  derive?(note: ScriptNote, ctx: ScriptContext): Derived | void;
  suggest?(note: ScriptNote, ctx: ScriptContext): readonly ScriptSuggestion[] | void;
}

export interface LoadedScripts {
  readonly scripts: readonly VaultScript[];
  /** Changes whenever a script does. */
  readonly fingerprint: string;
}

export function scriptsDir(root: string): string {
  return path.join(root, '.noto', 'scripts');
}

/** Changes whenever a script does, read without running any. */
export function scriptsFingerprint(root: string): string {
  const dir = scriptsDir(root);
  if (!existsSync(dir)) return 'none';
  const hash = createHash('sha256');
  for (const name of readdirSync(dir).filter((entry) => /\.m?js$/.test(entry)).sort()) {
    hash.update(name).update('\0').update(readFileSync(path.join(dir, name))).update('\0');
  }
  return hash.digest('hex');
}

export async function loadScripts(root: string): Promise<LoadedScripts> {
  const dir = scriptsDir(root);
  if (!existsSync(dir)) return { scripts: [], fingerprint: 'none' };
  const files = readdirSync(dir).filter((name) => /\.m?js$/.test(name)).sort();
  const scripts: VaultScript[] = [];
  for (const name of files) {
    const file = path.join(dir, name);
    const source = readFileSync(file);
    const version = createHash('sha256').update(source).digest('hex').slice(0, 12);
    let loaded: { default?: VaultScript };
    try {
      loaded = await import(`${pathToFileURL(file).href}?v=${version}`) as { default?: VaultScript };
    } catch (error) {
      throw new Error(`Could not load the vault script ${path.relative(root, file)}: ${(error as Error).message}`);
    }
    if (loaded.default && typeof loaded.default === 'object') scripts.push({ name, ...loaded.default });
  }
  return { scripts, fingerprint: scriptsFingerprint(root) };
}

export function scriptContext(root: string, config: BrainConfig): ScriptContext {
  return {
    root,
    config,
    yaml: { parse: parseYaml, parseMap: parseYamlMap },
    readFile(rel) {
      const file = path.resolve(root, rel);
      if (!file.startsWith(path.resolve(root) + path.sep)) return null;
      try { return readFileSync(file, 'utf8'); } catch { return null; }
    },
  };
}

/** Every script's `derive`, later scripts overriding earlier ones field by field. */
export function deriveWith(scripts: readonly VaultScript[], note: ScriptNote, ctx: ScriptContext): Derived {
  const out: Derived = {};
  for (const script of scripts) {
    if (!script.derive) continue;
    let derived: Derived | void;
    try {
      derived = script.derive(note, ctx);
    } catch (error) {
      throw new Error(`The vault script ${script.name ?? '?'} failed on ${note.path}: ${(error as Error).message}`);
    }
    if (derived) Object.assign(out, Object.fromEntries(Object.entries(derived).filter(([, value]) => value !== undefined)));
  }
  return out;
}
