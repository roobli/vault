/**
 * What the index reads out of one note.
 *
 * The link extraction is `extractLinks` from the vault tool this package was
 * built against (`vault.mjs`), ported rule for rule, so the index, the vault's own tools and Noto agree on what
 * is a link: wiki links whose target has a letter or a CJK character, and
 * Markdown links and images whose target is not a URL or an anchor, outside
 * fenced and inline code.
 */

import { parseYamlMap, type YamlValue } from './yaml.js';
import { nameOf } from './paths.js';

export type LinkKind = 'wiki' | 'md' | 'img';

export interface Link {
  readonly kind: LinkKind;
  readonly start: number;
  readonly end: number;
  /** The target as written, without its anchor. */
  readonly target: string;
  /** `#heading` or `#^block`, or empty. */
  readonly anchor: string;
  /** The label: `[[target|label]]` or `[label](target)`; null for a bare wiki link. */
  readonly label: string | null;
  /** 1-based line. */
  readonly line: number;
  /** The relation a typed relation line gives it, such as `part_of`. */
  readonly relation: string | null;
}

export interface Heading {
  readonly level: number;
  readonly text: string;
  readonly line: number;
}

export interface ParsedNote {
  readonly path: string;
  readonly frontmatter: Record<string, YamlValue>;
  /** Where the body starts in the text, after the frontmatter. */
  readonly bodyStart: number;
  readonly body: string;
  readonly title: string;
  readonly headings: readonly Heading[];
  readonly links: readonly Link[];
}

export function splitFrontmatter(text: string): { frontmatter: string; body: string } {
  if (!text.startsWith('---')) return { frontmatter: '', body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: '', body: text };
  const close = text.indexOf('\n', end + 1);
  const cut = close === -1 ? text.length : close + 1;
  return { frontmatter: text.slice(0, cut), body: text.slice(cut) };
}

/**
 * A note's frontmatter as a map: an empty one when it has none, or when it
 * cannot be read, which is no reason to leave the note out. Takes the note's
 * text, or the frontmatter `splitFrontmatter` cut from it.
 */
export function frontmatterOf(text: string): Record<string, YamlValue> {
  const { frontmatter } = splitFrontmatter(text);
  if (!frontmatter) return {};
  try {
    return parseYamlMap(frontmatter.replace(/^---[^\n]*\n/, '').replace(/\n---[^\n]*\n?$/, '\n'));
  } catch {
    return {};
  }
}

/** Fenced code replaced by spaces, so offsets and line numbers stay valid. */
export function maskFences(text: string): string {
  return text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => block.replace(/[^\n]/g, ' '));
}

/** Fenced and inline code replaced by spaces. */
export function maskCode(text: string): string {
  return maskFences(text).replace(/`[^`\n]*`/g, (code) => ' '.repeat(code.length));
}

// The target may not contain brackets; the label may.
const WIKI_RE = /\[\[([^[\]\n|]+?)(\|[^\n]*?)?\]\]/g;
/*
 * A label may hold one image, the badge-and-thumbnail pattern
 * `[![alt](pic.png)](note.md)`: without that, the image's own `](` ended the
 * label, the outer link was read as one to the picture, and the note it led to
 * was never seen.
 */
const MD_RE = /(!?)\[((?:[^\]\n[]|!\[[^\]\n]*\]\([^)\s]*\))*)\]\((<?)([^)\s>]+)>?(?:\s+"[^"]*")?\)/g;

interface RawLink {
  kind: LinkKind;
  start: number;
  end: number;
  /** Where `target`, as written, begins in the text: so it can be replaced without looking for it again. */
  targetStart: number;
  target: string;
  anchor: string;
  label: string | null;
}

export function extractLinks(text: string): RawLink[] {
  const masked = maskCode(text);
  const links: RawLink[] = [];
  for (const match of masked.matchAll(WIKI_RE)) {
    const targetPart = match[1]!;
    const index = match.index!;
    // Masking keeps offsets, so the label is read back from the original: inline code in a label is text.
    const labelAt = index + 2 + targetPart.length;
    const label = match[2] === undefined ? null : text.slice(labelAt + 1, labelAt + match[2].length);
    const hash = targetPart.indexOf('#');
    const target = (hash === -1 ? targetPart : targetPart.slice(0, hash)).trim();
    const anchor = hash === -1 ? '' : targetPart.slice(hash);
    if (!target || !/[A-Za-z㐀-鿿]/.test(target)) continue;
    if (target.startsWith(':') || target.endsWith('\\') || target.includes('](') || /https?:/.test(target)) continue;
    if (masked[index - 1] === '\\') continue;
    const lead = targetPart.length - targetPart.trimStart().length;
    links.push({ kind: 'wiki', start: index, end: index + match[0].length, targetStart: index + 2 + lead, target, anchor, label });
  }
  const markdown = (from: number, until: number, inner: boolean): void => {
    const pattern = new RegExp(MD_RE.source, 'g');
    for (const match of masked.slice(from, until).matchAll(pattern)) {
      const index = from + match.index!;
      // `\[x](y)` is text, written so it would not be a link.
      if (masked[index - 1] === '\\') continue;
      const rawTarget = match[4]!;
      const labelAt = index + match[1]!.length + 1;
      const labelText = match[2]!;
      // The image inside a label is a link of its own, to its picture.
      if (!inner && labelText.includes('](')) markdown(labelAt, labelAt + labelText.length, true);
      if (/^([a-z][a-z0-9+.-]*:|#|\/\/)/i.test(rawTarget)) continue;
      const hash = rawTarget.indexOf('#');
      const target = hash === -1 ? rawTarget : rawTarget.slice(0, hash);
      const anchor = hash === -1 ? '' : rawTarget.slice(hash);
      if (!target) continue;
      links.push({
        kind: match[1] ? 'img' : 'md',
        start: index,
        end: index + match[0].length,
        targetStart: labelAt + labelText.length + 2 + match[3]!.length,
        target,
        anchor,
        label: text.slice(labelAt, labelAt + labelText.length),
      });
    }
  };
  markdown(0, masked.length, false);
  links.sort((left, right) => left.start - right.start);
  return links;
}

/** Relation words, as a vault writes them at the start of a list item, and the relation each means. */
export const DEFAULT_RELATIONS: Readonly<Record<string, string>> = {
  属于: 'part_of', 隶属: 'part_of', 'part of': 'part_of', 'belongs to': 'part_of',
  取代: 'supersedes', 替代: 'supersedes', supersedes: 'supersedes', replaces: 'supersedes',
  被取代: 'superseded_by', 被替代: 'superseded_by', 'superseded by': 'superseded_by',
  反驳: 'contradicts', 矛盾: 'contradicts', contradicts: 'contradicts',
  支持: 'supports', 印证: 'supports', supports: 'supports', confirms: 'supports',
  来源: 'derived_from', 出处: 'derived_from', 源自: 'derived_from', 'derived from': 'derived_from', source: 'derived_from',
  依赖: 'depends_on', 'depends on': 'depends_on',
  例子: 'example_of', 实例: 'example_of', 'example of': 'example_of',
  相关: 'related', 参见: 'related', 另见: 'related', related: 'related', 'see also': 'related',
};

const LIST_ITEM = /^\s*[-*+]\s+/;

/**
 * The relation a line gives its links: a list item whose text before the
 * first link is a relation word (optionally bold, optionally followed by a
 * colon), and whose text after the links is only separators.
 */
function relationOf(line: string, linksOnLine: readonly RawLink[], lineStart: number, vocabulary: Readonly<Record<string, string>>): string | null {
  if (linksOnLine.length === 0 || !LIST_ITEM.test(line)) return null;
  const first = linksOnLine[0]!;
  const before = line.slice(0, first.start - lineStart)
    .replace(LIST_ITEM, '')
    .replace(/\*\*|__/g, '')
    .replace(/[:：]\s*$/, '')
    .trim()
    .toLowerCase();
  const relation = vocabulary[before];
  if (!relation) return null;
  let rest = '';
  for (let index = 1; index < linksOnLine.length; index += 1) {
    rest += line.slice(linksOnLine[index - 1]!.end - lineStart, linksOnLine[index]!.start - lineStart);
  }
  rest += line.slice(linksOnLine[linksOnLine.length - 1]!.end - lineStart);
  return /^(?:[\s,，、;；&]|和|与|及|and)*$/i.test(rest) ? relation : null;
}

export interface ParseOptions {
  readonly relations?: Readonly<Record<string, string>>;
}

export function parseNote(path: string, text: string, options: ParseOptions = {}): ParsedNote {
  const vocabulary = options.relations ?? DEFAULT_RELATIONS;
  const { frontmatter, body } = splitFrontmatter(text);
  const fm = frontmatterOf(frontmatter);
  const bodyStart = frontmatter.length;

  // Line starts, for line numbers and relation lines.
  const lineStarts = [0];
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lineStarts.push(at + 1);
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= offset) low = mid; else high = mid - 1;
    }
    return low + 1;
  };

  const raw = extractLinks(text);
  const byLine = new Map<number, RawLink[]>();
  for (const link of raw) {
    const line = lineAt(link.start);
    (byLine.get(line) ?? byLine.set(line, []).get(line)!).push(link);
  }
  const links: Link[] = [];
  for (const [line, onLine] of byLine) {
    const start = lineStarts[line - 1]!;
    const end = line < lineStarts.length ? lineStarts[line]! - 1 : text.length;
    const relation = start >= bodyStart ? relationOf(text.slice(start, end), onLine, start, vocabulary) : null;
    for (const link of onLine) links.push({ ...link, line, relation: link.kind === 'img' ? null : relation });
  }
  links.sort((left, right) => left.start - right.start);

  // Headings from a fence-masked body: a `#` line in a bash block is a comment.
  const headingBody = maskFences(body);
  const bodyLines = body.split('\n');
  const headingLines = headingBody.split('\n');
  const bodyLineOffset = lineAt(bodyStart) - 1;
  const headings: Heading[] = [];
  headingLines.forEach((line, index) => {
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1]!.length, text: match[2]!.trim(), line: bodyLineOffset + index + 1 });
  });
  let earlyH1: string | null = null;
  for (let index = 0, seen = 0; index < bodyLines.length && seen < 5; index += 1) {
    if (!bodyLines[index]!.trim()) continue;
    seen += 1;
    const match = /^#\s+(.+?)\s*$/.exec(headingLines[index]!);
    if (match) { earlyH1 = match[1]!; break; }
  }
  const fmTitle = typeof fm.title === 'string' || typeof fm.title === 'number' ? String(fm.title).trim() : '';
  const title = fmTitle || earlyH1 || nameOf(path).replace(/[_-]+/g, ' ');

  return { path, frontmatter: fm, bodyStart, body, title, headings, links };
}

/** A frontmatter value as a list of strings: `[a, b]`, `a, b`, or one value. */
export function stringList(value: YamlValue | undefined): string[] {
  if (value === undefined || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => stringList(item));
  if (typeof value === 'object') return [];
  return String(value).split(/[,，]/).map((item) => item.trim()).filter(Boolean);
}

/** A date a log note carries in its file name, `2026_10_27_…` or `2026-10-27…`. */
export function dateFromName(rel: string): string | null {
  const match = /(?:^|\/)(\d{4})[-_](\d{2})[-_](\d{2})(?=[^/]*$)/.exec(rel);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}
