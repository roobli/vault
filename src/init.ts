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
