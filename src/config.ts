/**
 * `.noto/brain.yaml`: how this vault's notes map onto the four kinds, its
 * relation words, and the two dials, forgetting (half-lives) and laziness
 * (budgets). Every key is optional; a vault without the file gets the
 * defaults below.
 */

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
}

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
};

const num = (value: YamlValue | undefined, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
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
  };
}
