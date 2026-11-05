# Vault core: design and contracts

A vault is a folder of Markdown notes, usually a git repository. This package
turns it into memory that people and agents share: one resolver for links, an
index that can always be rebuilt, a record of what was read and when, scoped
access, recall, and proposals that a person reviews. The notes stay the only
source of truth, and nothing written into a note depends on this package to be
read.

The package has no runtime dependencies. It needs Node 22.13 or later, for
`node:sqlite`, and runs the same inside Electron 44.

## What is a contract here

Everything another tool or another machine reads is a contract and changes only
additively: the files under `.noto/` (config, access policy, scripts, events),
the shape of `graph` output, the CLI's verbs and flags, and the MCP tools. The
SQLite index is a cache: its schema carries a version, and a newer version
rebuilds it from the files.

## Layout

```
<vault>/
  .noto/
    brain.yaml          config: kinds, relations, half-lives, budgets (tracked)
    access.yaml         who may read and write what (tracked)
    scripts/*.mjs       the vault's own rules, as hooks (tracked)
    events/<host>/<yyyy-mm>.jsonl   reads and visits, append-only (tracked by choice)
    dismissed.jsonl     suggestions the person said no to (tracked)
    index.sqlite        the index (ignored; delete it at any time)
```

Directories whose name starts with a dot, and `node_modules`, are never
indexed. `brain.yaml` can ignore more with `ignore:` globs.

## Notes

A note is a `.md` or `.markdown` file. The index reads, per note:

- the frontmatter, as a subset of YAML (maps, block and flow sequences, quoted
  and plain scalars, comments, `|` and `>` block scalars; no anchors or tags);
- the title, by the vault tool's rule: the frontmatter `title`, else an H1
  within the first five non-empty lines of the body, else the file name with
  `_` and `-` read as spaces (an H1 further down is a section, not a title);
- headings, links (`[[target]]`, `[[target|label]]`, `[[target#anchor]]`,
  `[text](path.md)`, `![alt](path)`), outside fenced and inline code;
- typed relations: a list item whose first word is a relation name followed by
  links, such as `- 属于 [[Argus]]` or `- supersedes [[old plan]]`.

Four kinds, by when the note is true:

| kind | what it is |
| --- | --- |
| `log` | what happened on a day; appended, never deduplicated |
| `note` | a fact or a conclusion; the default |
| `card` | an entity: a project, a person, a system, a source |
| `decision` | a decision with checkable predictions and a review date |

The kind comes from `brain.yaml` (`kinds.field`, `kinds.map`, `kinds.cards`)
and then from the vault's scripts; a vault whose notes say nothing gets `note`
everywhere, and that is fine.

`source` says how a note is known: `lived` (distilled from one's own
practice), `seen` (witnessed or measured, with a date), `heard` (read or told).
Confidence is computed, never typed in: the source sets the base, independent
corroboration and the source card's record move it. Only a person writes
`lived`; nothing promotes `heard` on its own.

`sensitivity` is `open`, `private` or `sealed`. It comes from path prefixes in
`access.yaml`, then a script, then the note's own frontmatter. A sealed note is
never given to any principal but the owner: not in reads, search, recall,
graph or suggestions.

## Links

Resolution is the vault tool's (`resolveLink` in the vault tool's `.tools/vault.mjs`),
ported rule for rule:

1. Normalise: backslashes to slashes, drop `./`, strip an absolute or
   `Notes/`-prefixed path down to vault-relative, drop a `:line` suffix; try the
   text as written and percent-decoded.
2. A wiki link tries the path from the vault root, then from the note's
   folder; a Markdown link tries the note's folder first. Each try also tries
   the path with `.md` added (not for images).
3. A path-style Markdown link that matched nothing is broken. A wiki link
   falls back to the file name: one match wins; several, and the one in the
   note's own folder wins; otherwise it is ambiguous.
4. New here: a link that still matched nothing is tried against aliases,
   which are card `id`s and `aliases`, and old paths and old names from git's
   rename history. One match wins.

New links are written the way the vault already writes them: a bare
`[[name]]` when the name is unique, otherwise the path from the vault root
with the title as the label.

## Writes, and the git log as their log

The index reads git history incrementally (`git log --name-status -M`). Each
commit gives, per note, a write by its author at its time. Notes changed
together in a commit of at most `co_change.max_notes` notes get a co-change
edge; a reorganisation that touches hundreds of notes says nothing about
which belong together. Renames become old-path aliases.

## Reads: events

Reads are not in git, so they are recorded. One JSON object per line in
`.noto/events/<host>/<yyyy-mm>.jsonl`:

```json
{"time":"2026-11-05T01:02:03.456Z","actor":"owner","verb":"open","path":"A/B.md","session":"k3x9","from":"A/index.md"}
```

| field | meaning |
| --- | --- |
| `time` | ISO 8601, UTC |
| `actor` | the principal: `owner` for the person, or an agent's name |
| `verb` | `open` (shown to a person), `read` (an agent read it), `recall` (put into a context pack), `cite` (an agent used it in an answer), `accept` and `reject` (a proposal) |
| `path` | vault-relative path |
| `session` | groups one sitting; optional |
| `from` | the note this one was reached from, by a link; optional |
| `query` | the cue, for `recall`; optional |

Files are per host, so two machines syncing the vault never conflict on them.
Unknown fields are kept and ignored. The index reads each file from the byte
offset it reached last time.

## Weights: nodes and edges

Every note has a heat, and every pair of associated notes an edge weight, as
decayed sums. An event of weight `w` at time `t` contributes
`w * 2^(-(now - t) / H)`, with the half-life `H` per kind of signal in
`brain.yaml`. They are kept as accumulators (value and the time it was last
brought up to date), so a new event costs one update and nothing is rescanned.

| edge type | from | default half-life |
| --- | --- | --- |
| `link` | a link in the text | none: structure, weight 1 |
| `relation` | a typed relation line | none, weight 1.5 |
| `visit` | opened one after the other in a session, within 10 minutes; doubled when reached by the link | 60 days |
| `co_change` | changed in the same small commit | 120 days |

Heat counts opens (1), agent reads (0.5), recalls (0.25) and writes (2), with a
30-day half-life. Agents' reads make visit edges at a quarter of the weight, so
an agent sweeping a folder does not rewire the graph.

Heat and edge weights rank recall and search; they never delete anything. That
is forgetting: what is not used sinks, and stays on disk.

`graph` exports nodes and edges as JSON for any graph or heat-map tool:

```json
{"generatedAt":"…","halfLifeDays":{"heat":30},
 "nodes":[{"id":"A/B.md","title":"…","kind":"note","folder":"A","heat":3.2,"reads":12,"writes":4,"lastRead":"…","lastWrite":"…","degree":7}],
 "edges":[{"source":"A/B.md","target":"A/C.md","type":"visit","weight":1.7,"count":5,"last":"…"}]}
```

## Recall

`recall(cue, {from, budget})` returns a context pack: the notes most likely to
matter for the cue, each with where it is, what kind it is, how it is known,
why it was chosen, and an excerpt, until the budget (characters) is spent.

1. Seeds: full-text matches for the cue, exact title and alias hits, and the
   `from` note's neighbours.
2. One hop along edges from the best seeds, scaled by edge weight.
3. Score: relevance, times kind priority (decision and card first, log last),
   times `1 + 0.15 ln(1 + heat)`, times a source factor, times a status factor
   (superseded notes give way to what superseded them).
4. Drop what the principal may not see, drop superseded notes whose successor
   is in the pack, drop exact duplicates.
5. Excerpts: the paragraphs around the matches, or the head of the note.

Recall is lazy: it records a `recall` event only for the notes it returns.

## Access

`access.yaml` names principals. The owner is the person; the CLI acts as the
owner unless `NOTO_VAULT_KEY` names another principal. The MCP server acts as
the principal its key names, or as `default`.

```yaml
sensitivity:
  default: open
  private: ["Work/", "Journal/"]
  sealed: []
principals:
  claude-code:
    keys: [<sha256 of the key>]
    read: ["**"]
    max_sensitivity: private
    write: []
    append: ["Journal/**"]
    verbs: [read, search, recall, append, propose, link]
  default:
    read: ["**"]
    max_sensitivity: open
    verbs: [read, search, recall]
```

`.noto/**` and `.git/**` are never writable by anyone but the owner, whatever
the policy says: scripts in `.noto/scripts` run as code.

A path an agent means to change is taken as the disk spells it, folder by
folder in any case, so another spelling of a sealed folder is still that
folder; it may not go through a symbolic link or into a dot folder, and a note
that exists must be one the agent can see. Anyone but the owner sees only the
proposals they made. A long-running MCP server opens the vault again when the
config, the policy or a script changes, so a revoked key stops working without
a restart.

This guards agents that reach the vault only through the MCP server or this
CLI with their key. An agent with a shell and file access is bounded by the
operating system, not by this file; the policy then still attributes its
writes and keeps sealed notes out of everything this package returns.

## Proposals

A proposal is a change a person reviews before it lands. It is two commits
under `refs/noto/proposals/<id>`: the first records the files as they were
when the change was made (the working tree, not `HEAD`), the second the
change. `git diff <ref>~1 <ref>` is exactly the proposed change. The commits
are made with git's plumbing against a temporary index, so the working tree,
the person's index and their branches are never touched, and the refs are not
branches, so nothing pushes them.

Proposals are diffed without rename detection: a move is a deletion and an
addition, and the reviewer sees and the accept applies both. Accepting merges
each file three ways (`git merge-file`: the file now, the base, the proposal)
into the working tree, and stops on a conflict for that file. The person commits the result their usual way. Accepting or rejecting
deletes the ref and records an event.

## Suggestions

`suggest` finds the links a vault is missing: a note that names another by
its title, a card's id or an alias without linking it (`mention`); two notes
opened or changed together again and again with no link between them
(`together`); a link that reaches its note only through an old path
(`stale`); and whatever the scripts add. Each has an id, the first seven hex
digits of the SHA-1 of its type, its note and its target, so the same
suggestion has the same id on every run.

A mention is weighed by how distinctive the name is, how many notes use it,
and how near the two notes sit: notes sharing two or more folders are near,
one folder counts 0.8, none 0.45, because across areas a title is as often an
ordinary phrase that is some other note's title. A day's log, and a card
named by an id or alias written in its frontmatter, are never further than
0.8. A title with Chinese running on into it on both sides counts 0.6. Only
running text is read: not frontmatter, headings, code, links (labels
included), URLs or paths.

Nothing is applied until the person says so: `suggest --review` asks about
each, strongest first, then makes the yes into one proposal and applies it
if asked; `--propose <id...>` makes a proposal; `--dismiss <id...>` says no.
A no is a line in `.noto/dismissed.jsonl`:

```json
{"type":"mention","from":"A/B.md","to":"C/D.md","time":"2026-11-05T10:45:40.247Z"}
```

The file holds the type and both paths, not the id, so it reads without this
package; a dismissal lapses when either note moves.

## Scripts

`.noto/scripts/*.mjs` are the vault's own rules, loaded in name order. Each
default-exports an object with any of:

```js
export default {
  name: 'roob',
  ignore(path) { return false },              // true keeps a file out of the index
  text(note) { return note.body },            // the text that search sees
  derive(note, ctx) { return { kind, source, sensitivity, status, aliases, tags, relations } },
  suggest(note, ctx) { return [{ target, reason, score }] },
}
```

`note` is `{ path, title, frontmatter, body, headings, links }`; `ctx` has the
vault root, the config and a YAML parser. Results are cached by the note's
hash and a fingerprint of the scripts and config, so editing a script
re-derives everything on the next refresh.

## Verbs

The same eight verbs through the CLI and the MCP server:

| verb | does |
| --- | --- |
| `read` | one note by path, id or alias, with its hash |
| `search` | full text, CJK by bigrams, with kind, folder and status filters |
| `recall` | a context pack for a cue |
| `append` | a timestamped entry at the end of a log note |
| `propose` | a set of file changes as a proposal |
| `write` | replace a note, given the hash it was read at |
| `link` | add a typed relation line |
| `supersede` | mark a note superseded by another, and link them |

Every write names its author. A direct write requires the principal's scope;
anything else must be proposed.

## Indexing

One SQLite file, WAL mode, opened by whichever process needs it; writers
serialise on SQLite's lock. A refresh stats every note and reparses only those
whose size or modification time changed (or whose hash did, for a touched
path list from a watcher), then re-resolves links if the set of files changed,
then reads new git commits and new event lines. Full text is a contentless
FTS5 table over text in which runs of CJK characters are written as
overlapping bigrams plus the run's last character, so a two-character Chinese
word matches and a one-character query works as a prefix.

Targets on a 10,000-note vault: a cold build under 10 s, a refresh after one
saved note under 100 ms.
