/**
 * What it takes for a folder to keep memory: the `.noto/` folder with its
 * settings, made once. `noto-vault init` runs this, and so does an editor
 * that has asked the person first. Nothing that is already there is touched.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accessPath } from './access.js';
import { configPath } from './config.js';

export const BRAIN_TEMPLATE = `# How this vault's notes map onto the framework. Every key is optional.
# See the design: kinds by when a note is true, two dials (forgetting, laziness).

# Globs kept out of the index, beyond dot-folders and node_modules.
ignore: []

kinds:
  # Frontmatter keys read for the kind, first match wins, and their values.
  fields: [kind, type]
  map: {log: log, moc: card, card: card, decision: decision}
  # These file names are cards when they carry an id or moc: true.
  cards: [00_索引.md, index.md, README.md]
  dated_names_are_logs: true

# Extra relation words, at the start of a list item followed by links.
relations: {}

# Forgetting: half-lives in days.
half_life_days:
  heat_by_kind: {log: 14, note: 30, card: 90, decision: 180}
  visit: 60
  co_change: 120

co_change:
  max_notes: 12

# Laziness: how much to hand the person, and how much recall returns.
budget:
  daily_reviews: 10
  recall_chars: 6000

append:
  path: "inbox/{yyyy}-{mm}-{dd}.md"

# Link suggestions: notes never asked to link (kept as written), and notes
# never offered as a target (copies of others' text). Paths as in ignore:.
suggest:
  skip_from: []
  skip_to: []

# How recall ranks, at its defaults. Weights are numbers of 0 or more; counts
# are whole numbers, 0 switching that source of candidates off. A value out
# of range keeps its default. A note's score is its relevance times
# kind_weight, times 1 + heat * ln(1 + the note's heat), times source_weight
# (1 when unknown), times status_weight.
recall:
  kind_weight: {decision: 1.3, card: 1.2, note: 1, log: 0.85}
  source_weight: {lived: 1.15, seen: 1, heard: 0.85}
  status_weight: {superseded: 0.35, archived: 0.8}
  heat: 0.15
  # Notes in a pack when the caller does not say (at least 1), and candidates
  # kept per note the pack may hold (at least 1).
  limit: 12
  pool: 2
  # Full-text matches read: for the owner, and for anyone else, whose hidden
  # notes must not crowd out what it can see.
  text_candidates: 80
  text_candidates_shared: 600
  # BM25 weights of the title, the path and the body.
  bm25: {title: 8, path: 3, body: 1}
  # A full-text match's relevance is its BM25 score as a share of the best,
  # at least text_floor, plus title_share times the share of the cue's words
  # in its title.
  text_floor: 0.05
  title_share: 0.6
  # Matches of every word of the cue read, and the relevance each gets.
  all_words_candidates: 40
  all_words: 0.35
  # Relevance of a note the cue names (title, id, alias), and of the note you are in.
  named: 1.2
  from: 0.6
  # A note reached a second way gains this share of the weaker relevance.
  merge: 0.25
  # One hop goes out from the best hop_seeds, passing this share of a seed's
  # relevance along a plain link or a typed relation, out of the seed or into
  # it; an edge of decayed weight w passes edge * w / (1 + w), and is not
  # followed below edge_floor.
  hop_seeds: 10
  hop: {link_out: 0.4, relation_out: 0.6, link_in: 0.3, relation_in: 0.55, edge: 0.45, edge_floor: 0.05}
`;

export const ACCESS_TEMPLATE = `# Who may read and write what. The owner (you, at this CLI) may do anything.
# A sealed note is never given to anyone but the owner. .noto/ and .git/ are
# never writable by anyone else.

sensitivity:
  default: open
  private: []
  sealed: []

principals:
  # An agent without a key: reads what is open, writes nothing.
  default:
    read: ["**"]
    max_sensitivity: open
    verbs: [read, search, recall]
`;

/** Make what is missing of `.noto/`; returns what was made, folder-relative. */
export function initVault(root: string): string[] {
  mkdirSync(path.join(root, '.noto', 'scripts'), { recursive: true });
  const made: string[] = [];
  if (!existsSync(configPath(root))) { writeFileSync(configPath(root), BRAIN_TEMPLATE); made.push('.noto/brain.yaml'); }
  if (!existsSync(accessPath(root))) { writeFileSync(accessPath(root), ACCESS_TEMPLATE); made.push('.noto/access.yaml'); }
  const ignore = path.join(root, '.noto', '.gitignore');
  if (!existsSync(ignore)) { writeFileSync(ignore, '# The index is a cache: delete it at any time.\nindex.sqlite*\n'); made.push('.noto/.gitignore'); }
  return made;
}
