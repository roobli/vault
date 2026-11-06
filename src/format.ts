/** How the verbs' results read as text, for the terminal and for an agent. */

import type { AboutNote } from './about.js';
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

/** A heading, then a section per list that has anything in it, then one line per fact. */
export function formatAbout(info: AboutNote): string {
  const traced = (name: string, value: string | null, from: string) => `${name} ${value ?? 'unknown'} (${from})`;
  const lines = [
    `# ${info.title}`,
    `${info.path}${info.id ? ` · id ${info.id}` : ''}${info.status ? ` · ${info.status}` : ''}`,
    [traced('kind', info.kind.value, info.kind.from), traced('known', info.known.value, info.known.from), traced('sensitivity', info.sensitivity.value, info.sensitivity.from)].join(' · '),
    `heat ${info.heat.heat.toFixed(2)} · ${info.heat.reads} reads · ${info.heat.writes} writes${info.heat.lastRead ? ` · last read ${info.heat.lastRead.slice(0, 10)}` : ''}`,
  ];
  if (info.tags.length > 0 || info.aliases.length > 0) lines.push([info.tags.length > 0 ? `tags ${info.tags.join(', ')}` : '', info.aliases.length > 0 ? `aliases ${info.aliases.join(', ')}` : ''].filter(Boolean).join(' · '));
  if (info.supersededBy) lines.push(`superseded by ${info.supersededBy.title} (${info.supersededBy.path})`);
  const section = (heading: string, count: number, rows: readonly string[]) => {
    if (count === 0) return;
    lines.push('', `${heading} (${count})`, ...rows.map((row) => `  ${row}`));
    if (count > rows.length) lines.push(`  and ${count - rows.length} more`);
  };
  section('Links here', info.linksHereCount, info.linksHere.map((link) => `${link.title}  ${link.path}${link.relation ? `  (${link.relation})` : ''}`));
  section('Named here without a link', info.namedHereCount, info.namedHere.map((item) => `${item.title}  ${item.to}: "${item.around.join('')}"`));
  section('Opened or changed with it', info.togetherCount, info.together.map((item) => `${item.title}  ${item.path}  (${item.type === 'visit' ? 'opened with it' : 'changed with it'} ${item.count} times)`));
  section('About the same', info.aboutSame.length, info.aboutSame.map((item) => `${item.title}  ${item.path}  (${item.why.join('; ')})`));
  section('Broken links', info.outgoing.brokenCount, info.outgoing.broken.map((link) => `${link.target}  line ${link.line}`));
  lines.push('');
  lines.push(`Links out: ${info.outgoing.count}. Writes: ${info.writes.commits} commits, ${info.writes.appends} appends.`);
  for (const agent of info.writes.agents) lines.push(`  written by ${agent.actor}: ${agent.count}, last ${agent.last.slice(0, 10)}`);
  if (info.reads.length > 0) lines.push(`Reads by day: ${info.reads.map((entry) => `${entry.day} ${entry.count}`).join(', ')}`);
  if (info.readers.length > 0) lines.push(`Readers: ${info.readers.map((entry) => `${entry.actor} ${entry.count} (last ${entry.last.slice(0, 10)})`).join(', ')}`);
  if (info.leadsHere.length > 0) {
    const how = (lead: AboutNote['leadsHere'][number]) => [lead.from, lead.query === null ? null : `recall "${lead.query}"`].filter(Boolean).join(' by ');
    lines.push(`Reached from: ${info.leadsHere.map((lead) => `${how(lead)} ${lead.count}`).join(', ')}`);
  }
  if (info.agents.length > 0) lines.push(`Agents: ${info.agents.map((agent) => (agent.canSee ? `${agent.name} can see it` : `${agent.name} cannot, ${agent.why}`)).join('; ')}`);
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
