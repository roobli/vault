/**
 * `noto-vault`: the verbs from a shell, for the person, for scripts, and for
 * agents that have a shell. The CLI acts as the owner unless
 * `NOTO_VAULT_KEY` names another principal.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { accessPath, keyHash } from './access.js';
import { configPath } from './config.js';
import { formatRead, formatRecall, formatSearch, formatSuggestions } from './format.js';
import { serve } from './mcp.js';
import { recall } from './recall.js';
import { suggest, toChanges, type SuggestionType } from './suggest.js';
import { AccessError, ConflictError, Vault } from './vault.js';
import { parseYaml } from './yaml.js';

const HELP = `noto-vault: a vault of Markdown notes as memory

  noto-vault init                       set up .noto/ in this folder
  noto-vault index [--full]             bring the index up to date
  noto-vault status                     what the index holds
  noto-vault recall <cue...>            the notes that matter for a cue  [--from note] [--budget chars]
  noto-vault search <query...>          full text  [--limit n] [--kind k] [--folder dir]
  noto-vault read <note>                a note with its links, hash and heat  [--meta]
  noto-vault backlinks <note>           what links here
  noto-vault where <id or name>         where a project or note lives now
  noto-vault visit <note> [--from n]    record that you opened a note
  noto-vault graph [--out file]         nodes and edges as JSON  [--types a,b] [--min w]
  noto-vault suggest                    links that are missing  [--types mention,together,stale,script] [--from note] [--limit n]
                                        [--propose [--message m]] write them as a proposal instead of listing them
  noto-vault proposals [show|accept|reject <id>]
  noto-vault append <text...>           a dated entry in today's log  [--to note]   (text "-" reads stdin)
  noto-vault write <note> --base <hash> the note's new text from stdin  (--base new to create)
  noto-vault link <from> <to>           a typed relation line  [--rel related]
  noto-vault supersede <old> <new>      mark old as superseded by new
  noto-vault key add <principal>        make a key for an agent and add it to .noto/access.yaml
  noto-vault eval <cases.yaml>          how well recall finds what it should  [--k 5] [--search]
  noto-vault mcp [--owner]              serve the vault over MCP on stdio

  --root <dir>   the vault (default: the nearest folder above with .noto/)
  --json         machine-readable output`;

function findRoot(start: string): string | null {
  let at = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(at, '.noto'))) return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}

const BRAIN_TEMPLATE = `# How this vault's notes map onto the framework. Every key is optional.
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

const ACCESS_TEMPLATE = `# Who may read and write what. The owner (you, at this CLI) may do anything.
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

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: 'string' }, json: { type: 'boolean' }, full: { type: 'boolean' }, limit: { type: 'string' }, kind: { type: 'string' },
      folder: { type: 'string' }, from: { type: 'string' }, budget: { type: 'string' }, out: { type: 'string' }, types: { type: 'string' },
      min: { type: 'string' }, propose: { type: 'boolean' }, message: { type: 'string' }, to: { type: 'string' }, base: { type: 'string' },
      rel: { type: 'string' }, owner: { type: 'boolean' }, k: { type: 'string' }, search: { type: 'boolean' }, meta: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...rest] = positionals;
  if (!command || values.help || command === 'help') {
    console.log(HELP);
    return 0;
  }
  const json = values.json === true;
  const print = (value: unknown, text: () => string) => console.log(json ? JSON.stringify(value, null, 2) : text());
  const number = (value: unknown, fallback?: number) => (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : fallback);
  const words = rest.join(' ').trim();

  if (command === 'init') {
    const root = path.resolve(typeof values.root === 'string' ? values.root : process.cwd());
    mkdirSync(path.join(root, '.noto', 'scripts'), { recursive: true });
    const made: string[] = [];
    if (!existsSync(configPath(root))) { writeFileSync(configPath(root), BRAIN_TEMPLATE); made.push('.noto/brain.yaml'); }
    if (!existsSync(accessPath(root))) { writeFileSync(accessPath(root), ACCESS_TEMPLATE); made.push('.noto/access.yaml'); }
    const ignore = path.join(root, '.noto', '.gitignore');
    if (!existsSync(ignore)) { writeFileSync(ignore, '# The index is a cache: delete it at any time.\nindex.sqlite*\n'); made.push('.noto/.gitignore'); }
    console.log(made.length > 0 ? `Made ${made.join(', ')}. Run noto-vault index next.` : '.noto/ is already set up.');
    return 0;
  }

  const root = typeof values.root === 'string' ? path.resolve(values.root) : process.env.NOTO_VAULT_ROOT ? path.resolve(process.env.NOTO_VAULT_ROOT) : findRoot(process.cwd());
  if (!root) {
    console.error('No vault here: run noto-vault init in the vault, or pass --root.');
    return 2;
  }

  if (command === 'key') {
    if (rest[0] !== 'add' || !rest[1] || !/^[A-Za-z0-9._-]+$/.test(rest[1])) {
      console.error('Usage: noto-vault key add <principal>   (letters, digits, . _ -)');
      return 2;
    }
    const name = rest[1];
    const key = randomBytes(24).toString('base64url');
    const file = accessPath(root);
    const text = existsSync(file) ? readFileSync(file, 'utf8') : ACCESS_TEMPLATE;
    const parsed = parseYaml(text) as { principals?: Record<string, unknown> } | null;
    if (parsed?.principals && name in parsed.principals) {
      console.log(`${name} is already in .noto/access.yaml. Add this to its keys list:\n  ${keyHash(key)}\n\nThe key, shown once:\n  ${key}`);
      return 0;
    }
    const block = [
      `  ${name}:`,
      `    keys: [${keyHash(key)}]`,
      '    read: ["**"]',
      '    max_sensitivity: private',
      '    # Paths it may append to and write directly; everything else it proposes.',
      '    append: []',
      '    write: []',
      '    verbs: [read, search, recall, append, propose]',
      '',
    ].join('\n');
    if (!existsSync(file)) writeFileSync(file, ACCESS_TEMPLATE);
    if (!/^principals:/m.test(text)) appendFileSync(file, '\nprincipals:\n');
    appendFileSync(file, `${readFileSync(file, 'utf8').endsWith('\n') ? '' : '\n'}${block}`);
    console.log(`Added ${name} to .noto/access.yaml. The key, shown once; give it to the agent as NOTO_VAULT_KEY:\n  ${key}`);
    return 0;
  }

  const key = process.env.NOTO_VAULT_KEY;
  const owner = command === 'mcp' ? values.owner === true : key === undefined || key === '';
  const vault = await Vault.open(root, { owner, ...(owner || !key ? {} : { key }), ...(process.env.NOTO_SESSION ? { session: process.env.NOTO_SESSION } : {}), refresh: command !== 'visit' });
  try {
    switch (command) {
      case 'index': {
        const stats = vault.refresh(values.full ? { full: true } : {});
        print(stats, () => `${stats.notes} notes; parsed ${stats.parsed}, removed ${stats.removed}, moved ${stats.moved}; links ${stats.relinked}; ${stats.commits} commits and ${stats.events} events read; ${stats.ms} ms.`);
        return 0;
      }
      case 'status': {
        const status = vault.status();
        print(status, () => Object.entries(status).map(([name, value]) => `${name}: ${typeof value === 'object' ? JSON.stringify(value) : String(value)}`).join('\n'));
        return 0;
      }
      case 'recall': {
        if (!words) throw new UsageError('recall needs a cue.');
        const budget = number(values.budget);
        const pack = recall(vault, words, { ...(budget ? { budget } : {}), ...(typeof values.from === 'string' ? { from: values.from } : {}) });
        print(pack, () => formatRecall(pack));
        return 0;
      }
      case 'search': {
        if (!words) throw new UsageError('search needs a query.');
        const limit = number(values.limit);
        const hits = vault.search(words, {
          ...(limit ? { limit } : {}),
          ...(typeof values.kind === 'string' ? { kind: values.kind as 'log' } : {}),
          ...(typeof values.folder === 'string' ? { folder: values.folder } : {}),
        });
        print(hits, () => formatSearch(hits));
        return 0;
      }
      case 'read': {
        if (!words) throw new UsageError('read needs a note.');
        const note = vault.read(words);
        print(note, () => formatRead(note, values.meta !== true));
        return 0;
      }
      case 'backlinks': {
        const note = vault.find(words);
        if (!note) throw new UsageError(`No note answers to "${words}".`);
        const links = vault.backlinks(note.path);
        print(links, () => links.length === 0 ? 'Nothing links here.' : links.map((link) => `${link.path}${link.relation ? `  (${link.relation})` : ''}`).join('\n'));
        return 0;
      }
      case 'where': {
        const found = vault.where(words);
        if (!found) throw new UsageError(`Nothing answers to "${words}".`);
        print(found, () => found.folder);
        return 0;
      }
      case 'visit': {
        const note = vault.find(words);
        if (!note) throw new UsageError(`No note answers to "${words}".`);
        vault.visit(note.path, typeof values.from === 'string' ? { from: values.from } : {});
        return 0;
      }
      case 'graph': {
        const min = number(values.min);
        const graph = vault.graph({ ...(min !== undefined ? { minWeight: min } : {}), ...(typeof values.types === 'string' ? { types: values.types.split(',') } : {}) });
        const text = JSON.stringify(graph);
        if (typeof values.out === 'string') {
          writeFileSync(values.out, text);
          console.log(`${graph.nodes.length} nodes and ${graph.edges.length} edges written to ${values.out}.`);
        } else console.log(text);
        return 0;
      }
      case 'suggest': {
        const limit = number(values.limit, values.propose ? 30 : undefined);
        const found = suggest(vault, {
          ...(typeof values.types === 'string' ? { types: values.types.split(',') as SuggestionType[] } : {}),
          ...(typeof values.from === 'string' ? { from: [values.from] } : {}),
          ...(limit ? { limit } : {}),
        });
        if (values.propose) {
          if (found.length === 0) { console.log('No links seem to be missing.'); return 0; }
          const changes = toChanges(vault, found);
          const message = typeof values.message === 'string' ? values.message : `Add ${found.length} links the notes are missing`;
          const result = vault.propose(changes, message);
          print(result, () => `Proposed ${found.length} links in ${result.files.length} notes as ${result.id}.\nReview: noto-vault proposals show ${result.id}\nAccept: noto-vault proposals accept ${result.id}`);
          return 0;
        }
        print(found, () => {
          const shown = found.slice(0, limit ?? 40);
          const counts = Object.entries(found.reduce<Record<string, number>>((all, item) => ({ ...all, [item.type]: (all[item.type] ?? 0) + 1 }), {}))
            .map(([type, n]) => `${n} ${type}`).join(', ');
          return `${formatSuggestions(shown)}${found.length > shown.length ? `\n\n${found.length} in all (${counts}); the strongest ${shown.length} are above. --limit shows more, --json gives all.` : ''}`;
        });
        return 0;
      }
      case 'proposals': {
        const [action, id] = rest;
        if (!action || action === 'list') {
          const list = vault.proposals();
          print(list, () => list.length === 0 ? 'No proposals are waiting.' : list.map((item) => `${item.id}  ${item.author}  ${item.time.slice(0, 16)}\n  ${item.subject}\n  ${item.files.map((file) => `${file.status} ${file.path}`).join('\n  ')}`).join('\n\n'));
          return 0;
        }
        if (!id) throw new UsageError(`proposals ${action} needs an id.`);
        if (action === 'show') { console.log(vault.proposalDiff(id)); return 0; }
        if (action === 'accept') {
          const result = vault.accept(id);
          print(result, () => [
            result.applied.length > 0 ? `Applied: ${result.applied.join(', ')}` : '',
            result.unchanged.length > 0 ? `Already so: ${result.unchanged.join(', ')}` : '',
            result.conflicts.length > 0 ? `Conflicts, left as they are: ${result.conflicts.join(', ')}. The proposal stays; edit and accept again, or reject it.` : 'The changes are in your working tree; commit them as usual.',
          ].filter(Boolean).join('\n'));
          return result.conflicts.length > 0 ? 1 : 0;
        }
        if (action === 'reject') { vault.reject(id); console.log(`Rejected ${id}.`); return 0; }
        throw new UsageError(`Unknown proposals action ${action}.`);
      }
      case 'append': {
        const text = words === '-' ? readFileSync(0, 'utf8') : words;
        if (!text.trim()) throw new UsageError('append needs text.');
        const result = vault.append(text, typeof values.to === 'string' ? { to: values.to } : {});
        print(result, () => `Appended to ${result.path}.`);
        return 0;
      }
      case 'write': {
        if (typeof values.base !== 'string') throw new UsageError('write needs --base <hash> (or --base new).');
        const result = vault.write(words, readFileSync(0, 'utf8'), values.base === 'new' ? null : values.base);
        print(result, () => `Wrote ${result.path}; hash ${result.hash}.`);
        return 0;
      }
      case 'link': {
        const [from, to] = rest;
        if (!from || !to) throw new UsageError('link needs a note to link from and one to link to.');
        const result = vault.link(from, to, typeof values.rel === 'string' ? values.rel : 'related');
        print(result, () => `Linked from ${result.path}.`);
        return 0;
      }
      case 'supersede': {
        const [older, newer] = rest;
        if (!older || !newer) throw new UsageError('supersede needs the old note and the new one.');
        const result = vault.supersede(older, newer);
        print(result, () => `Done: ${result.paths.join(', ')}.`);
        return 0;
      }
      case 'eval': {
        const file = rest[0];
        if (!file) throw new UsageError('eval needs a cases file.');
        const report = evaluate(vault, file, number(values.k, 5)!, values.search === true);
        print(report, () => report.text);
        return 0;
      }
      case 'mcp':
        await serve(vault);
        return 0;
      default:
        throw new UsageError(`Unknown command ${command}. noto-vault help lists them.`);
    }
  } finally {
    vault.close();
  }
}

class UsageError extends Error {}

interface EvalCase { query: string; expect: string[]; note?: string }

/** Hit rate, recall and mean reciprocal rank at k over a file of cases. */
function evaluate(vault: Vault, file: string, k: number, bySearch: boolean) {
  const cases = parseYaml(readFileSync(file, 'utf8'));
  if (!Array.isArray(cases)) throw new UsageError('The cases file is a YAML list of {query, expect: [paths]}.');
  const rows: { query: string; hit: boolean; recall: number; rank: number | null; top: string[] }[] = [];
  for (const raw of cases as unknown as EvalCase[]) {
    if (!raw || typeof raw.query !== 'string' || !Array.isArray(raw.expect)) continue;
    const expected = raw.expect.map((ref) => vault.find(String(ref))?.path ?? String(ref));
    const ranked = bySearch ? vault.search(raw.query, { limit: k }).map((hit) => hit.path) : recall(vault, raw.query, { limit: k, budget: 1_000_000 }).items.map((item) => item.path);
    const top = ranked.slice(0, k);
    const found = expected.filter((rel) => top.includes(rel));
    const first = top.findIndex((rel) => expected.includes(rel));
    rows.push({ query: raw.query, hit: found.length > 0, recall: expected.length ? found.length / expected.length : 0, rank: first < 0 ? null : first + 1, top });
  }
  const n = rows.length || 1;
  const hitRate = rows.filter((row) => row.hit).length / n;
  const meanRecall = rows.reduce((sum, row) => sum + row.recall, 0) / n;
  const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n;
  const text = [
    `${rows.length} cases, ${bySearch ? 'search' : 'recall'} at ${k}: hit ${(hitRate * 100).toFixed(0)}%, recall ${(meanRecall * 100).toFixed(0)}%, MRR ${mrr.toFixed(2)}`,
    ...rows.filter((row) => !row.hit).map((row) => `  miss: ${row.query}\n    got: ${row.top.slice(0, 3).join(' | ')}`),
  ].join('\n');
  return { cases: rows.length, k, hitRate, recall: meanRecall, mrr, rows, text };
}

export async function run(argv: string[]): Promise<void> {
  try {
    process.exitCode = await main(argv);
  } catch (error) {
    const known = error instanceof UsageError || error instanceof AccessError || error instanceof ConflictError;
    console.error(known ? (error as Error).message : (error as Error).stack ?? String(error));
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
