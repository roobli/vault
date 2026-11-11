/**
 * `.noto/brain.yaml`: how this vault's notes map onto the four kinds, its
 * relation words, and the two dials, forgetting (half-lives) and laziness
 * (budgets). Every key is optional; a vault without the file gets the
 * defaults below.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_RELATIONS } from './markdown.js';
import { parseYamlMap, type YamlValue } from './yaml.js';

export type Kind = 'log' | 'note' | 'card' | 'decision';
export const KINDS: readonly Kind[] = ['log', 'note', 'card', 'decision'];
export type Source = 'lived' | 'seen' | 'heard';
export const SOURCES: readonly Source[] = ['lived', 'seen', 'heard'];

export interface BrainConfig {
  /** Globs kept out of the index, beyond dot-folders and `node_modules`. */
  readonly ignore: readonly string[];
  readonly kinds: {
    /** Frontmatter keys read for the kind, first match wins. */
    readonly fields: readonly string[];
    /** Their values, mapped onto a kind. */
    readonly map: Readonly<Record<string, Kind>>;
    /** File names that make a note a card when it carries an `id` or `moc: true`. */
    readonly cards: readonly string[];
    /** Whether a file name that starts with a date makes a note a log. */
    readonly datedNamesAreLogs: boolean;
  };
  /** Relation word to relation, the defaults plus the vault's own. */
  readonly relations: Readonly<Record<string, string>>;
  /** Half-lives in days: heat per kind, and edges per type. */
  readonly halfLife: {
    readonly heat: Readonly<Record<Kind, number>>;
    readonly visit: number;
    readonly coChange: number;
  };
  readonly visit: {
    /** Two opens further apart than this are not one train of thought. */
    readonly windowMinutes: number;
    /** An agent's reads count this much of a person's. */
    readonly agentWeight: number;
  };
  readonly coChange: {
    /** A commit that changes more notes than this says nothing about which belong together. */
    readonly maxNotes: number;
  };
  readonly git: {
    /** A commit that changes more notes than this is a snapshot or a sweep: its renames count, its writes do not. */
    readonly bulkNotes: number;
  };
  readonly budget: {
    /** Items handed to the person for review in a day. */
    readonly dailyReviews: number;
    /** Characters in a recall pack, unless the caller says otherwise. */
    readonly recallChars: number;
  };
  readonly append: {
    /** Where `append` writes when not told: a template with {yyyy} {mm} {dd}. */
    readonly path: string;
  };
  /** The heading a relation list gets when one is added to a note; empty for none. */
  readonly relationsHeading: string;
  readonly suggest: {
    /**
     * Paths whose notes are never asked to link to anything: records kept as
     * they were written, such as archives and daily digests.
     */
    readonly skipFrom: readonly string[];
    /**
     * Paths whose notes are never offered as a link's target: copies of other
     * people's text, such as vendored manuals.
     */
    readonly skipTo: readonly string[];
  };
  /** Every number that shapes how recall ranks and how many candidates it weighs. */
  readonly recall: RecallConfig;
}

/**
 * `recall:` in `brain.yaml`. Weights are non-negative numbers; counts are
 * whole numbers, zero switching that source of candidates off. A value out
 * of range is ignored, as elsewhere in the config, and the default holds.
 */
export interface RecallConfig {
  /** Score factor per kind (`kind_weight`). */
  readonly kindWeight: Readonly<Record<Kind, number>>;
  /** Score factor per way of knowing (`source_weight`); a note whose source is unknown gets 1. */
  readonly sourceWeight: Readonly<Record<Source, number>>;
  /** Score factor for a superseded note, and for one whose status is `archived` (`status_weight`). */
  readonly statusWeight: { readonly superseded: number; readonly archived: number };
  /** The score is multiplied by `1 + heat * ln(1 + the note's heat)` (`heat`). */
  readonly heat: number;
  /** Notes in a pack when the caller does not say (`limit`, at least 1). */
  readonly limit: number;
  /** Candidates kept for the pack, per note it may hold (`pool`, at least 1); the rest are never weighed for it. */
  readonly pool: number;
  /** Full-text matches read for the owner (`text_candidates`). */
  readonly textCandidates: number;
  /** The same for anyone else, whose hidden notes must not crowd out what it can see (`text_candidates_shared`). */
  readonly textCandidatesShared: number;
  /** BM25 weights of the title, path and body columns (`bm25`). */
  readonly bm25: { readonly title: number; readonly path: number; readonly body: number };
  /** The least relevance a full-text match gets, as a share of the best (`text_floor`). */
  readonly textFloor: number;
  /** Added per share of the cue's words the title holds (`title_share`). */
  readonly titleShare: number;
  /** Matches of every word of the cue read (`all_words_candidates`), and the relevance each gets (`all_words`). */
  readonly allWordsCandidates: number;
  readonly allWords: number;
  /** Relevance of a note the cue names by title, id or alias (`named`). */
  readonly named: number;
  /** Relevance of the note the caller is in (`from`). */
  readonly from: number;
  /** A note reached a second way gains this share of the weaker relevance (`merge`). */
  readonly merge: number;
  /** The best seeds one hop goes out from (`hop_seeds`). */
  readonly hopSeeds: number;
  /** Share of a seed's relevance passed along each kind of link (`hop`). */
  readonly hop: {
    readonly linkOut: number;
    readonly relationOut: number;
    readonly linkIn: number;
    readonly relationIn: number;
    /** An association edge of decayed weight `w` passes `edge * w / (1 + w)`. */
    readonly edge: number;
    /** An edge passing less than this share is not followed. */
    readonly edgeFloor: number;
  };
}

export const DEFAULT_RECALL: RecallConfig = {
  kindWeight: { decision: 1.3, card: 1.2, note: 1, log: 0.85 },
  sourceWeight: { lived: 1.15, seen: 1, heard: 0.85 },
  statusWeight: { superseded: 0.35, archived: 0.8 },
  heat: 0.15,
  limit: 12,
  pool: 2,
  textCandidates: 80,
  textCandidatesShared: 600,
  bm25: { title: 8, path: 3, body: 1 },
  textFloor: 0.05,
  titleShare: 0.6,
  allWordsCandidates: 40,
  allWords: 0.35,
  named: 1.2,
  from: 0.6,
  merge: 0.25,
  hopSeeds: 10,
  hop: { linkOut: 0.4, relationOut: 0.6, linkIn: 0.3, relationIn: 0.55, edge: 0.45, edgeFloor: 0.05 },
};

export const DEFAULT_CONFIG: BrainConfig = {
  ignore: [],
  kinds: {
    fields: ['kind', 'type'],
    map: { log: 'log', note: 'note', card: 'card', moc: 'card', decision: 'decision' },
    cards: ['00_索引.md', 'index.md', 'README.md'],
    datedNamesAreLogs: true,
  },
  relations: DEFAULT_RELATIONS,
  halfLife: {
    heat: { log: 14, note: 30, card: 90, decision: 180 },
    visit: 60,
    coChange: 120,
  },
  visit: { windowMinutes: 10, agentWeight: 0.25 },
  coChange: { maxNotes: 12 },
  git: { bulkNotes: 100 },
  budget: { dailyReviews: 10, recallChars: 6000 },
  append: { path: 'inbox/{yyyy}-{mm}-{dd}.md' },
  relationsHeading: '',
  suggest: { skipFrom: [], skipTo: [] },
  recall: DEFAULT_RECALL,
};

const num = (value: YamlValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
const weight = (value: YamlValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
const count = (value: YamlValue | undefined, fallback: number, least = 0): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= least ? value : fallback;
const str = (value: YamlValue | undefined, fallback: string): string =>
  typeof value === 'string' ? value : fallback;
const strs = (value: YamlValue | undefined, fallback: readonly string[]): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : fallback;
const map = (value: YamlValue | undefined): Record<string, YamlValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};

export function configPath(root: string): string {
  return path.join(root, '.noto', 'brain.yaml');
}

/** The config, and its text for the fingerprint. */
export function loadConfig(root: string): { config: BrainConfig; text: string } {
  const file = configPath(root);
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  return { config: parseConfig(text), text };
}

export function parseConfig(text: string): BrainConfig {
  const raw = parseYamlMap(text);
  const d = DEFAULT_CONFIG;
  const kinds = map(raw.kinds);
  const kindMap: Record<string, Kind> = { ...d.kinds.map };
  for (const [value, kind] of Object.entries(map(kinds.map))) {
    if (typeof kind === 'string' && (KINDS as readonly string[]).includes(kind)) kindMap[value] = kind as Kind;
  }
  const relations: Record<string, string> = { ...d.relations };
  for (const [word, relation] of Object.entries(map(raw.relations))) {
    if (typeof relation === 'string') relations[word.toLowerCase()] = relation;
  }
  const half = map(raw.half_life_days);
  const heatByKind = map(half.heat_by_kind);
  const heat = Object.fromEntries(KINDS.map((kind) => [kind, num(heatByKind[kind], num(half.heat, d.halfLife.heat[kind]))])) as Record<Kind, number>;
  const visit = map(raw.visit);
  const coChange = map(raw.co_change);
  const gitConfig = map(raw.git);
  const budget = map(raw.budget);
  const append = map(raw.append);
  const suggestSection = map(raw.suggest);
  return {
    ignore: strs(raw.ignore, d.ignore),
    kinds: {
      fields: strs(kinds.fields, d.kinds.fields),
      map: kindMap,
      cards: strs(kinds.cards, d.kinds.cards),
      datedNamesAreLogs: typeof kinds.dated_names_are_logs === 'boolean' ? kinds.dated_names_are_logs : d.kinds.datedNamesAreLogs,
    },
    relations,
    halfLife: { heat, visit: num(half.visit, d.halfLife.visit), coChange: num(half.co_change, d.halfLife.coChange) },
    visit: { windowMinutes: num(visit.window_minutes, d.visit.windowMinutes), agentWeight: num(visit.agent_weight, d.visit.agentWeight) },
    coChange: { maxNotes: num(coChange.max_notes, d.coChange.maxNotes) },
    git: { bulkNotes: num(gitConfig.bulk_notes, d.git.bulkNotes) },
    budget: { dailyReviews: num(budget.daily_reviews, d.budget.dailyReviews), recallChars: num(budget.recall_chars, d.budget.recallChars) },
    append: { path: str(append.path, d.append.path) },
    relationsHeading: str(raw.relations_heading, d.relationsHeading),
    suggest: { skipFrom: strs(suggestSection.skip_from, d.suggest.skipFrom), skipTo: strs(suggestSection.skip_to, d.suggest.skipTo) },
    recall: parseRecallConfig(raw.recall),
  };
}

/**
 * A `recall:` section over `base`: what it says in range, and `base` for the
 * rest. The vault's config reads it over the defaults; a shadow file is read
 * over the vault's config, so it names only what it changes.
 */
export function parseRecallConfig(section: YamlValue | undefined, base: RecallConfig = DEFAULT_RECALL): RecallConfig {
  const raw = map(section);
  const kinds = map(raw.kind_weight);
  const sources = map(raw.source_weight);
  const status = map(raw.status_weight);
  const bm25 = map(raw.bm25);
  const hop = map(raw.hop);
  return {
    kindWeight: Object.fromEntries(KINDS.map((kind) => [kind, weight(kinds[kind], base.kindWeight[kind])])) as Record<Kind, number>,
    sourceWeight: Object.fromEntries(SOURCES.map((source) => [source, weight(sources[source], base.sourceWeight[source])])) as Record<Source, number>,
    statusWeight: { superseded: weight(status.superseded, base.statusWeight.superseded), archived: weight(status.archived, base.statusWeight.archived) },
    heat: weight(raw.heat, base.heat),
    limit: count(raw.limit, base.limit, 1),
    pool: count(raw.pool, base.pool, 1),
    textCandidates: count(raw.text_candidates, base.textCandidates),
    textCandidatesShared: count(raw.text_candidates_shared, base.textCandidatesShared),
    bm25: { title: weight(bm25.title, base.bm25.title), path: weight(bm25.path, base.bm25.path), body: weight(bm25.body, base.bm25.body) },
    textFloor: weight(raw.text_floor, base.textFloor),
    titleShare: weight(raw.title_share, base.titleShare),
    allWordsCandidates: count(raw.all_words_candidates, base.allWordsCandidates),
    allWords: weight(raw.all_words, base.allWords),
    named: weight(raw.named, base.named),
    from: weight(raw.from, base.from),
    merge: weight(raw.merge, base.merge),
    hopSeeds: count(raw.hop_seeds, base.hopSeeds),
    hop: {
      linkOut: weight(hop.link_out, base.hop.linkOut),
      relationOut: weight(hop.relation_out, base.hop.relationOut),
      linkIn: weight(hop.link_in, base.hop.linkIn),
      relationIn: weight(hop.relation_in, base.hop.relationIn),
      edge: weight(hop.edge, base.hop.edge),
      edgeFloor: weight(hop.edge_floor, base.hop.edgeFloor),
    },
  };
}

/** A short hash of a recall config, so measurements made under different numbers can be told apart. */
export function recallConfigHash(config: RecallConfig): string {
  // Keys sorted at every level, so the same numbers hash the same however the object was built.
  const canonical = (value: unknown): unknown => (value !== null && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, item]) => [key, canonical(item)]))
    : value);
  return createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex').slice(0, 8);
}
