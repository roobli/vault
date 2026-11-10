/**
 * Shadow ranking: recall, or an eval, run under the vault's recall config
 * and under another one side by side, recording nothing, so a change of
 * numbers can be seen before it is made. The other config is a `recall:`
 * section in a YAML file, read over the vault's own, so it names only what
 * it changes.
 */

import { readFileSync } from 'node:fs';
import { parseRecallConfig, recallConfigHash, type RecallConfig } from './config.js';
import { evaluate, type EvalReport } from './eval.js';
import { recall, type RecallOptions, type RecallPack } from './recall.js';
import type { Vault } from './vault.js';
import { parseYamlMap } from './yaml.js';

/** The `recall:` section of a YAML file, read over `base`. */
export function loadShadowConfig(file: string, base: RecallConfig): RecallConfig {
  const section = parseYamlMap(readFileSync(file, 'utf8')).recall;
  if (section === null || typeof section !== 'object' || Array.isArray(section)) {
    throw new Error(`${file} has no recall: section to rank by; it takes the same keys as recall: in brain.yaml.`);
  }
  return parseRecallConfig(section, base);
}

/** One note in either pack: its place in each, from 1, null where it is not in that pack. */
export interface ShadowMove {
  readonly path: string;
  readonly title: string;
  readonly current: number | null;
  readonly shadow: number | null;
}

export interface ShadowRecall {
  readonly cue: string;
  /** `recallConfigHash` of each config. */
  readonly configs: { readonly current: string; readonly shadow: string };
  readonly current: RecallPack;
  readonly shadow: RecallPack;
  /** Every note in either pack, in the shadow's order, then those only the current pack has. */
  readonly moves: readonly ShadowMove[];
}

/** Recall under both configs, with the same options, recording nothing. */
export function shadowRecall(vault: Vault, cue: string, shadow: RecallConfig, options: Omit<RecallOptions, 'config' | 'record'> = {}): ShadowRecall {
  const current = vault.config.recall;
  const now = recall(vault, cue, { ...options, config: current, record: false });
  const then = recall(vault, cue, { ...options, config: shadow, record: false });
  const place = (pack: RecallPack, rel: string) => {
    const index = pack.items.findIndex((item) => item.path === rel);
    return index < 0 ? null : index + 1;
  };
  const moves = [...then.items, ...now.items.filter((item) => place(then, item.path) === null)]
    .map((item) => ({ path: item.path, title: item.title, current: place(now, item.path), shadow: place(then, item.path) }));
  return { cue, configs: { current: recallConfigHash(current), shadow: recallConfigHash(shadow) }, current: now, shadow: then, moves };
}

/** One case whose first expected note moved. */
export interface ShadowCase {
  readonly query: string;
  readonly current: number | null;
  readonly shadow: number | null;
  /** `gained` when only the shadow finds an expected note in the top k, `lost` when only the current config does. */
  readonly hit: 'gained' | 'lost' | null;
}

export interface ShadowEval {
  readonly configs: { readonly current: string; readonly shadow: string };
  readonly current: EvalReport;
  readonly shadow: EvalReport;
  /** The cases whose rank changed, in the file's order. */
  readonly changes: readonly ShadowCase[];
}

/** An eval under both configs, recording neither run. */
export function shadowEval(vault: Vault, file: string, shadow: RecallConfig, options: { readonly k?: number } = {}): ShadowEval {
  const current = vault.config.recall;
  const now = evaluate(vault, file, { ...options, config: current, record: false });
  const then = evaluate(vault, file, { ...options, config: shadow, record: false });
  const changes = now.rows.flatMap((row, index) => {
    const other = then.rows[index]!;
    if (row.rank === other.rank) return [];
    const hit = row.hit === other.hit ? null : other.hit ? 'gained' as const : 'lost' as const;
    return [{ query: row.query, current: row.rank, shadow: other.rank, hit }];
  });
  return { configs: { current: recallConfigHash(current), shadow: recallConfigHash(shadow) }, current: now, shadow: then, changes };
}
