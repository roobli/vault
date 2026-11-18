/**
 * Whether the place a link names inside a note is there.
 *
 * `[[note#Setup]]` and `[x](note.md#setup)` reach a note and then a place in
 * it. The note resolving says nothing about the place: a heading renamed or
 * removed leaves the link pointing at the top of the note, which reads as
 * healthy everywhere links are counted. This says whether the place exists.
 *
 * A heading is named the way GitHub, Typora and Obsidian name one: by its
 * slug, lower case with spaces as hyphens and most punctuation dropped (CJK
 * stays), `-1`, `-2` after repeats; or by its text as written, which is how a
 * wiki link names it. A note may also place an anchor itself with
 * `<a id="here">` or `<span id="here">`. A block reference, `#^id`, names a
 * line ending in `^id`.
 *
 * The slug is the one `@roobli/md/inline` spells, kept here as a copy so the
 * vault has no runtime dependency; the two share their cases in the tests.
 */

/** GitHub's slug for one heading's text. */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** The slugs of a note's headings, in order, with GitHub's suffixes for repeats. */
export function headingSlugs(texts: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return texts.map((text) => {
    const base = headingSlug(text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}-${count}`;
  });
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

/** What a note offers to be linked into: its headings' text, the ids it places, its block ids. */
export interface AnchorTargets {
  readonly headings: readonly string[];
  readonly ids: readonly string[];
  readonly blocks: readonly string[];
}

const PLACED_ID = /<(?:a|span)\b[^>]*?\b(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi;
const BLOCK_ID = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/gm;

/** The ids a note places with `<a id>` / `<span id>`, and its `^block` ids. */
export function placedAnchors(text: string): { ids: string[]; blocks: string[] } {
  const ids = [...text.matchAll(PLACED_ID)].map((match) => match[1] ?? match[2] ?? match[3] ?? '').filter(Boolean);
  const blocks = [...text.matchAll(BLOCK_ID)].map((match) => match[1]!);
  return { ids, blocks };
}

/**
 * Whether `anchor` (as a link writes it, `#Setup`, `#b12-%E8%84%9A%E6%B3%A8`
 * or `#^ref`) names a place `targets` has. An empty anchor names the note,
 * which is always there.
 */
export function anchorReaches(anchor: string, targets: AnchorTargets): boolean {
  const wanted = safeDecode(anchor.replace(/^#/, '')).trim();
  if (wanted.length === 0) return true;
  if (wanted.startsWith('^')) return targets.blocks.includes(wanted.slice(1));
  const lower = wanted.toLowerCase();
  const asSlug = headingSlug(wanted);
  if (headingSlugs(targets.headings).some((slug) => slug === lower || slug === asSlug)) return true;
  if (targets.headings.some((text) => text.trim().toLowerCase() === lower)) return true;
  // A wiki link may name a nested heading as `#Part#Section`; the last part is the place.
  const last = wanted.includes('#') ? wanted.slice(wanted.lastIndexOf('#') + 1).trim() : null;
  if (last && last !== wanted) return anchorReaches(`#${last}`, targets);
  return targets.ids.includes(wanted);
}
