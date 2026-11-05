/**
 * Which file a link means.
 *
 * Rules 1 to 3 are ported from the `resolveLink` of the vault tool this
 * package was built against (`vault.mjs`), the resolver its `mv`, `relink` and
 * graph already share, so both read a vault's links the same way. Rule 4 is new: a link
 * that matched no file is tried, case-insensitively, against file names and
 * then against aliases (card ids and aliases, old paths and names from git's
 * renames), so a link written before a move keeps meaning its note.
 */

import path from 'node:path';
import { withoutExt } from './paths.js';
import type { LinkKind } from './markdown.js';

export interface ResolveIndex {
  /** Every file in the vault, Markdown or not. */
  readonly files: ReadonlySet<string>;
  /** File name without a Markdown extension, to the files that carry it. */
  readonly byBase: ReadonlyMap<string, readonly string[]>;
  /** Lowercased name without extension, to the files that carry it. */
  readonly byBaseLower?: ReadonlyMap<string, readonly string[]>;
  /** Lowercased alias, to the notes it names. */
  readonly aliases?: ReadonlyMap<string, readonly string[]>;
  /**
   * A path written through the vault's own folder, absolute or not
   * (`/Users/me/Notes/A/b.md:12`, `Notes/A/b.md` in a vault called Notes):
   * what follows the folder is the vault-relative path.
   */
  readonly throughRoot?: RegExp;
}

export interface Resolution {
  readonly path: string | null;
  readonly ambiguous: boolean;
  readonly candidates?: readonly string[];
  /** How it was found, when not by rules 1 to 3. */
  readonly via?: 'case' | 'alias';
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export const baseKey = (rel: string): string => withoutExt(path.posix.basename(rel));
export const aliasKey = (value: string): string => withoutExt(value.replace(/\\/g, '/').trim()).toLowerCase();

export function buildResolveIndex(files: Iterable<string>, aliases?: ReadonlyMap<string, readonly string[]>, rootName?: string): ResolveIndex {
  const set = new Set<string>();
  const byBase = new Map<string, string[]>();
  const byBaseLower = new Map<string, string[]>();
  for (const rel of files) {
    set.add(rel);
    const base = baseKey(rel);
    (byBase.get(base) ?? byBase.set(base, []).get(base)!).push(rel);
    const lower = base.toLowerCase();
    (byBaseLower.get(lower) ?? byBaseLower.set(lower, []).get(lower)!).push(rel);
  }
  const throughRoot = rootName ? new RegExp(`^(?:/.*?/|)${rootName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(.+)$`) : undefined;
  return { files: set, byBase, byBaseLower, ...(aliases ? { aliases } : {}), ...(throughRoot ? { throughRoot } : {}) };
}

export function resolveLink(index: ResolveIndex, fromDir: string, link: { readonly target: string; readonly kind: LinkKind }): Resolution | null {
  let raw = link.target.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  const inVault = index.throughRoot?.exec(raw);
  if (inVault) raw = inVault[1]!.replace(/:\d+$/, '');
  const variants = [raw, safeDecode(raw)];
  const tryPath = (candidate: string): string | null => {
    const normal = path.posix.normalize(candidate).replace(/^\.\//, '');
    if (index.files.has(normal)) return normal;
    if (link.kind !== 'img' && index.files.has(`${normal}.md`)) return `${normal}.md`;
    return null;
  };
  const order = link.kind === 'wiki'
    ? [(target: string) => tryPath(target), (target: string) => tryPath(path.posix.join(fromDir, target))]
    : [(target: string) => tryPath(path.posix.join(fromDir, target)), (target: string) => tryPath(target)];
  for (const variant of variants) {
    for (const attempt of order) {
      const hit = attempt(variant);
      if (hit) return { path: hit, ambiguous: false };
    }
  }
  if (raw.includes('/') && link.kind !== 'wiki') return fallback(index, raw, link.kind, fromDir);
  const base = withoutExt(path.posix.basename(safeDecode(raw)));
  const candidates = index.byBase.get(base) ?? [];
  if (candidates.length === 1) return { path: candidates[0]!, ambiguous: false };
  if (candidates.length > 1) {
    const same = candidates.find((candidate) => path.posix.dirname(candidate) === (fromDir || '.'));
    if (same) return { path: same, ambiguous: false };
    return { path: null, ambiguous: true, candidates };
  }
  return fallback(index, raw, link.kind, fromDir);
}

/** Rule 4: the name in another case, then an alias. */
function fallback(index: ResolveIndex, raw: string, kind: LinkKind, fromDir: string): Resolution | null {
  if (kind === 'img') return null;
  const decoded = safeDecode(raw);
  if (!decoded.includes('/')) {
    const lower = index.byBaseLower?.get(withoutExt(decoded).toLowerCase()) ?? [];
    const notes = lower.filter((candidate) => /\.(md|markdown)$/i.test(candidate));
    if (notes.length === 1) return { path: notes[0]!, ambiguous: false, via: 'case' };
  }
  const named = [
    ...(index.aliases?.get(aliasKey(decoded)) ?? []),
    ...(kind === 'md' ? index.aliases?.get(aliasKey(path.posix.join(fromDir, decoded))) ?? [] : []),
  ];
  const live = [...new Set(named)].filter((candidate) => index.files.has(candidate));
  if (live.length === 1) return { path: live[0]!, ambiguous: false, via: 'alias' };
  if (live.length > 1) return { path: null, ambiguous: true, candidates: live, via: 'alias' };
  return null;
}

/**
 * How a new link to `target` is written from a note, by the vault's rule: a
 * bare name when the name is unique, else the path from the root, labelled
 * with the title when the title says more than the name.
 */
export function wikiLinkTo(index: ResolveIndex, target: string, title?: string): string {
  const name = baseKey(target);
  const unique = (index.byBase.get(name) ?? []).length === 1;
  const where = unique ? name : withoutExt(target);
  const label = title && title.trim() && title.trim() !== where ? `|${title.trim().replace(/[[\]|]/g, ' ').trim()}` : '';
  return `[[${where}${label}]]`;
}
