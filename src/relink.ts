/**
 * The links a move breaks, written again so they reach the same note.
 *
 * A note or folder moved or renamed leaves links that named its old place:
 * other notes' links to it, and, when a note moves away from its neighbours,
 * its own relative links to them. Each link in the notes given is resolved
 * twice, against the files as they were and as they are now; one that reached
 * a note before and does not reach the same note now has its target written
 * again, and nothing else in it changes. "Reached" is by its path: a
 * Markdown link or a wiki link written as a path must name the file where it
 * is, as every other tool reads it, though the vault's own resolver would
 * also find it by its name; only a wiki link written as a bare name goes by
 * the name. A link that reached its note only by name before the move was
 * not broken by it, and is left as it is. A link keeps its own way of being
 * written: a bare name stays a bare name while the name is unique, a path
 * stays a path, an embed's `!`, a label, an anchor, angle brackets, `%20`
 * and a `:line` suffix are kept, and a space in a new path is written `%20`. A link that reached nothing before is left
 * alone, as is anything in code. Pure: the caller lists the files, reads the
 * notes and writes the results, so this works with or without an index.
 */

import path from 'node:path';
import { extractLinks, type LinkKind } from './markdown.js';
import { buildResolveIndex, resolveLink, type ResolveIndex } from './resolve.js';
import { dirOf, isMarkdown, withoutExt } from './paths.js';

export interface Move {
  /** Vault-relative, with forward slashes. */
  readonly from: string;
  readonly to: string;
}

export interface RelinkInput {
  /** Every file in the vault as it is now, after the moves, vault-relative with forward slashes. */
  readonly files: Iterable<string>;
  /** Each file that moved, from where it was to where it is; a folder's files are each listed. */
  readonly moves: readonly Move[];
  /** The notes to look in, by where they are now, with their text as it is now. */
  readonly notes: ReadonlyMap<string, string>;
  /** The vault folder's own name, which an absolute link may run through. */
  readonly rootName?: string;
}

export interface RelinkedNote {
  /** Where the note is now. */
  readonly path: string;
  /** Its text with the links written again. */
  readonly text: string;
  /** How many links were. */
  readonly links: number;
}

/**
 * Words that find the notes worth reading, for the moves as they were asked
 * for (a folder once, not each file in it): a link that one breaks names what
 * moved by its own name, the note's or the folder's, unless the note with the
 * link moved too, and those are read anyway. A note with none of the words
 * holds no link to fix, so a folder of thousands is read only where it may.
 */
export function relinkTokens(moves: readonly Move[]): string[] {
  return [...new Set(moves.map((move) => withoutExt(move.from.slice(move.from.lastIndexOf('/') + 1))).filter(Boolean))];
}

export function relink(input: RelinkInput): RelinkedNote[] {
  const after = [...input.files];
  const movedTo = new Map(input.moves.map((move) => [move.from, move.to]));
  const movedFrom = new Map(input.moves.map((move) => [move.to, move.from]));
  const before = after.filter((file) => !movedFrom.has(file)).concat(input.moves.map((move) => move.from));
  const was = buildResolveIndex(before, undefined, input.rootName);
  const now = buildResolveIndex(after, undefined, input.rootName);
  const out: RelinkedNote[] = [];
  for (const [here, text] of input.notes) {
    const there = movedFrom.get(here) ?? here;
    const splices: { start: number; end: number; text: string }[] = [];
    for (const link of extractLinks(text)) {
      const line = link.kind === 'wiki' ? '' : /:\d+$/.exec(link.target)?.[0] ?? '';
      const written = line ? link.target.slice(0, -line.length) : link.target;
      const reached = linkReaches(was, dirOf(there), written, link.kind);
      if (reached === null) continue;
      const goal = movedTo.get(reached) ?? reached;
      if (linkReaches(now, dirOf(here), written, link.kind) === goal) continue;
      // The parser says where the target begins; the text there must be it, or nothing is touched.
      if (text.slice(link.targetStart, link.targetStart + written.length) !== written) continue;
      const next = link.kind === 'wiki'
        ? wikiTarget(now, written, goal, dirOf(here))
        : pathTarget(now, written, reached, goal, dirOf(here), link.kind);
      if (next === null) continue;
      splices.push({ start: link.targetStart, end: link.targetStart + written.length, text: next });
    }
    if (splices.length === 0) continue;
    let result = text;
    let edge = Infinity;
    let links = 0;
    // From the end, so each splice's offsets still hold; two that overlap are not both a link, and neither is written.
    for (const splice of splices.sort((left, right) => right.start - left.start)) {
      if (splice.end > edge) continue;
      result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
      edge = splice.start;
      links += 1;
    }
    if (links > 0) out.push({ path: here, text: result, links });
  }
  return out;
}

/**
 * The file a link reaches, as an editor that follows it opens it: a bare-name
 * wiki link by its name (the vault's resolver); a wiki link written as a path
 * by that path, from the vault's root or from the note; a Markdown link or
 * image by its path from the note alone, or as an absolute path through the
 * vault's folder. The vault's resolver also tries a Markdown path from the
 * root and falls back to the name, which no other tool does: a link found
 * only that way is not one a move broke, and is left alone. Null for none.
 */
export function linkReaches(index: ResolveIndex, fromDir: string, target: string, kind: LinkKind): string | null {
  if (kind === 'wiki') {
    if (!target.includes('/')) return resolveLink(index, fromDir, { target, kind })?.path ?? null;
    return byPath(index, [target, path.posix.join(fromDir, target)], kind);
  }
  const raw = target.replace(/\\/g, '/');
  const inVault = index.throughRoot?.exec(raw);
  if (inVault) return byPath(index, [inVault[1]!], kind);
  if (raw.startsWith('/')) return null;
  return byPath(index, [path.posix.join(fromDir, raw)], kind);
}

function byPath(index: ResolveIndex, candidates: readonly string[], kind: LinkKind): string | null {
  for (const candidate of candidates) {
    for (const variant of [candidate, safeDecode(candidate)]) {
      const normal = path.posix.normalize(variant.replace(/^\.\//, '')).replace(/^\.\//, '');
      if (normal.startsWith('../')) continue;
      if (index.files.has(normal)) return normal;
      if (kind !== 'img' && index.files.has(`${normal}.md`)) return `${normal}.md`;
    }
  }
  return null;
}

/** A wiki link's target for `goal`: its bare name while that is unique and was how it was written, else its path. */
function wikiTarget(index: ResolveIndex, written: string, goal: string, fromDir: string): string | null {
  const keepExt = isMarkdown(written) || !isMarkdown(goal);
  const full = keepExt ? goal : withoutExt(goal);
  const name = full.slice(full.lastIndexOf('/') + 1);
  const tries = written.includes('/') ? [full] : [name, full];
  for (const candidate of tries) {
    if (linkReaches(index, fromDir, candidate, 'wiki') === goal) return candidate;
  }
  return null;
}

/**
 * A Markdown link's or image's target for `goal`: the path from the note, as
 * it was written relative, or the absolute one with the old place in it
 * replaced. A space is `%20`; a link written with every character escaped is
 * escaped.
 */
function pathTarget(
  index: ResolveIndex, written: string, reached: string, goal: string, fromDir: string, kind: LinkKind,
): string | null {
  let next: string;
  const decoded = safeDecode(written);
  if (decoded.startsWith('/')) {
    // An absolute link names the vault's place on disk; only the note's part of it changes.
    if (!decoded.endsWith(`/${reached}`) && !decoded.endsWith(`/${withoutExt(reached)}`)) return null;
    const tail = decoded.endsWith(`/${reached}`) ? reached : withoutExt(reached);
    next = `${decoded.slice(0, decoded.length - tail.length)}${tail === reached ? goal : withoutExt(goal)}`;
  } else {
    next = path.posix.relative(fromDir || '.', goal) || path.posix.basename(goal);
    // A link written without `.md` stays without it.
    if (kind === 'md' && isMarkdown(goal) && !isMarkdown(decoded)) next = withoutExt(next);
    if (written.startsWith('./') && !next.startsWith('../')) next = `./${next}`;
  }
  // Escaped in angle brackets too: a space there ends the link for every reader that does not know the form.
  next = escaped(written) ? encodeURI(next).replace(/\(/g, '%28').replace(/\)/g, '%29') : next.replace(/ /g, '%20').replace(/\)/g, '%29');
  // Written again only when it is sure to reach the note: anything else is left for a person.
  if (linkReaches(index, fromDir, next, kind) !== goal) return null;
  return next;
}

/** Whether a target was written with characters other than spaces escaped, as some tools write every link. */
function escaped(written: string): boolean {
  return /%(?!20)[0-9A-Fa-f]{2}/.test(written);
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
