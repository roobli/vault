/**
 * How well recall finds what it should, over a file of cases, and a ledger
 * of each measurement.
 *
 * A cases file is a YAML list of `{query, expect: [paths]}`. A run reads no
 * note as used: recall is asked not to record, so measuring never warms
 * what it finds. Each run appends one line to `.noto/eval/runs/<host>.jsonl`,
 * per host as the events are, with the scores and what they were measured
 * under (the index schema, a hash of the recall config, the package
 * version), so that runs under different numbers can be told apart.
 */

import { appendFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { recallConfigHash, type RecallConfig } from './config.js';
import { folderIn, hostName } from './events.js';
import { recall } from './recall.js';
import { SCHEMA_VERSION } from './store.js';
import type { Vault } from './vault.js';
import { parseYaml } from './yaml.js';

/** A cases file that is not a list of cases. */
export class EvalCasesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EvalCasesError';
  }
}

export interface EvalCase {
  readonly query: string;
  readonly expect: readonly string[];
}

export interface EvalRow {
  readonly query: string;
  /** Whether any expected note is in the top k. */
  readonly hit: boolean;
  /** The share of the expected notes in the top k. */
  readonly recall: number;
  /** The place of the first expected note, from 1; null when none is in the top k. */
  readonly rank: number | null;
  readonly top: readonly string[];
}

export interface EvalReport {
  readonly cases: number;
  readonly k: number;
  /** The share of cases with an expected note in the top k (hit@k). */
  readonly hitRate: number;
  readonly recall: number;
  /** Mean reciprocal rank of the first expected note, 0 for a miss. */
  readonly mrr: number;
  /** The share of cases whose first note is an expected one. */
  readonly firstHit: number;
  readonly rows: readonly EvalRow[];
  readonly text: string;
}

export interface EvalOptions {
  /** How many notes count (default 5). */
  readonly k?: number;
  /** Measure full-text search instead of recall. */
  readonly search?: boolean;
  /** Rank by these numbers instead of the vault's `recall:` config. */
  readonly config?: RecallConfig;
  /** Append the run to the ledger (default true). */
  readonly record?: boolean;
}

/** One line of `.noto/eval/runs/<host>.jsonl`. */
export interface EvalRun {
  readonly time: string;
  readonly actor: string;
  /** The cases file, from the vault's root. */
  readonly file: string;
  readonly mode: 'recall' | 'search';
  readonly queries: number;
  readonly k: number;
  readonly hitAtK: number;
  readonly mrr: number;
  readonly firstHit: number;
  /** The index schema version. */
  readonly schema: number;
  /** `recallConfigHash` of the config recall ranked by. */
  readonly config: string;
  /** This package's version. */
  readonly version: string;
}

export function evalRunsDir(root: string): string {
  return path.join(root, '.noto', 'eval', 'runs');
}

/** The cases in a file; an entry that is not a case is passed over. */
export function readEvalCases(file: string): EvalCase[] {
  const cases = parseYaml(readFileSync(file, 'utf8'));
  if (!Array.isArray(cases)) throw new EvalCasesError('The cases file is a YAML list of {query, expect: [paths]}.');
  const out: EvalCase[] = [];
  for (const raw of cases) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.query !== 'string' || !Array.isArray(raw.expect)) continue;
    out.push({ query: raw.query, expect: raw.expect.map((ref) => String(ref)) });
  }
  return out;
}

/** Hit rate, recall, first-place hits and mean reciprocal rank at k over a file of cases. */
export function evaluate(vault: Vault, file: string, options: EvalOptions = {}): EvalReport {
  const k = options.k ?? 5;
  const bySearch = options.search === true;
  const config = options.config ?? vault.config.recall;
  const rows: EvalRow[] = [];
  for (const item of readEvalCases(file)) {
    const expected = item.expect.map((ref) => vault.find(ref)?.path ?? ref);
    // A measurement, not a use: nothing it finds is recorded as recalled.
    const ranked = bySearch ? vault.search(item.query, { limit: k }).map((hit) => hit.path) : recall(vault, item.query, { limit: k, budget: 1_000_000, record: false, config }).items.map((found) => found.path);
    const top = ranked.slice(0, k);
    const found = expected.filter((rel) => top.includes(rel));
    const first = top.findIndex((rel) => expected.includes(rel));
    rows.push({ query: item.query, hit: found.length > 0, recall: expected.length ? found.length / expected.length : 0, rank: first < 0 ? null : first + 1, top });
  }
  const n = rows.length || 1;
  const hitRate = rows.filter((row) => row.hit).length / n;
  const meanRecall = rows.reduce((sum, row) => sum + row.recall, 0) / n;
  const mrr = rows.reduce((sum, row) => sum + (row.rank ? 1 / row.rank : 0), 0) / n;
  const firstHit = rows.filter((row) => row.rank === 1).length / n;
  const text = [
    `${rows.length} cases, ${bySearch ? 'search' : 'recall'} at ${k}: hit ${(hitRate * 100).toFixed(0)}%, recall ${(meanRecall * 100).toFixed(0)}%, MRR ${mrr.toFixed(2)}`,
    ...rows.filter((row) => !row.hit).map((row) => `  miss: ${row.query}\n    got: ${row.top.slice(0, 3).join(' | ')}`),
  ].join('\n');
  const report = { cases: rows.length, k, hitRate, recall: meanRecall, mrr, firstHit, rows, text };
  if (options.record !== false) {
    recordEvalRun(vault.root, {
      time: new Date().toISOString(), actor: vault.actor, file: path.relative(vault.root, path.resolve(file)).split(path.sep).join('/'),
      mode: bySearch ? 'search' : 'recall', queries: report.cases, k, hitAtK: hitRate, mrr, firstHit,
      schema: SCHEMA_VERSION, config: recallConfigHash(config), version: packageVersion(),
    });
  }
  return report;
}

/**
 * Append a run to this host's ledger, making its folders one at a time
 * inside a `.noto/` that is there. A folder that does not keep memory is
 * left as it is: false.
 */
export function recordEvalRun(root: string, run: EvalRun, host: string = hostName()): boolean {
  const file = path.join(evalRunsDir(root), `${host}.jsonl`);
  const text = `${JSON.stringify(run)}\n`;
  try {
    appendFileSync(file, text, 'utf8');
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (!folderIn(path.dirname(evalRunsDir(root))) || !folderIn(evalRunsDir(root))) return false;
  appendFileSync(file, text, 'utf8');
  return true;
}

let version: string | undefined;

/** The version in this package's package.json, one folder above the module in `src/` and in `dist/`. */
export function packageVersion(): string {
  if (version === undefined) {
    try {
      const parsed = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
      version = typeof parsed.version === 'string' ? parsed.version : 'unknown';
    } catch {
      version = 'unknown';
    }
  }
  return version;
}
