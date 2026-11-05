/**
 * Small, exact edits to a note's text: what `append`, `link`, `supersede`
 * and accepted suggestions write. Each keeps every other byte as it was.
 */

import { DEFAULT_RELATIONS } from './markdown.js';

/** The relation word a vault writes for a relation, the first in its vocabulary. */
export function relationWord(relation: string, vocabulary: Readonly<Record<string, string>> = DEFAULT_RELATIONS): string {
  for (const [word, meaning] of Object.entries(vocabulary)) if (meaning === relation) return word;
  return relation;
}

const RELATION_LINE = /^\s*[-*+]\s+\S.*\[\[.+\]\]\s*$/;

/**
 * Add relation lines at the end of the body: to the relation list that
 * already ends it, or as a new list, under `heading` when one is given.
 */
export function addRelationLines(text: string, lines: readonly string[], heading = ''): string {
  const fresh = lines.filter((line) => !text.includes(line));
  if (fresh.length === 0) return text;
  const trimmed = text.replace(/\s+$/, '');
  const tail = trimmed.split('\n');
  const endsWithRelations = tail.length > 0 && RELATION_LINE.test(tail[tail.length - 1]!);
  if (endsWithRelations) return `${trimmed}\n${fresh.join('\n')}\n`;
  const lead = trimmed.length === 0 ? '' : `${trimmed}\n\n`;
  return `${lead}${heading ? `${heading}\n\n` : ''}${fresh.join('\n')}\n`;
}

/** Append an entry, creating the note with a title when it is not there. */
export function appendEntry(text: string | null, entry: string, title: string): string {
  const body = entry.replace(/\s+$/, '');
  if (text === null || text.trim() === '') return `# ${title}\n\n${body}\n`;
  return `${text.replace(/\s+$/, '')}\n\n${body}\n`;
}

export interface Splice {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

/** Apply non-overlapping splices; overlapping ones after the first are dropped. */
export function applySplices(text: string, splices: readonly Splice[]): { text: string; applied: number } {
  const ordered = [...splices].sort((left, right) => left.start - right.start);
  const kept: Splice[] = [];
  let reach = -1;
  for (const splice of ordered) {
    if (splice.start < reach || splice.start < 0 || splice.end > text.length) continue;
    kept.push(splice);
    reach = splice.end;
  }
  let out = text;
  for (const splice of [...kept].reverse()) out = out.slice(0, splice.start) + splice.replacement + out.slice(splice.end);
  return { text: out, applied: kept.length };
}

/** Fill `{yyyy}`, `{mm}`, `{dd}` from a date, in local time. */
export function datedPath(template: string, when: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return template
    .replace(/\{yyyy\}/g, String(when.getFullYear()))
    .replace(/\{mm\}/g, pad(when.getMonth() + 1))
    .replace(/\{dd\}/g, pad(when.getDate()));
}
