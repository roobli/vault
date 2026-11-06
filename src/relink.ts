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
  const wasStrict = byPathOnly(was);
  const nowStrict = byPathOnly(now);
  const out: RelinkedNote[] = [];
  for (const [here, text] of input.notes) {
    const there = movedFrom.get(here) ?? here;
    const splices: { start: number; end: number; text: string }[] = [];
    for (const link of extractLinks(text)) {
      const line = link.kind === 'wiki' ? '' : /:\d+$/.exec(link.target)?.[0] ?? '';
      const written = line ? link.target.slice(0, -line.length) : link.target;
      const reached = reach(was, wasStrict, dirOf(there), written, link.kind);
      if (reached === null) continue;
      const goal = movedTo.get(reached) ?? reached;
      if (reach(now, nowStrict, dirOf(here), written, link.kind) === goal) continue;
      const original = text.slice(link.start, link.end);
      const at = targetAt(original, link.kind, link.target);
      if (at < 0) continue;
      const next = link.kind === 'wiki'
        ? wikiTarget(now, nowStrict, written, goal, dirOf(here))
        : pathTarget(nowStrict, written, reached, goal, dirOf(here), link.kind);
      if (next === null) continue;
      splices.push({ start: link.start + at, end: link.start + at + written.length, text: next });
    }
    if (splices.length === 0) continue;
    let result = text;
    for (const splice of splices.sort((left, right) => right.start - left.start)) {
      result = result.slice(0, splice.start) + splice.text + result.slice(splice.end);
    }
    out.push({ path: here, text: result, links: splices.length });
  }
  return out;
}

/** The index without its names, so a link is found only where its path says. */
function byPathOnly(index: ResolveIndex): ResolveIndex {
  return { ...index, byBase: new Map(), byBaseLower: new Map() };
}

/** The note a link reaches: a bare-name wiki link by its name, anything else by its path. */
function reach(index: ResolveIndex, strict: ResolveIndex, fromDir: string, target: string, kind: LinkKind): string | null {
  const byName = kind === 'wiki' && !target.includes('/');
  return resolveLink(byName ? index : strict, fromDir, { target, kind })?.path ?? null;
}

/** Where a link's target, as written, begins inside the link's own text; -1 when it cannot be placed. */
function targetAt(original: string, kind: LinkKind, target: string): number {
  if (kind === 'wiki') return original.indexOf(target, 2);
  // The label holds no `]`, so the first `](` ends it.
  let at = original.indexOf('](');
  if (at < 0) return -1;
  at += 2;
  if (original[at] === '<') at += 1;
  return original.startsWith(target, at) ? at : -1;
}

/** A wiki link's target for `goal`: its bare name while that is unique and was how it was written, else its path. */
function wikiTarget(index: ResolveIndex, strict: ResolveIndex, written: string, goal: string, fromDir: string): string | null {
  const keepExt = isMarkdown(written) || !isMarkdown(goal);
  const full = keepExt ? goal : withoutExt(goal);
  const name = full.slice(full.lastIndexOf('/') + 1);
  const tries = written.includes('/') ? [full] : [name, full];
  for (const candidate of tries) {
    if (reach(index, strict, fromDir, candidate, 'wiki') === goal) return candidate;
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
  if (resolveLink(index, fromDir, { target: next, kind })?.path !== goal) return null;
  return next;
}

/** Whether a target was written with characters other than spaces escaped, as some tools write every link. */
function escaped(written: string): boolean {
  return /%(?!20)[0-9A-Fa-f]{2}/.test(written);
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}
