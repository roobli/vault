/**
 * Recall: given a cue, the few notes most likely to matter, each with where
 * it came from and why it was chosen, packed to a budget.
 *
 * Seeds come from full text, from exact title and alias hits, and from the
 * note the caller is in. One hop along links, relations and association
 * edges brings in what the seeds point to. The score is relevance, shaped by
 * what kind of note it is, how warm it is, how it is known, and whether it
 * has been superseded. Recall is lazy: nothing is recorded for what it does
 * not return.
 */

import type { Kind, Source } from './config.js';
import type { Sensitivity } from './access.js';
import { decay } from './memory.js';
import { aliasKey } from './resolve.js';
import { looseExpression, looseTerms, matchExpression, queryPieces } from './tokenize.js';
import type { Vault } from './vault.js';

export interface RecallItem {
  readonly path: string;
  readonly title: string;
  readonly kind: Kind;
  readonly source: Source | null;
  readonly date: string | null;
  readonly status: string | null;
  readonly score: number;
  readonly why: readonly string[];
  readonly excerpt: string;
}

export interface RecallPack {
  readonly cue: string;
  readonly items: readonly RecallItem[];
  readonly chars: number;
  /** Candidates that scored but did not fit the budget. */
  readonly omitted: number;
}

export interface RecallOptions {
  /** The note the caller is in, whose neighbours count as seeds. */
  readonly from?: string;
  /** Characters of excerpt to spend. */
  readonly budget?: number;
  readonly limit?: number;
}

const KIND_WEIGHT: Readonly<Record<Kind, number>> = { decision: 1.3, card: 1.2, note: 1, log: 0.85 };
const SOURCE_WEIGHT: Readonly<Record<string, number>> = { lived: 1.15, seen: 1, heard: 0.85 };

interface Row {
  nid: number; path: string; title: string; kind: Kind; source: Source | null; sensitivity: Sensitivity;
  status: string | null; date: string | null; hash: string;
}

interface Candidate {
  row: Row;
  relevance: number;
  why: string[];
}

const RELATION_WORDS: Readonly<Record<string, string>> = {
  part_of: 'part of', supersedes: 'supersedes', superseded_by: 'superseded by', contradicts: 'contradicts',
  supports: 'supports', derived_from: 'derived from', depends_on: 'depends on', example_of: 'example of', related: 'related to',
};

export function recall(vault: Vault, cue: string, options: RecallOptions = {}): RecallPack {
  vault.requireVerb('recall');
  const db = vault.store.db;
  const budget = options.budget ?? vault.config.budget.recallChars;
  const limit = options.limit ?? 12;
  const pieces = [...new Set([...queryPieces(cue), ...looseTerms(cue)])];
  const candidates = new Map<string, Candidate>();
  const rowOf = db.prepare('SELECT nid, path, title, kind, source, sensitivity, status, date, hash FROM notes WHERE path = ?');
  const offer = (row: Row | undefined, relevance: number, why: string) => {
    if (!row || !vault.canSee(row)) return;
    const known = candidates.get(row.path);
    if (known) {
      if (!known.why.includes(why)) known.why.push(why);
      known.relevance = Math.max(known.relevance, relevance) + Math.min(known.relevance, relevance) * 0.25;
    } else candidates.set(row.path, { row, relevance, why: [why] });
  };

  // Seeds: full text, any piece; every piece counts extra.
  const search = (mode: 'all' | 'loose', count: number) => {
    const expression = mode === 'all' ? matchExpression(cue, 'all') : looseExpression(cue) ?? matchExpression(cue, 'any');
    if (!expression) return [];
    return db.prepare(`SELECT n.nid, n.path, n.title, n.kind, n.source, n.sensitivity, n.status, n.date, n.hash, bm25(fts, 8.0, 3.0, 1.0) AS rank
      FROM fts JOIN notes n ON n.nid = fts.rowid WHERE fts MATCH ? ORDER BY rank LIMIT ?`).all(expression, count) as unknown as (Row & { rank: number })[];
  };
  // An agent's hidden notes must not crowd out what it can see.
  const any = search('loose', vault.principal.owner ? 80 : 600);
  const best = any.length > 0 ? -any[0]!.rank : 1;
  // A title is the note's own summary: the share of the cue's words it holds counts on top.
  const terms = looseTerms(cue);
  const titleShare = (row: Row) => {
    if (terms.length === 0) return 0;
    const title = `${row.title} ${row.path.slice(row.path.lastIndexOf('/') + 1)}`.toLowerCase();
    return terms.filter((term) => title.includes(term)).length / terms.length;
  };
  for (const row of any) {
    const share = titleShare(row);
    offer(row, Math.max(0.05, -row.rank / best) + 0.6 * share, share >= 0.5 ? 'the title answers the cue' : 'matches the cue');
  }
  for (const row of search('all', 40)) offer(row, 0.35, 'matches every word of the cue');

  // Seeds: the cue is a title, an id or an alias.
  const exact = db.prepare(`SELECT n.nid, n.path, n.title, n.kind, n.source, n.sensitivity, n.status, n.date, n.hash FROM notes n
    WHERE lower(n.title) = lower(?) UNION SELECT n.nid, n.path, n.title, n.kind, n.source, n.sensitivity, n.status, n.date, n.hash
    FROM aliases a JOIN notes n ON n.path = a.path WHERE a.key = ?`).all(cue.trim(), aliasKey(cue)) as unknown as Row[];
  for (const row of exact) offer(row, 1.2, 'named by the cue');

  // Seeds: where the caller is, and what is around it.
  const from = options.from ? vault.find(options.from) : null;
  if (from) offer(rowOf.get(from.path) as Row | undefined, 0.6, 'the note you are in');

  // One hop from the best seeds, along links, relations and association.
  const now = Date.now();
  const weightsAt = Number(vault.store.meta('weights_at') ?? now);
  const half: Record<string, number> = { visit: vault.config.halfLife.visit, co_change: vault.config.halfLife.coChange };
  const seeds = [...candidates.values()].sort((left, right) => right.relevance - left.relevance).slice(0, 10);
  const outLinks = db.prepare(`SELECT DISTINCT resolved AS other, relation FROM links WHERE src = ? AND resolved IS NOT NULL AND kind != 'img'`);
  const inLinks = db.prepare(`SELECT DISTINCT src AS other, relation FROM links WHERE resolved = ? AND kind != 'img'`);
  const associated = db.prepare(`SELECT CASE WHEN a = ? THEN b ELSE a END AS other, type, weight, count FROM edges WHERE a = ? OR b = ?`);
  for (const seed of seeds) {
    const base = seed.relevance;
    const title = seed.row.title;
    for (const link of outLinks.all(seed.row.path) as { other: string; relation: string | null }[]) {
      const strength = link.relation ? 0.6 : 0.4;
      offer(rowOf.get(link.other) as Row | undefined, base * strength,
        link.relation ? `"${title}" is ${RELATION_WORDS[link.relation] ?? link.relation} this` : `linked from "${title}"`);
    }
    for (const link of inLinks.all(seed.row.path) as { other: string; relation: string | null }[]) {
      const strength = link.relation ? 0.55 : 0.3;
      offer(rowOf.get(link.other) as Row | undefined, base * strength,
        link.relation ? `${RELATION_WORDS[link.relation] ?? link.relation} "${title}"` : `links to "${title}"`);
    }
    for (const edge of associated.all(seed.row.path, seed.row.path, seed.row.path) as { other: string; type: string; weight: number; count: number }[]) {
      const weight = edge.weight * decay(now - weightsAt, half[edge.type] ?? 60);
      const strength = 0.45 * (weight / (1 + weight));
      if (strength < 0.05) continue;
      offer(rowOf.get(edge.other) as Row | undefined, base * strength,
        edge.type === 'visit' ? `often opened with "${title}"` : `often changed with "${title}"`);
    }
  }

  // Shape by kind, heat, source and status; let superseded notes give way.
  const scored = [...candidates.values()].map((candidate) => {
    const { row } = candidate;
    const heat = vault.heatOf(row.path, now).heat;
    const superseded = vault.isSuperseded(row.path);
    const status = superseded ? 0.35 : row.status === 'archived' ? 0.8 : 1;
    const score = candidate.relevance * KIND_WEIGHT[row.kind] * (1 + 0.15 * Math.log1p(heat)) * (SOURCE_WEIGHT[row.source ?? ''] ?? 1) * status;
    return { ...candidate, score, superseded };
  }).sort((left, right) => right.score - left.score);

  const chosen: typeof scored = [];
  const hashes = new Set<string>();
  for (const candidate of scored) {
    if (hashes.has(candidate.row.hash)) continue;
    if (candidate.superseded) {
      const successor = db.prepare(`SELECT src FROM links WHERE resolved = ? AND relation = 'supersedes' UNION
        SELECT resolved FROM links WHERE src = ? AND relation = 'superseded_by' AND resolved IS NOT NULL`).all(candidate.row.path, candidate.row.path) as { src: string }[];
      if (successor.some((row) => candidates.has(row.src))) continue;
      candidate.why.push('superseded');
    }
    hashes.add(candidate.row.hash);
    chosen.push(candidate);
    if (chosen.length >= limit * 2) break;
  }

  // Pack: the first items get more room.
  const items: RecallItem[] = [];
  let spent = 0;
  for (const [index, candidate] of chosen.entries()) {
    if (items.length >= limit) break;
    const room = Math.min(index < 3 ? 900 : 400, budget - spent);
    if (room < 120 && items.length > 0) break;
    // The note's own words first; a note that is all generated list still shows that list.
    const excerpt = excerptOf(vault.readableText(candidate.row.path) ?? '', pieces, room)
      || excerptOf(vault.textOf(candidate.row.path) ?? '', pieces, room);
    spent += excerpt.length;
    items.push({
      path: candidate.row.path, title: candidate.row.title, kind: candidate.row.kind, source: candidate.row.source,
      date: candidate.row.date, status: candidate.superseded ? 'superseded' : candidate.row.status,
      score: Math.round(candidate.score * 1000) / 1000, why: candidate.why.slice(0, 3), excerpt,
    });
  }
  vault.recordEvent('recall', items.map((item) => item.path), { query: cue });
  return { cue, items, chars: spent, omitted: Math.max(0, chosen.length - items.length) };
}

/**
 * The blocks of a note that matter for the cue, with the heading they sit
 * under; the opening of the note when nothing matches.
 */
export function excerptOf(text: string, pieces: readonly string[], room: number): string {
  const body = text.replace(/^---\n[\s\S]*?\n---\n/, '');
  const blocks: { text: string; heading: string }[] = [];
  let heading = '';
  let fence = false;
  let current: string[] = [];
  const flush = () => {
    const joined = current.join('\n').trim();
    if (joined) blocks.push({ text: joined, heading });
    current = [];
  };
  for (const line of body.split('\n')) {
    if (/^(```|~~~)/.test(line.trim())) fence = !fence;
    if (!fence && /^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#+\s*/, '').trim();
      continue;
    }
    if (!fence && line.trim() === '') { flush(); continue; }
    current.push(line);
  }
  flush();
  if (blocks.length === 0) return '';
  const lowered = pieces.map((piece) => piece.toLowerCase());
  const scored = blocks.map((block, index) => {
    const lower = block.text.toLowerCase();
    const hits = lowered.filter((piece) => lower.includes(piece)).length;
    return { block, index, hits };
  });
  const matching = scored.filter((entry) => entry.hits > 0).sort((left, right) => right.hits - left.hits || left.index - right.index).slice(0, 2)
    .sort((left, right) => left.index - right.index);
  const picked = matching.length > 0 ? matching : scored.slice(0, 1);
  const parts: string[] = [];
  let lastHeading = '';
  for (const entry of picked) {
    if (entry.block.heading && entry.block.heading !== lastHeading) parts.push(`§ ${entry.block.heading}`);
    lastHeading = entry.block.heading;
    parts.push(entry.block.text);
  }
  const joined = parts.join('\n');
  return joined.length <= room ? joined : `${joined.slice(0, Math.max(0, room - 1)).trimEnd()}…`;
}
