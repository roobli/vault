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

export function formatSuggestions(items: readonly Suggestion[]): string {
  if (items.length === 0) return 'No links seem to be missing.';
  return items.map((item, index) => {
    const where = item.line ? `:${item.line}` : '';
    const change = item.splice ? `  → ${item.splice.replacement}` : `  → add "- ${item.relation ?? 'related'} [[${item.toTitle}]]"`;
    return `${index + 1}. [${item.type}] ${item.from}${where}\n   to ${item.to} (${item.toTitle})\n   ${item.reason}${item.context ? `\n   "${item.context}"` : ''}\n${change}`;
  }).join('\n');
}
