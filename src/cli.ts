/**
 * `noto-vault`: the verbs from a shell, for the person, for scripts, and for
 * agents that have a shell. The CLI acts as the owner unless
 * `NOTO_VAULT_KEY` names another principal; when an agent runs it for the
 * person, what it does is recorded under the agent's name (`agentActor`), so
 * an agent's recalls and proposals are never counted as the person's.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { about } from './about.js';
import { agentActor, recordEvents, type EventVerb } from './events.js';
import { isMarkdown } from './paths.js';
import { initVault } from './init.js';
import { formatAbout, formatRead, formatRecall, formatSearch, formatSuggestion, formatSuggestions, plainEmphasis, terminalEmphasis } from './format.js';
import { serve } from './mcp.js';
import { recall } from './recall.js';
import { dismiss, suggest, toChanges, type Suggestion, type SuggestionType } from './suggest.js';
import { addAgent, revokeAgent } from './policy.js';
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
  noto-vault about <note>               everything the vault knows about a note  [--limit n per list]
  noto-vault where <id or name>         where a project or note lives now
  noto-vault visit <note> [--from n]    record that you opened a note
  noto-vault graph [--out file]         nodes and edges as JSON  [--types a,b] [--min w]
  noto-vault suggest                    links that are missing  [--types mention,together,stale,script] [--from note] [--limit n, also for --json]
  noto-vault suggest --review           go through them one by one: link it, never, skip; then apply the yes
  noto-vault suggest --propose [id...]  the named ones (or the strongest --limit) as a proposal  [--message m]
  noto-vault suggest --dismiss <id...>  never suggest these again (kept in .noto/dismissed.jsonl)
  noto-vault proposals [show|accept|reject <id>]
  noto-vault append <text...>           a dated entry in today's log  [--to note]   (text "-" reads stdin)
  noto-vault write <note> --base <hash> the note's new text from stdin  (--base new to create)
  noto-vault link <from> <to>           a typed relation line  [--rel related]
  noto-vault supersede <old> <new>      mark old as superseded by new
  noto-vault key add <principal>        make a key for an agent and add it to .noto/access.yaml
  noto-vault key revoke <principal>     take an agent's keys back
  noto-vault eval <cases.yaml>          how well recall finds what it should  [--k 5] [--search]   (records nothing)
  noto-vault record <verb> <path...>    say a note was read or written outside Noto: open, read, cite, write, append
  noto-vault record --hook              the same, from an agent's tool hook on stdin (Claude Code's PostToolUse)
  noto-vault mcp [--owner]              serve the vault over MCP on stdio

  --root <dir>   the vault (default: the nearest folder above with .noto/)
  --json         machine-readable output

  Who is recorded: the person, unless NOTO_VAULT_KEY names an agent, NOTO_ACTOR
  names one, or an agent says so in its environment (Claude Code, Codex).`;

function findRoot(start: string): string | null {
  let at = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(at, '.noto'))) return at;
    const parent = path.dirname(at);
    if (parent === at) return null;
    at = parent;
  }
}


async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    options: {
      root: { type: 'string' }, json: { type: 'boolean' }, full: { type: 'boolean' }, limit: { type: 'string' }, kind: { type: 'string' },
      folder: { type: 'string' }, from: { type: 'string' }, budget: { type: 'string' }, out: { type: 'string' }, types: { type: 'string' },
      min: { type: 'string' }, propose: { type: 'boolean' }, review: { type: 'boolean' }, dismiss: { type: 'boolean' }, message: { type: 'string' }, to: { type: 'string' }, base: { type: 'string' },
      rel: { type: 'string' }, owner: { type: 'boolean' }, k: { type: 'string' }, search: { type: 'boolean' }, meta: { type: 'boolean' },
      hook: { type: 'boolean' },
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
    const made = initVault(root);
    console.log(made.length > 0 ? `Made ${made.join(', ')}. Run noto-vault index next.` : '.noto/ is already set up.');
    return 0;
  }

  // Before any vault is opened: it runs after every edit an agent makes, and needs no index.
  if (command === 'record') return record(rest, values.hook === true, typeof values.root === 'string' ? path.resolve(values.root) : null);

  const root = typeof values.root === 'string' ? path.resolve(values.root) : process.env.NOTO_VAULT_ROOT ? path.resolve(process.env.NOTO_VAULT_ROOT) : findRoot(process.cwd());
  if (!root) {
    console.error('No vault here: run noto-vault init in the vault, or pass --root.');
    return 2;
  }

  if (command === 'key') {
    const name = rest[1];
    if (!['add', 'revoke'].includes(rest[0] ?? '') || !name) {
      console.error('Usage: noto-vault key add <principal>   (letters, digits, . _ -)\n       noto-vault key revoke <principal>');
      return 2;
    }
    if (rest[0] === 'revoke') {
      const changed = revokeAgent(root, name);
      console.log(changed ? `Took ${name}'s keys back; a running server stops answering it on its next request.` : `.noto/access.yaml names no ${name}.`);
      return changed ? 0 : 1;
    }
    try {
      // What an agent added here may do: read private notes too, and propose changes.
      const { key } = addAgent(root, { name, reads: 'private', may: 'propose' });
      console.log(`Added ${name} to .noto/access.yaml. The key, shown once; give it to the agent as NOTO_VAULT_KEY:\n  ${key}`);
      return 0;
    } catch (error) {
      console.error((error as Error).message);
      return 1;
    }
  }

  // A server answers for a folder that keeps memory and never starts keeping it: opening the vault
  // would make .noto anew under no policy, which gives an agent without a key every open note.
  if (command === 'mcp' && !existsSync(path.join(root, '.noto'))) {
    console.error(`${root} does not keep memory (it has no .noto folder), so there is nothing to serve. Keep memory for it in Noto, or run noto-vault init there.`);
    return 2;
  }

  const key = process.env.NOTO_VAULT_KEY;
  const owner = command === 'mcp' ? values.owner === true : key === undefined || key === '';
  // A server is the agent's own, under its key or as the owner it was started as; the command line may be an agent's hands.
  const acting = owner && command !== 'mcp' ? agentActor() : null;
  const session = process.env.NOTO_SESSION || acting?.session;
  const opening = { owner, ...(owner || !key ? {} : { key }), ...(session ? { session } : {}), ...(acting ? { actor: acting.actor } : {}) };
  const vault = await Vault.open(root, { ...opening, refresh: command !== 'visit' });
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
      case 'about': {
        if (!words) throw new UsageError('about needs a note.');
        // Anyone else gets about's own refusal, which says the same for a hidden note as for a missing one.
        if (vault.principal.owner && !vault.find(words)) throw new UsageError(`No note answers to "${words}".`);
        const limit = number(values.limit);
        const info = about(vault, words, limit !== undefined ? { limit } : {});
        print(info, () => formatAbout(info));
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
        const options = {
          ...(typeof values.types === 'string' ? { types: values.types.split(',') as SuggestionType[] } : {}),
          ...(typeof values.from === 'string' ? { from: [values.from] } : {}),
        };
        const found = suggest(vault, options);
        const emphasis = process.stdout.isTTY && !process.env.NO_COLOR ? terminalEmphasis : plainEmphasis;
        if (values.review) return await review(vault, found.slice(0, number(values.limit, found.length)), emphasis);
        // Ids name suggestions; an id stands for every suggestion of its kind between its two notes.
        const named = (ids: readonly string[]): Suggestion[] => {
          const unknown = ids.filter((id) => !found.some((item) => item.id === id));
          if (unknown.length > 0) throw new UsageError(`No suggestion has the id ${unknown.join(', ')}. noto-vault suggest lists them.`);
          return found.filter((item) => ids.includes(item.id));
        };
        if (values.dismiss) {
          if (rest.length === 0) throw new UsageError('suggest --dismiss needs the ids to dismiss.');
          const count = dismiss(vault, named(rest));
          console.log(`Dismissed ${count}; they will not be suggested again. The list is .noto/dismissed.jsonl.`);
          return 0;
        }
        if (values.propose) {
          const chosen = rest.length > 0 ? named(rest) : found.slice(0, number(values.limit, 30));
          if (chosen.length === 0) { console.log('No links seem to be missing.'); return 0; }
          const result = vault.propose(toChanges(vault, chosen), typeof values.message === 'string' ? values.message : `Add ${chosen.length} links the notes are missing`);
          print(result, () => `Proposed ${chosen.length} links in ${result.files.length} notes as ${result.id}.\nReview: noto-vault proposals show ${result.id}\nAccept: noto-vault proposals accept ${result.id}`);
          return 0;
        }
        const limit = number(values.limit, 40)!;
        print(typeof values.limit === 'string' ? found.slice(0, limit) : found, () => {
          const shown = found.slice(0, limit);
          const counts = Object.entries(found.reduce<Record<string, number>>((all, item) => ({ ...all, [item.type]: (all[item.type] ?? 0) + 1 }), {}))
            .map(([type, n]) => `${n} ${type}`).join(', ');
          const more = found.length > shown.length ? `\n\n${found.length} in all (${counts}); the strongest ${shown.length} are above. --limit shows more, --json gives all.` : '';
          return `${formatSuggestions(shown, emphasis)}${more}${found.length > 0 ? '\n\nTo apply: noto-vault suggest --review, or --propose <id...>; --dismiss <id...> to never see one again.' : ''}`;
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
        await serve(vault, {
          reopen: () => Vault.open(root, opening),
        });
        return 0;
      default:
        throw new UsageError(`Unknown command ${command}. noto-vault help lists them.`);
    }
  } finally {
    vault.close();
  }
}

class UsageError extends Error {}

/**
 * One question per suggestion, strongest first. The yes ones become one
 * proposal and, if the person says so, are applied at once the way accepting
 * it would; the no ones are dismissed. Stopping keeps what was answered;
 * Ctrl-C keeps nothing.
 */
async function review(vault: Vault, items: readonly Suggestion[], emphasis: (text: string) => string): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new UsageError('--review asks a question per suggestion, so it needs a terminal. Without one: suggest --propose <id...> and --dismiss <id...>.');
  }
  if (items.length === 0) { console.log('No links seem to be missing.'); return 0; }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let aborted = false;
  prompt.on('SIGINT', () => { aborted = true; prompt.close(); });
  const ask = async (question: string): Promise<string | null> => {
    try { return (await prompt.question(question)).trim().toLowerCase(); } catch { return null; }
  };
  const yes: Suggestion[] = [];
  const no: Suggestion[] = [];
  // Only the owner writes under .noto/, so for anyone else a no is just a no for now.
  const remembers = vault.principal.owner;
  const question = `Link it? [y] yes  [n] no${remembers ? ', never again' : ''}  [s] skip  [q] stop: `;
  try {
    walk: for (const [index, item] of items.entries()) {
      console.log(`\n${index + 1}/${items.length}  ${formatSuggestion(item, emphasis)}`);
      for (;;) {
        const answer = await ask(question);
        if (answer === null) break walk;
        const letter = answer[0] ?? 's';
        if (letter === 'y') { yes.push(item); break; }
        if (letter === 'n') { if (remembers) no.push(item); break; }
        if (letter === 's') break;
        if (letter === 'q') break walk;
      }
    }
    if (aborted) { console.log('\nStopped; nothing was changed.'); return 130; }
    if (no.length > 0) console.log(`\nDismissed ${dismiss(vault, no)}; they will not be suggested again (.noto/dismissed.jsonl).`);
    if (yes.length === 0) { console.log('Nothing to link.'); return 0; }
    const proposal = vault.propose(toChanges(vault, yes), `Link ${yes.length} notes to the notes they name`);
    const now = await ask(`Apply ${yes.length === 1 ? 'the link' : `the ${yes.length} links`} to your notes now? [Y/n] `);
    if (now === null || now.startsWith('n')) {
      console.log(`Kept as proposal ${proposal.id}.\nReview: noto-vault proposals show ${proposal.id}\nAccept: noto-vault proposals accept ${proposal.id}`);
      return 0;
    }
    const result = vault.accept(proposal.id);
    console.log([
      `Linked in ${result.applied.length} ${result.applied.length === 1 ? 'note' : 'notes'}.`,
      result.conflicts.length > 0 ? `Changed since, left as they are: ${result.conflicts.join(', ')}. Proposal ${proposal.id} keeps them.` : 'Review with git diff and commit as usual.',
    ].join(' '));
    return 0;
  } finally {
    prompt.close();
  }
}

interface EvalCase { query: string; expect: string[]; note?: string }

/** Hit rate, recall and mean reciprocal rank at k over a file of cases. */
function evaluate(vault: Vault, file: string, k: number, bySearch: boolean) {
  const cases = parseYaml(readFileSync(file, 'utf8'));
  if (!Array.isArray(cases)) throw new UsageError('The cases file is a YAML list of {query, expect: [paths]}.');
  const rows: { query: string; hit: boolean; recall: number; rank: number | null; top: string[] }[] = [];
  for (const raw of cases as unknown as EvalCase[]) {
    if (!raw || typeof raw.query !== 'string' || !Array.isArray(raw.expect)) continue;
    const expected = raw.expect.map((ref) => vault.find(String(ref))?.path ?? String(ref));
    // A measurement, not a use: nothing it finds is recorded as recalled.
    const ranked = bySearch ? vault.search(raw.query, { limit: k }).map((hit) => hit.path) : recall(vault, raw.query, { limit: k, budget: 1_000_000, record: false }).items.map((item) => item.path);
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

/** What a person or an agent may say happened to a note outside Noto; the rest are the vault's own to record. */
const RECORDABLE: readonly EventVerb[] = ['open', 'read', 'cite', 'write', 'append'];

/** What an agent's tool did, by its name: Claude Code's, and any tool named the same way. */
function hookVerb(tool: unknown): EventVerb | null {
  if (typeof tool !== 'string') return null;
  if (/^(Read|NotebookRead)$/.test(tool)) return 'read';
  if (/^(Write|Edit|MultiEdit|NotebookEdit)$/.test(tool)) return 'write';
  return null;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Record that notes were read or written outside Noto: by the person in
 * another editor, or by an agent that edits files itself (a hook after each
 * of its edits). Each path goes to the vault it is in, the nearest folder
 * above it with `.noto/`; a path in no such folder, or not a note, is passed
 * over. Opens no index, so a hook that runs after every edit costs a process
 * start and one appended line. From a hook it never fails the agent's step.
 */
async function record(args: readonly string[], hook: boolean, root: string | null): Promise<number> {
  if (hook) {
    // Whatever the payload, a hook's step goes on: every failure here is a line not recorded.
    try { await recordFromHook(root); } catch { /* nothing recorded */ }
    return 0;
  }
  const verb = RECORDABLE.includes(args[0] as EventVerb) ? args[0] as EventVerb : null;
  if (!verb || args.length < 2) throw new UsageError(`Usage: noto-vault record <${RECORDABLE.join('|')}> <path...>`);
  const acting = agentActor();
  const recorded = recordNotes(args.slice(1).map((item) => path.resolve(item)), verb, acting?.actor ?? 'owner', process.env.NOTO_SESSION || acting?.session, root);
  if (recorded === 0) console.error('None of these is a note in a folder that keeps memory, so nothing was recorded.');
  return recorded > 0 ? 0 : 1;
}

/**
 * A tool hook's payload on stdin. Only an agent's hook sends one, so what it
 * records is never the person's: the agent its environment names, or
 * `claude-code`, whose payload this is, when its environment names none.
 */
async function recordFromHook(root: string | null): Promise<void> {
  // Run by hand at a terminal, there is nothing on stdin to wait for.
  if (process.stdin.isTTY) return;
  const payload: unknown = JSON.parse(await readStdin());
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
  const fields = payload as Record<string, unknown>;
  const verb = hookVerb(fields.tool_name);
  const input = fields.tool_input && typeof fields.tool_input === 'object' ? fields.tool_input as Record<string, unknown> : {};
  const file = [input.file_path, input.notebook_path, input.path].find((value): value is string => typeof value === 'string' && value !== '');
  if (!verb || !file) return;
  const cwd = typeof fields.cwd === 'string' ? fields.cwd : process.cwd();
  const acting = agentActor();
  const own = typeof fields.session_id === 'string' && /^[A-Za-z0-9._:-]{1,80}$/.test(fields.session_id) ? fields.session_id : undefined;
  recordNotes([path.resolve(cwd, file)], verb, acting?.actor ?? 'claude-code', process.env.NOTO_SESSION || own || acting?.session, root);
}

/** Append one line per vault for the notes among `files`; how many were recorded. */
function recordNotes(files: readonly string[], verb: EventVerb, actor: string, session: string | undefined, root: string | null): number {
  let recorded = 0;
  const byVault = new Map<string, string[]>();
  for (const file of files) {
    const vault = root ?? findRoot(path.dirname(file));
    if (!vault) continue;
    const rel = path.relative(vault, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !isMarkdown(rel)) continue;
    const parts = rel.split(path.sep);
    // The vault's own files and hidden folders are not notes.
    if (parts.some((part) => part.startsWith('.'))) continue;
    byVault.set(vault, [...(byVault.get(vault) ?? []), parts.join('/')]);
  }
  for (const [vault, rels] of byVault) {
    if (recordEvents(vault, rels.map((rel) => ({ actor, verb, path: rel, ...(session ? { session } : {}) })))) recorded += rels.length;
  }
  return recorded;
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
