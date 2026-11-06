/**
 * Git as the log of writes, and as the place proposals wait.
 *
 * Reading: `git log --name-status -M` from the last commit the index has
 * seen, so a refresh after one commit reads one commit.
 *
 * Writing: a proposal is two commits under `refs/noto/proposals/<id>`, made
 * with plumbing against a temporary index file. The working tree, the
 * person's index and their branches are never touched, and the refs are not
 * branches, so a push does not carry them.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_BUFFER = 512 * 1024 * 1024;

export interface GitRepo {
  /** The repository's top folder. */
  readonly top: string;
  /** The vault's path inside the repository, `''` or `notes/` with a trailing slash. */
  readonly prefix: string;
}

function git(cwd: string, args: readonly string[], options: { input?: string | Buffer; env?: NodeJS.ProcessEnv; allowFail?: boolean } = {}): string {
  const input = typeof options.input === 'string' ? Buffer.from(options.input, 'utf8') : options.input;
  const result = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd,
    ...(input ? { input } : {}),
    env: options.env ? { ...process.env, ...options.env } : process.env,
    maxBuffer: MAX_BUFFER,
    timeout: 120_000,
  });
  if (result.error) throw new Error(`git ${args[0]} could not run: ${result.error.message}`);
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString('utf8').trim()}`);
  }
  return result.stdout.toString('utf8');
}

export function findRepo(root: string): GitRepo | null {
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
    if (!top) return null;
    // git answers with the real path; the vault may have been opened through a symlink.
    const relative = path.relative(realpathSync(top), realpathSync(path.resolve(root))).split(path.sep).join('/');
    return { top, prefix: relative ? `${relative}/` : '' };
  } catch {
    return null;
  }
}

export function headCommit(repo: GitRepo): string | null {
  const out = git(repo.top, ['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true }).trim();
  return out || null;
}

export function isAncestor(repo: GitRepo, older: string, newer: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: repo.top, timeout: 30_000 });
  return result.status === 0;
}

export interface Commit {
  readonly hash: string;
  readonly time: number;
  readonly author: string;
  readonly subject: string;
  readonly changes: readonly { status: string; path: string; old: string | null }[];
}

/** Commits after `since` (or all), oldest first, with paths made vault-relative. */
export function commitsSince(repo: GitRepo, since: string | null, head = 'HEAD'): Commit[] {
  const range = since ? [`${since}..${head}`] : [head];
  const out = git(repo.top, ['log', '--reverse', '--format=%x1e%H%x1f%at%x1f%an%x1f%s', '--name-status', '-M', ...range]);
  const commits: Commit[] = [];
  const inVault = (file: string): string | null => {
    if (!file.startsWith(repo.prefix)) return null;
    return file.slice(repo.prefix.length);
  };
  for (const record of out.split('\x1e')) {
    if (!record.trim()) continue;
    const [header, ...lines] = record.split('\n');
    const [hash, time, author, subject] = header!.split('\x1f');
    const changes: { status: string; path: string; old: string | null }[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const status = parts[0]!;
      if (status.startsWith('R') || status.startsWith('C')) {
        const old = inVault(parts[1]!);
        const now = inVault(parts[2]!);
        if (now) changes.push({ status: status[0]!, path: now, old });
      } else {
        const file = inVault(parts[1]!);
        if (file) changes.push({ status: status[0]!, path: file, old: null });
      }
    }
    commits.push({ hash: hash!, time: Number(time) * 1000, author: author ?? '', subject: subject ?? '', changes });
  }
  return commits;
}

// ---------- proposals ----------

export const PROPOSAL_REFS = 'refs/noto/proposals';

export interface FileChange {
  /** Vault-relative path. */
  readonly path: string;
  /** The new text; null deletes the file. */
  readonly content: string | null;
}

export interface Author {
  readonly name: string;
  readonly email: string;
}

function authorEnv(author: Author, time: Date): NodeJS.ProcessEnv {
  const date = `${Math.floor(time.getTime() / 1000)} +0000`;
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_COMMITTER_DATE: date,
  };
}

const slug = (text: string): string => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9一-鿿]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'change';

/**
 * Record changes as a proposal: a base commit holding the touched files as
 * they are in the working tree now, and on it a commit with the change.
 */
export function createProposal(repo: GitRepo, vaultRoot: string, changes: readonly FileChange[], message: string, author: Author, now: Date = new Date()): { id: string; ref: string; commit: string } {
  if (changes.length === 0) throw new Error('A proposal needs at least one change.');
  const head = headCommit(repo);
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'noto-proposal-'));
  const env = { ...authorEnv(author, now), GIT_INDEX_FILE: path.join(scratch, 'index') };
  try {
    if (head) git(repo.top, ['read-tree', head], { env });
    else git(repo.top, ['read-tree', '--empty'], { env });
    const stage = (rel: string, content: string | null) => {
      const file = repo.prefix + rel;
      if (content === null) {
        git(repo.top, ['update-index', '--force-remove', '--', file], { env });
        return;
      }
      const blob = git(repo.top, ['hash-object', '-w', '--stdin'], { input: content }).trim();
      git(repo.top, ['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`], { env });
    };
    for (const change of changes) {
      const onDisk = path.join(vaultRoot, change.path);
      stage(change.path, existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : null);
    }
    const baseTree = git(repo.top, ['write-tree'], { env }).trim();
    const base = git(repo.top, ['commit-tree', baseTree, ...(head ? ['-p', head] : []), '-m', `base: ${message}\n\nThe proposed files as they were when the proposal was made.`], { env }).trim();
    for (const change of changes) stage(change.path, change.content);
    const tree = git(repo.top, ['write-tree'], { env }).trim();
    const commit = git(repo.top, ['commit-tree', tree, '-p', base, '-m', message], { env }).trim();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
    let id = `${stamp}-${slug(message)}`;
    let n = 1;
    while (git(repo.top, ['rev-parse', '--verify', '-q', `${PROPOSAL_REFS}/${id}`], { allowFail: true }).trim()) id = `${stamp}-${slug(message)}-${(n += 1)}`;
    const ref = `${PROPOSAL_REFS}/${id}`;
    git(repo.top, ['update-ref', ref, commit, '']);
    return { id, ref, commit };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export interface Proposal {
  readonly id: string;
  readonly ref: string;
  readonly commit: string;
  readonly subject: string;
  readonly author: string;
  readonly time: string;
  readonly files: readonly { status: string; path: string }[];
}

export function listProposals(repo: GitRepo): Proposal[] {
  const out = git(repo.top, ['for-each-ref', PROPOSAL_REFS, '--sort=-creatordate', '--format=%(refname)%1f%(objectname)%1f%(subject)%1f%(authorname)%1f%(authordate:iso-strict)']);
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, commit, subject, author, time] = line.split('\x1f');
    const files = git(repo.top, ['diff', '--no-renames', '--name-status', `${commit}~1`, commit!]).split('\n').filter(Boolean).map((row) => {
      const [status, file] = row.split('\t');
      return { status: status!, path: file!.slice(repo.prefix.length) };
    });
    return { id: ref!.slice(PROPOSAL_REFS.length + 1), ref: ref!, commit: commit!, subject: subject!, author: author!, time: time!, files };
  });
}

export function proposalDiff(repo: GitRepo, id: string): string {
  const ref = `${PROPOSAL_REFS}/${id}`;
  // No rename detection: a move is a deletion and an addition, and both must be seen and applied.
  return git(repo.top, ['diff', '--no-renames', `${ref}~1`, ref]);
}

const showFile = (repo: GitRepo, commit: string, rel: string): string | null => {
  const result = spawnSync('git', ['show', `${commit}:${repo.prefix}${rel}`], { cwd: repo.top, maxBuffer: MAX_BUFFER });
  return result.status === 0 ? result.stdout.toString('utf8') : null;
};

/** One file of a proposal, as it was when the proposal was made and as proposed; null where there is no file. */
export function proposalFile(repo: GitRepo, id: string, rel: string): { base: string | null; proposed: string | null } {
  const ref = `${PROPOSAL_REFS}/${id}`;
  const commit = git(repo.top, ['rev-parse', '--verify', ref]).trim();
  return { base: showFile(repo, `${commit}~1`, rel), proposed: showFile(repo, commit, rel) };
}

export interface AcceptResult {
  readonly applied: readonly string[];
  readonly unchanged: readonly string[];
  readonly conflicts: readonly string[];
}

/**
 * Bring a proposal into the working tree, merging each file three ways with
 * what is on disk now. A file that conflicts is left as it is and named; the
 * proposal stays until every file is in.
 */
export function acceptProposal(repo: GitRepo, vaultRoot: string, id: string): AcceptResult {
  const ref = `${PROPOSAL_REFS}/${id}`;
  const commit = git(repo.top, ['rev-parse', '--verify', ref]).trim();
  const files = git(repo.top, ['diff', '--no-renames', '--name-only', `${commit}~1`, commit]).split('\n').filter(Boolean).map((file) => file.slice(repo.prefix.length));
  const applied: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'noto-accept-'));
  try {
    for (const rel of files) {
      const target = path.join(vaultRoot, rel);
      const base = showFile(repo, `${commit}~1`, rel);
      const proposed = showFile(repo, commit, rel);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current === proposed) { unchanged.push(rel); continue; }
      if (current === base) {
        if (proposed === null) unlinkSync(target);
        else { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, proposed, 'utf8'); }
        applied.push(rel);
        continue;
      }
      if (current === null || proposed === null || base === null) { conflicts.push(rel); continue; }
      const files3 = ['current', 'base', 'proposed'].map((name) => path.join(scratch, name));
      writeFileSync(files3[0]!, current);
      writeFileSync(files3[1]!, base);
      writeFileSync(files3[2]!, proposed);
      const merged = spawnSync('git', ['merge-file', '-p', ...files3], { maxBuffer: MAX_BUFFER });
      if (merged.status === 0) {
        writeFileSync(target, merged.stdout);
        applied.push(rel);
      } else conflicts.push(rel);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (conflicts.length === 0) git(repo.top, ['update-ref', '-d', ref, commit]);
  return { applied, unchanged, conflicts };
}

export function rejectProposal(repo: GitRepo, id: string): void {
  const ref = `${PROPOSAL_REFS}/${id}`;
  const commit = git(repo.top, ['rev-parse', '--verify', ref]).trim();
  git(repo.top, ['update-ref', '-d', ref, commit]);
}
