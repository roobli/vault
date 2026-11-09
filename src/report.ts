/**
 * A week of the vault in plain Markdown: what it holds, what is broken or
 * alone, what became of the proposals, how recall measured, and who read
 * what. It is built from the index, the event logs, the eval ledger and the
 * open proposals alone, with no model and no network, so the same vault and
 * week give the same text. Weeks are ISO weeks in UTC, as the events' times
 * are.
 */

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync, type Stats } from 'node:fs';
import path from 'node:path';
import { KINDS } from './config.js';
import { evalRunsDir, type EvalRun } from './eval.js';
import { eventsDir, folderIn } from './events.js';
import { AccessError, type Vault } from './vault.js';

const DAY = 86_400_000;
/** The most rows a list of notes shows; the count says how many in all. */
const LIST_MAX = 20;

/** The ISO week a moment falls in, in UTC: `2026-W45`. */
export function isoWeek(at: Date): string {
  const day = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  // The week's Thursday says which year the week belongs to.
  const thursday = new Date(day + (3 - ((at.getUTCDay() + 6) % 7)) * DAY);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / DAY / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Where a week starts and ends, in UTC milliseconds, end excluded; null when `week` is not one. */
export function weekRange(week: string): { start: number; end: number } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(week);
  if (!match) return null;
  const year = Number(match[1]);
  const number = Number(match[2]);
  // Week 1 is the week with 4 January in it.
  const fourth = Date.UTC(year, 0, 4);
  const start = fourth - ((new Date(fourth).getUTCDay() + 6) % 7) * DAY + (number - 1) * 7 * DAY;
  if (number < 1 || isoWeek(new Date(start)) !== week) return null;
  return { start, end: start + 7 * DAY };
}

export interface ReportOptions {
  /** An ISO week, `2026-W45`; the week now is in when absent. */
  readonly week?: string;
  /** What now is, for the default week. */
  readonly now?: Date;
}

/** A cell of a Markdown table: one line, no column breaks. */
const cell = (text: string | number): string => String(text).replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const table = (head: readonly string[], rows: readonly (readonly (string | number)[])[]): string[] => [
  `| ${head.map(cell).join(' | ')} |`,
  `| ${head.map(() => '---').join(' | ')} |`,
  ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
];
const code = (text: string) => `\`${text.replace(/`/g, "'")}\``;
const percent = (value: number) => `${Math.round(value * 100)}%`;
const minute = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
const median = (values: readonly number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
};
const byName = (left: string, right: string) => (left === right ? 0 : left === 'owner' ? -1 : right === 'owner' ? 1 : left < right ? -1 : 1);

/** Every line of every file in a folder of per-host JSONL files, parsed; lines that do not parse are passed over. */
function jsonLines(files: readonly string[], keep: (line: string) => boolean): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const file of files) {
    let text: string;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim() || !keep(line)) continue;
      try {
        const value = JSON.parse(line) as unknown;
        if (value && typeof value === 'object' && !Array.isArray(value)) out.push(value as Record<string, unknown>);
      } catch {
        // A line broken by hand says nothing.
      }
    }
  }
  return out;
}

function eventFiles(root: string): string[] {
  const dir = eventsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).filter((host) => host.isDirectory()).sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((host) => readdirSync(path.join(dir, host.name)).filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(dir, host.name, name)));
}

interface Decision { readonly id: string | null; readonly time: number; readonly verb: 'accept' | 'reject'; readonly by: string; readonly reviewMs: number | null }

/** The proposals table: made, decided and pending in the week, by who made them. */
function proposalsSection(vault: Vault, start: number, end: number): string[] {
  const lines = jsonLines(eventFiles(vault.root), (line) => /"verb":"(propose|accept|reject)"/.test(line));
  const timeOf = (line: Record<string, unknown>) => (typeof line.time === 'string' ? Date.parse(line.time) : Number.NaN);
  const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null);
  // Each proposal by its id: when it was first proposed, and by whom.
  const made = new Map<string, { time: number; by: string }>();
  const madeInWeek: string[] = [];
  const decided = new Map<string, number>();
  const decisions: Decision[] = [];
  let unnamed = false;
  for (const line of lines.map((line) => ({ line, time: timeOf(line) })).filter((entry) => Number.isFinite(entry.time)).sort((left, right) => left.time - right.time)) {
    const id = text(line.line.proposal);
    const actor = text(line.line.actor) ?? 'owner';
    if (line.line.verb === 'propose') {
      // The first line for an id made it; a later one is an accept that stopped on a conflict.
      if (id && made.has(id)) continue;
      if (id) made.set(id, { time: line.time, by: actor });
      if (line.time >= start && line.time < end) madeInWeek.push(actor);
      if (!id && line.time >= start && line.time < end) unnamed = true;
      continue;
    }
    if (id && !decided.has(id)) decided.set(id, line.time);
    if (line.time < start || line.time >= end) continue;
    const by = (id ? made.get(id)?.by : null) ?? text(line.line.author) ?? 'unknown';
    if (!id || !made.has(id)) unnamed = true;
    const reviewMs = typeof line.line.reviewMs === 'number' && Number.isFinite(line.line.reviewMs) ? line.line.reviewMs : null;
    decisions.push({ id, time: line.time, verb: line.line.verb as 'accept' | 'reject', by, reviewMs });
  }
  // Pending at the week's end: made by then and not decided by then. A proposal still open whose
  // propose line is not in the logs (made elsewhere, or before the lines named it) counts by its ref.
  const pending: string[] = [];
  for (const [id, entry] of made) {
    const at = decided.get(id);
    if (entry.time < end && (at === undefined || at >= end)) pending.push(entry.by);
  }
  for (const proposal of vault.proposals()) {
    if (made.has(proposal.id)) continue;
    const time = Date.parse(proposal.time);
    if (Number.isFinite(time) && time < end) { pending.push(proposal.author); unnamed = true; }
  }

  const groups = [...new Set([...madeInWeek, ...decisions.map((decision) => decision.by), ...pending])].sort(byName);
  const out = ['## Proposals', ''];
  if (groups.length === 0) return [...out, 'None were made, decided or pending this week.'];
  const row = (name: string, own: (by: string) => boolean) => {
    const mine = decisions.filter((decision) => own(decision.by));
    const accepted = mine.filter((decision) => decision.verb === 'accept').length;
    const rejected = mine.length - accepted;
    const review = median(mine.flatMap((decision) => (decision.reviewMs === null ? [] : [decision.reviewMs])));
    return [name, madeInWeek.filter(own).length, accepted, rejected, pending.filter(own).length,
      mine.length > 0 ? percent(accepted / mine.length) : '', review === null ? '' : `${(review / 1000).toFixed(1)} s`];
  };
  out.push(...table(['made by', 'made', 'accepted', 'rejected', 'pending', 'accept rate', 'median review'], [
    ...groups.map((name) => row(name, (by) => by === name)),
    ...(groups.length > 1 ? [row('all', () => true)] : []),
  ]));
  out.push('', 'Proposals carry no kind, so they are grouped by who made them: the actor on the event line that proposed each. Pending means made by the end of the week and not decided by then; the accept rate is of those decided this week.');
  if (unnamed) out.push('', 'Some proposals here were made before event lines named their proposal, or elsewhere: they are counted by the author git keeps on the proposal, `unknown` when nothing says.');
  return out;
}

/** The eval runs in the week, each against the last run before the week on the same cases, mode and k. */
function evalSection(root: string, start: number, end: number): string[] {
  const dir = evalRunsDir(root);
  const files = existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort().map((name) => path.join(dir, name)) : [];
  const runs = jsonLines(files, () => true).flatMap((line) => {
    const run = line as Partial<EvalRun>;
    const time = typeof run.time === 'string' ? Date.parse(run.time) : Number.NaN;
    const numbers = [run.k, run.queries, run.hitAtK, run.mrr, run.firstHit].every((value) => typeof value === 'number' && Number.isFinite(value));
    return Number.isFinite(time) && numbers && typeof run.file === 'string' ? [{ ...(run as EvalRun), at: time }] : [];
  }).sort((left, right) => left.at - right.at || (left.file < right.file ? -1 : 1));
  const out = ['## Recall evals', ''];
  const week = runs.filter((run) => run.at >= start && run.at < end);
  if (week.length === 0) return [...out, 'No eval was run this week.'];
  // By who ran it too: a series from another principal (written before eval kept the owner's only) is its own.
  const keyOf = (run: EvalRun) => JSON.stringify([run.file, run.mode ?? 'recall', run.k, run.actor]);
  const signed = (value: number, digits: number) => `${value >= 0 ? '+' : '-'}${Math.abs(value).toFixed(digits)}`;
  const rows: (string | number)[][] = [];
  for (const key of [...new Set(week.map(keyOf))]) {
    const before = runs.filter((run) => run.at < start && keyOf(run) === key).at(-1);
    const name = (run: EvalRun) => `${code(run.file)}${run.mode === 'search' ? ' (search)' : ''}`;
    if (before) rows.push([`${minute(before.at)} (before)`, name(before), before.k, before.queries, percent(before.hitAtK), before.mrr.toFixed(2), percent(before.firstHit), before.config ?? '']);
    for (const run of week.filter((item) => keyOf(item) === key)) {
      const change = (now: number, then: number | undefined, show: (value: number) => string, delta: (value: number) => string) =>
        (then === undefined ? show(now) : `${show(now)} (${delta(now - then)})`);
      const points = (value: number) => `${value >= 0 ? '+' : '-'}${Math.abs(Math.round(value * 100))}`;
      rows.push([minute(run.at), name(run), run.k, run.queries,
        change(run.hitAtK, before?.hitAtK, percent, points), change(run.mrr, before?.mrr, (value) => value.toFixed(2), (value) => signed(value, 2)),
        change(run.firstHit, before?.firstHit, percent, points), run.config ?? '']);
    }
  }
  out.push(...table(['run (UTC)', 'cases', 'k', 'queries', 'hit@k', 'MRR', 'first', 'config'], rows));
  out.push('', 'Each run is set against the last run before the week on the same cases, mode and k, marked (before); the change is in points for hit@k and first, and in MRR for MRR.');
  return out;
}

/** The report for a week, as Markdown. The owner's: it names every reader and every note. */
export function weeklyReport(vault: Vault, options: ReportOptions = {}): string {
  if (!vault.principal.owner) throw new AccessError(`${vault.principal.name} may not see the vault's report.`);
  const week = options.week ?? isoWeek(options.now ?? new Date());
  const range = weekRange(week);
  if (!range) throw new Error(`${week} is not an ISO week, such as 2026-W45.`);
  const { start, end } = range;
  const db = vault.store.db;
  const out: string[] = [
    `# Vault report, ${week}`,
    '',
    `${path.basename(vault.root)}, ${new Date(start).toISOString().slice(0, 10)} to ${new Date(end - DAY).toISOString().slice(0, 10)} (UTC). Notes and links are as they are now; the rest is what happened in the week.`,
    '',
  ];

  const kinds = new Map((db.prepare('SELECT kind, count(*) AS n FROM notes GROUP BY kind').all() as { kind: string; n: number }[]).map((row) => [row.kind, row.n]));
  const total = [...kinds.values()].reduce((sum, n) => sum + n, 0);
  out.push('## Notes', '', ...table(['kind', 'notes'], [...[...KINDS].reverse().map((kind) => [kind, kinds.get(kind) ?? 0]), ['all', total]]), '');

  // As status counts them: a path from the disk's root points out of the vault, and is not broken.
  const broken = db.prepare(`SELECT src, target, line FROM links WHERE resolved IS NULL AND kind != 'img' AND NOT (kind = 'md' AND target LIKE '/%')
    ORDER BY src, line, target`).all() as { src: string; target: string; line: number }[];
  out.push('## Broken links', '');
  if (broken.length === 0) out.push('None.', '');
  else {
    out.push(`${broken.length} in all${broken.length > LIST_MAX ? `; the first ${LIST_MAX}` : ''}:`, '');
    out.push(...table(['note', 'line', 'link'], broken.slice(0, LIST_MAX).map((link) => [code(link.src), link.line, code(link.target)])), '');
  }

  const linked = new Set<string>();
  for (const row of db.prepare(`SELECT DISTINCT src, resolved FROM links WHERE resolved IS NOT NULL AND kind != 'img' AND src != resolved`).all() as { src: string; resolved: string }[]) {
    linked.add(row.src);
    linked.add(row.resolved);
  }
  const alone = (db.prepare(`SELECT path, kind FROM notes WHERE kind != 'log' ORDER BY path`).all() as { path: string; kind: string }[]).filter((note) => !linked.has(note.path));
  out.push('## Notes with no links', '');
  if (alone.length === 0) out.push('None: every note but the logs links or is linked.', '');
  else {
    out.push(`Notes that link nowhere and that nothing links to, logs aside: ${alone.length} in all${alone.length > LIST_MAX ? `; the first ${LIST_MAX}` : ''}.`, '');
    out.push(...table(['note', 'kind'], alone.slice(0, LIST_MAX).map((note) => [code(note.path), note.kind])), '');
  }

  out.push(...proposalsSection(vault, start, end), '');
  out.push(...evalSection(vault.root, start, end), '');

  const reads = db.prepare(`SELECT actor, verb, count(*) AS n FROM events WHERE time >= ? AND time < ? AND verb IN ('open', 'read', 'recall', 'cite')
    GROUP BY actor, verb`).all(start, end) as { actor: string; verb: string; n: number }[];
  out.push('## Reads', '');
  if (reads.length === 0) out.push('Nobody read the vault this week.');
  else {
    const actors = [...new Set(reads.map((row) => row.actor))].sort(byName);
    const count = (actor: string, verb: string) => reads.find((row) => row.actor === actor && row.verb === verb)?.n ?? 0;
    out.push(...table(['reader', 'opened', 'read', 'recalled', 'cited', 'all'], actors.map((actor) => [
      actor, count(actor, 'open'), count(actor, 'read'), count(actor, 'recall'), count(actor, 'cite'),
      reads.filter((row) => row.actor === actor).reduce((sum, row) => sum + row.n, 0),
    ])));
    out.push('', '`owner` is the person; every other reader is an agent. Each note counts: a recall that returned eight notes is eight.');
  }
  return `${out.join('\n')}\n`;
}

/**
 * Where a report may be written: a `.md` file inside the vault's `.noto/`,
 * so it is never taken for a note and never overwrites a setting. Throws
 * with the reason otherwise.
 */
export function reportTarget(root: string, file: string): string {
  // Against the vault's real path, so a vault opened through a link (as /tmp
  // is on macOS) does not refuse the path it suggests; a relative --out is
  // read from the vault, not from wherever the command was run.
  const real = (() => { try { return realpathSync(root); } catch { return path.resolve(root); } })();
  const asked = path.resolve(root, file);
  const within = (base: string) => { const rel = path.relative(base, asked); return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)) ? rel : null; };
  const fromRoot = within(path.resolve(root)) ?? within(real);
  const target = fromRoot === null ? asked : path.join(real, fromRoot);
  const noto = path.join(real, '.noto');
  const rel = path.relative(noto, target);
  const suggestion = 'Write it under .noto/reports/, such as .noto/reports/2026-W45.md.';
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`A report is written inside the vault's .noto folder, not to ${file}. ${suggestion}`);
  if (path.extname(target).toLowerCase() !== '.md') throw new Error(`A report is a .md file. ${suggestion}`);
  let at = noto;
  for (const part of ['', ...rel.split(path.sep)]) {
    at = part ? path.join(at, part) : at;
    // lstat, not exists: a link whose target is missing must still be seen as a link.
    let stat: Stats;
    try { stat = lstatSync(at); } catch { continue; }
    if (stat.isSymbolicLink()) throw new Error(`${path.relative(real, at)} is a link; a report is written only into the vault's own .noto folder.`);
    if (at !== target && !stat.isDirectory()) throw new Error(`${path.relative(real, at)} is not a folder.`);
    if (at === target && !stat.isFile()) throw new Error(`${path.relative(real, at)} is not a file a report can replace.`);
  }
  return target;
}

/** Write a report where `reportTarget` allows, making its folders one at a time inside a `.noto/` that is there. */
export function writeReport(root: string, file: string, text: string): string {
  const target = reportTarget(root, file);
  const noto = path.join((() => { try { return realpathSync(root); } catch { return path.resolve(root); } })(), '.noto');
  const missing = `${root} does not keep memory (it has no .noto folder), so there is nowhere to write the report.`;
  if (!existsSync(noto)) throw new Error(missing);
  let at = noto;
  for (const part of path.relative(noto, path.dirname(target)).split(path.sep).filter(Boolean)) {
    at = path.join(at, part);
    if (!folderIn(at)) throw new Error(missing);
  }
  writeFileSync(target, text, 'utf8');
  return target;
}
