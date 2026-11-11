/** Vault-relative paths: forward slashes, no leading slash, `.` and `..` resolved. */

import path from 'node:path';

export function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

export function normalise(value: string): string {
  const parts: string[] = [];
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') { parts.pop(); continue; }
    parts.push(segment);
  }
  return parts.join('/');
}

export const isMarkdown = (rel: string): boolean => /\.(md|markdown)$/i.test(rel);
export const withoutExt = (rel: string): string => rel.replace(/\.(md|markdown)$/i, '');
export const dirOf = (rel: string): string => {
  const at = rel.lastIndexOf('/');
  return at < 0 ? '' : rel.slice(0, at);
};
export const baseOf = (rel: string): string => rel.slice(rel.lastIndexOf('/') + 1);
/** A note's name: its file name without the Markdown extension. */
export const nameOf = (rel: string): string => withoutExt(baseOf(rel));

/**
 * A path pattern as the config files write them. `dir/` is that folder and
 * everything below it; `*`, `**` and `?` are globs (`*` stays within one
 * folder); anything else is that path exactly, or a folder of that name.
 */
export function pathMatcher(pattern: string): (rel: string) => boolean {
  let clean = pattern.replace(/\\/g, '/').replace(/^\.?\//, '');
  // `**/archived/` is the folder at any depth: a glob already matches what is
  // below the path it names, so the slash only says it is a folder.
  if (clean.endsWith('/') && /[*?]/.test(clean)) clean = clean.slice(0, -1);
  if (clean === '**') return () => true;
  if (clean.endsWith('/') && !/[*?]/.test(clean)) {
    const prefix = clean;
    return (rel) => rel.startsWith(prefix) || `${rel}/` === prefix;
  }
  if (!/[*?]/.test(clean)) return (rel) => rel === clean || rel.startsWith(`${clean}/`);
  let source = '';
  for (let at = 0; at < clean.length; at += 1) {
    const ch = clean[at]!;
    if (ch === '*') {
      if (clean[at + 1] === '*') {
        at += 1;
        // `**/` matches zero or more folders.
        if (clean[at + 1] === '/') { at += 1; source += '(?:.*/)?'; } else source += '.*';
      } else source += '[^/]*';
    } else if (ch === '?') source += '[^/]';
    else source += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  const regex = new RegExp(`^${source}(?:/.*)?$`);
  return (rel) => regex.test(rel);
}

/** Whether any of the patterns matches. */
export function anyMatch(patterns: readonly string[] | undefined): (rel: string) => boolean {
  const matchers = (patterns ?? []).map(pathMatcher);
  return (rel) => matchers.some((match) => match(rel));
}
