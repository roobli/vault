/**
 * Heat and association, from what was read and what was written.
 *
 * Both are decayed sums: an event of weight `w` that happened `age` ago
 * counts `w * 2^(-age / H)`, with a half-life `H` per kind of note for heat
 * and per type for edges. They are recomputed from the raw events and
 * commits whenever either grows, so changing a half-life in `brain.yaml`
 * takes effect on the next refresh. Nothing here deletes anything: a note no
 * one touches only sinks.
 *
 * yagni: a full recompute, O(events + commits), which is a few hundred
 * milliseconds for years of daily use. Make it incremental when the event log
 * outgrows that.
 */

import type { BrainConfig, Kind } from './config.js';
import type { Store } from './store.js';

const DAY = 24 * 60 * 60 * 1000;

/** What each verb adds to a note's heat, and whether it is a read. */
const VERB_WEIGHT: Readonly<Record<string, { heat: number; read: boolean }>> = {
  open: { heat: 1, read: true },
  read: { heat: 0.5, read: true },
  cite: { heat: 0.5, read: true },
  recall: { heat: 0.25, read: false },
  write: { heat: 1, read: false },
  append: { heat: 1, read: false },
};
const WRITE_WEIGHT = 2;

export const decay = (age: number, halfLifeDays: number): number => Math.pow(2, -Math.max(0, age) / (halfLifeDays * DAY));

interface Heat { value: number; reads: number; writes: number; lastRead: number | null; lastWrite: number | null }
interface Edge { weight: number; count: number; last: number }

export function recomputeWeights(store: Store, config: BrainConfig, current: (rel: string) => string | null, now: number): void {
  const db = store.db;
  const kinds = new Map<string, Kind>();
  for (const row of db.prepare('SELECT path, kind FROM notes').all() as { path: string; kind: Kind }[]) kinds.set(row.path, row.kind);
  const heat = new Map<string, Heat>();
  const edges = new Map<string, Edge>();
  const touch = (rel: string): Heat => heat.get(rel) ?? heat.set(rel, { value: 0, reads: 0, writes: 0, lastRead: null, lastWrite: null }).get(rel)!;
  const link = (left: string, right: string, type: string, weight: number, time: number) => {
    if (left === right) return;
    const [a, b] = left < right ? [left, right] : [right, left];
    const key = `${a}\0${b}\0${type}`;
    const edge = edges.get(key) ?? edges.set(key, { weight: 0, count: 0, last: 0 }).get(key)!;
    edge.weight += weight;
    edge.count += 1;
    edge.last = Math.max(edge.last, time);
  };

  // Reads, and trains of thought: one note opened after another, soon after.
  const windowMs = config.visit.windowMinutes * 60 * 1000;
  const previous = new Map<string, { path: string; time: number }>();
  const rows = db.prepare('SELECT time, actor, verb, path, session, from_path FROM events ORDER BY time').all() as
    { time: number; actor: string; verb: string; path: string; session: string | null; from_path: string | null }[];
  for (const row of rows) {
    const rel = current(row.path);
    if (!rel) continue;
    const weight = VERB_WEIGHT[row.verb];
    if (!weight) continue;
    const kind = kinds.get(rel) ?? 'note';
    const entry = touch(rel);
    entry.value += weight.heat * decay(now - row.time, config.halfLife.heat[kind]);
    if (weight.read) {
      entry.reads += 1;
      entry.lastRead = Math.max(entry.lastRead ?? 0, row.time);
      const key = `${row.actor}\0${row.session ?? ''}`;
      const before = previous.get(key);
      if (before && row.time - before.time <= windowMs) {
        const byLink = row.from_path !== null && current(row.from_path) === before.path ? 2 : 1;
        const who = row.actor === 'owner' ? 1 : config.visit.agentWeight;
        link(before.path, rel, 'visit', who * byLink * decay(now - row.time, config.halfLife.visit), row.time);
      }
      previous.set(key, { path: rel, time: row.time });
    }
  }

  // Writes, from git, and notes changed together in a small commit. A rename or a deletion is
  // structure, not content: a folder reorganised says nothing about which notes belong together.
  const changes = db.prepare("SELECT hash, time, path FROM changes WHERE status IN ('A', 'M') ORDER BY time, hash").all() as { hash: string; time: number; path: string }[];
  let at = 0;
  while (at < changes.length) {
    const hash = changes[at]!.hash;
    const time = changes[at]!.time;
    const together = new Set<string>();
    for (; at < changes.length && changes[at]!.hash === hash; at += 1) {
      const rel = current(changes[at]!.path);
      if (rel) together.add(rel);
    }
    for (const rel of together) {
      const entry = touch(rel);
      entry.value += WRITE_WEIGHT * decay(now - time, config.halfLife.heat[kinds.get(rel) ?? 'note']);
      entry.writes += 1;
      entry.lastWrite = Math.max(entry.lastWrite ?? 0, time);
    }
    if (together.size >= 2 && together.size <= config.coChange.maxNotes) {
      const list = [...together];
      const weight = decay(now - time, config.halfLife.coChange) / (list.length - 1);
      for (let i = 0; i < list.length; i += 1) for (let j = i + 1; j < list.length; j += 1) link(list[i]!, list[j]!, 'co_change', weight, time);
    }
  }

  const insertHeat = db.prepare('INSERT INTO heat(path, value, reads, writes, last_read, last_write) VALUES (?, ?, ?, ?, ?, ?)');
  const insertEdge = db.prepare('INSERT INTO edges(a, b, type, weight, count, last) VALUES (?, ?, ?, ?, ?, ?)');
  store.transaction(() => {
    db.exec('DELETE FROM heat; DELETE FROM edges;');
    for (const [rel, entry] of heat) insertHeat.run(rel, entry.value, entry.reads, entry.writes, entry.lastRead, entry.lastWrite);
    for (const [key, edge] of edges) {
      const [a, b, type] = key.split('\0');
      insertEdge.run(a!, b!, type!, edge.weight, edge.count, edge.last);
    }
    store.setMeta('weights_at', String(now));
  });
}
