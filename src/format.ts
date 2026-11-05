/** How the verbs' results read as text, for the terminal and for an agent. */

import type { RecallPack } from './recall.js';
import type { Suggestion } from './suggest.js';
import type { ReadResult, SearchHit } from './vault.js';

export function formatRead(note: ReadResult, withText = true): string {
  const facts = [note.kind, note.source, note.status, note.date, note.sensitivity !== 'open' ? note.sensitivity : null].filter(Boolean).join(' · ');
  const lines = [`# ${note.title}`, `${note.path} · ${facts}`, `hash ${note.hash}`];
  if (note.heat > 0) lines.push(`heat ${note.heat.toFixed(2)} · ${note.reads} reads · ${note.writes} writes${note.lastRead ? ` · last read ${note.lastRead.slice(0, 10)}` : ''}`);
  if (note.backlinks.length > 0) {
    lines.push(`linked from: ${note.backlinks.slice(0, 12).map((link) => `${link.title}${link.relation ? ` (${link.relation})` : ''}`).join('; ')}${note.backlinks.length > 12 ? ` and ${note.backlinks.length - 12} more` : ''}`);
  }
  if (withText) lines.push('', note.text);
  return lines.join('\n');
}

export function formatSearch(hits: readonly SearchHit[]): string {
  if (hits.length === 0) return 'Nothing matched.';
  return hits.map((hit) => `${hit.title}  [${hit.kind}]\n  ${hit.path}\n  ${hit.snippet}`).join('\n\n');
}

export function formatRecall(pack: RecallPack): string {
  if (pack.items.length === 0) return `Nothing in the vault came up for "${pack.cue}".`;
  const blocks = pack.items.map((item) => {
    const facts = [item.kind, item.source, item.status, item.date].filter(Boolean).join(' · ');
    return `## ${item.title}\n${item.path} · ${facts}\nwhy: ${item.why.join('; ')}\n\n${item.excerpt}`;
  });
  const tail = pack.omitted > 0 ? `\n\n(${pack.omitted} more scored but did not fit; ask with a larger budget or a narrower cue.)` : '';
  return `${blocks.join('\n\n')}${tail}`;
}

/** How a mention stands out in its line: bold and underlined on a terminal, in brackets elsewhere. */
export type Emphasis = (text: string) => string;
export const plainEmphasis: Emphasis = (text) => `«${text}»`;
export const terminalEmphasis: Emphasis = (text) => `\u001b[1;4m${text}\u001b[0m`;

export function formatSuggestion(item: Suggestion, emphasis: Emphasis = plainEmphasis): string {
  const where = item.line ? `:${item.line}` : '';
  const quoted = item.around ? `${item.around[0]}${emphasis(item.around[1])}${item.around[2]}` : item.context;
  const change = item.splice ? `→ ${item.splice.replacement}` : `→ add "- ${item.relation ?? 'related'} [[${item.toTitle}]]"`;
  return [
    `[${item.type} ${item.id}] ${item.from}${where}`,
    `   ${item.reason}${quoted ? `: "${quoted}"` : ''}`,
    `   ${change}`,
    `   to ${item.to} (${item.toTitle})`,
  ].join('\n');
}

export function formatSuggestions(items: readonly Suggestion[], emphasis: Emphasis = plainEmphasis): string {
  if (items.length === 0) return 'No links seem to be missing.';
  return items.map((item, index) => `${index + 1}. ${formatSuggestion(item, emphasis)}`).join('\n');
}
