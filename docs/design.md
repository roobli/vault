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
    eval/runs/<host>.jsonl   each eval run's scores, append-only (tracked by choice)
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
A note says it in frontmatter as `known: lived`, never as `source:`, which in
most vaults already holds where a note came from (a URL, a book). What the note
says wins; otherwise a script infers it; otherwise it is unknown.
Confidence is computed, never typed in: the source sets the base, independent
corroboration and the source card's record move it. Only a person writes
`lived`; nothing promotes `heard` on its own.

`sensitivity` is `open`, `private` or `sealed`. It comes from path prefixes in
`access.yaml`, then a script, then the note's own frontmatter. A sealed note is
never given to any principal but the owner: not in reads, search, recall,
graph or suggestions.

The index keeps, for each of kind, known and sensitivity, where the value came
from: `note` (its frontmatter), `script`, `folder` (a path prefix in
`access.yaml`), `config` (a `brain.yaml` field mapping, the card-name rule or
the dated-name rule) or `default` (nothing said anything). When layers give the
same sensitivity, the one nearest the note is named: the note, then a script,
then the folder.

## Links

Resolution is ported rule for rule from `resolveLink` in `vault.mjs`, the
command-line tool of the vault this package was first built against, so the
two read a vault's links the same way:

1. Normalise: backslashes to slashes, drop `./`, read a path written through
   the vault's own folder (`/Users/me/Notes/A/b.md:12`, or `Notes/A/b.md`, in
   a vault called `Notes`) from inside it and drop its `:line` suffix; try the
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
{"time":"2026-11-05T01:04:00.000Z","actor":"claude-code","verb":"recall","paths":["A/B.md","C/D.md"],"session":"ea01","query":"index names"}
{"time":"2026-11-05T01:05:10.000Z","actor":"owner","verb":"open","path":"A/B.md","session":"k3x9","repeat":4,"until":"2026-11-05T01:07:30.000Z"}
```

| field | meaning |
| --- | --- |
| `time` | ISO 8601, UTC |
| `actor` | who caused it: `owner` for the person, or an agent's name (below) |
| `verb` | `open` (shown to a person), `read` (an agent read it), `recall` (put into a context pack), `cite` (an agent used it in an answer), `write` and `append` (an agent wrote it), `propose`, `accept` and `reject` (a proposal) |
| `path` | vault-relative path |
| `paths` | instead of `path`: the notes one call did this to, such as the notes one recall returned |
| `session` | groups one sitting; optional |
| `from` | the note this one was reached from, by a link; optional |
| `query` | the cue, for `recall`; optional |
| `repeat`, `until` | the same event this many times in a row, the first at `time` and the last at `until`; optional, one when absent |
| `proposal` | the proposal's id, on `propose`, `accept` and `reject`; added later, so older lines lack it |
| `author` | who made the proposal (its git author, read before the proposal goes), on `accept` and `reject` |
| `reason` | why the person decided as they did, in a word or a few, when they said; at most 200 characters |
| `reviewMs` | how long the person looked at it before deciding, in whole milliseconds, when the caller measured it |

Files are per host, so two machines syncing the vault never conflict on them.
Unknown fields are kept and ignored. The index reads each file from the byte
offset it reached last time, and keeps a fingerprint of the bytes just before
it: a file that shrank, went away, or whose fingerprint no longer matches
(rewritten by hand or by git), is read again from the start, with every other
file. Sizes are taken under the same lock as the offsets, so another process
reading at the same moment never makes a file look shorter than it is.

Two rules keep the files short. One call is one line: a recall that returns
eight notes writes `paths` with eight entries, not eight lines. And a writer
that lives a while (Noto, an MCP server) counts a repeat rather than writing
it again: the same event (actor, verb, notes, session, link, cue) within a
minute of the last of its run is added to a `repeat` line, written when the
run ends or reaches the 1000 rows a reader counts for one line, while the first is written at once so the index sees it straight
away. Lines already written are never changed. On the first real vault this
cut 908 lines to 244, nearly all of it from recalls.

### Who an event names

An event names who caused it, so that an agent's reading is never counted as
the person's (an agent's visits weigh `visit.agentWeight` in the trains of
thought, and Note Info lists every reader by name):

- Noto records the person's opens as `owner`.
- An MCP server with a key records under the key's principal. A server
  started with `--owner` serves an agent all the same, and records under the
  name its client gives (`clientInfo.name`, made safe: `claude-code`).
- The command line is the person's hands or an agent's. It records under
  `NOTO_ACTOR` when that is set (`owner` says it is the person), else under
  the agent that says so in its environment: Claude Code sets `CLAUDECODE=1`
  (`claude-code`, one session per `CLAUDE_CODE_SESSION_ID`), Codex sets
  `CODEX_THREAD_ID` (`codex`). Otherwise it is `owner`.
- `noto-vault eval` measures recall and records no reads; it keeps its
  scores in a ledger of its own (below).

What an agent writes by editing files itself reaches the index only through
git, which cannot say who made a change. `noto-vault record <verb> <path...>`
lets it say so: it appends a line in the vault each note is in, opens no
index, and passes over anything that is not a note in a folder that keeps
memory. `noto-vault record --hook` reads a tool hook's JSON on stdin (Claude
Code's `PostToolUse`: `Read` is a read, `Write`, `Edit`, `MultiEdit` and
`NotebookEdit` are writes) and never fails the agent's step. Only an agent's
hook sends such a payload, so it is never recorded as the person's: it is the
agent the environment names, or `claude-code`, since a hook may not be given
the variables the agent's own commands get. Note Info then
lists the agents that wrote a note beside its commits. The commit itself
stays the person's: nothing is added to commit messages.

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

Every number above can be tuned under `recall:` in `brain.yaml`. Each key is
optional and defaults to the value recall has always used. A weight is a
number of 0 or more; a count is a whole number, and 0 switches that source of
candidates off; `limit` and `pool` are at least 1. A value out of range, or
an unknown key, is ignored, as elsewhere in the config. Editing the section
changes the config's fingerprint, so the index is refreshed in full on the
next open, as for any config edit.

| key | meaning | default |
| --- | --- | --- |
| `kind_weight` | score factor per kind | `{decision: 1.3, card: 1.2, note: 1, log: 0.85}` |
| `source_weight` | score factor per `known`; 1 when unknown | `{lived: 1.15, seen: 1, heard: 0.85}` |
| `status_weight` | score factor for a superseded note, and an `archived` one | `{superseded: 0.35, archived: 0.8}` |
| `heat` | the score is multiplied by `1 + heat ln(1 + note heat)` | 0.15 |
| `limit` | notes in a pack when the caller does not say | 12 |
| `pool` | candidates kept per note the pack may hold | 2 |
| `text_candidates` | full-text matches read for the owner | 80 |
| `text_candidates_shared` | the same for anyone else, whose hidden notes must not crowd out the rest | 600 |
| `bm25` | BM25 weights of the title, path and body | `{title: 8, path: 3, body: 1}` |
| `text_floor` | the least relevance of a full-text match, as a share of the best | 0.05 |
| `title_share` | added per share of the cue's words in the title | 0.6 |
| `all_words_candidates` | matches of every word of the cue read | 40 |
| `all_words` | the relevance each of them gets | 0.35 |
| `named` | relevance of a note the cue names by title, id or alias | 1.2 |
| `from` | relevance of the note the caller is in | 0.6 |
| `merge` | a note reached a second way gains this share of the weaker relevance | 0.25 |
| `hop_seeds` | the best seeds one hop goes out from | 10 |
| `hop.link_out`, `hop.relation_out` | share of a seed's relevance passed to what it links to, plainly or by a typed relation | 0.4, 0.6 |
| `hop.link_in`, `hop.relation_in` | the same, to what links to it | 0.3, 0.55 |
| `hop.edge` | an association edge of decayed weight `w` passes `edge w / (1 + w)` | 0.45 |
| `hop.edge_floor` | an edge passing less is not followed | 0.05 |

The sizes of excerpts (900 characters for the first three notes, 400 after,
none under 120) shape the pack, not the ranking, and are not tuned here.

### Measuring recall

`noto-vault eval <cases.yaml>` (`evaluate(vault, file, {k, search, config,
record})`) asks recall each case's query, without recording a read, and
scores the top `k` against the notes the case expects: hit@k (the share of
cases with an expected note in the top k), recall, MRR, and the share whose
first note is an expected one. Each run appends one line to
`.noto/eval/runs/<host>.jsonl`, unless `--no-record` (`record: false`). The
folders are made one at a time inside a `.noto/` that is there, as for the
events, and lines are never changed.

```json
{"time":"2026-11-09T09:00:00.000Z","actor":"owner","file":"eval/cases.yaml","mode":"recall","queries":40,"k":5,"hitAtK":0.85,"mrr":0.71,"firstHit":0.62,"schema":4,"config":"3f0c9a1b","version":"0.1.0"}
```

| field | meaning |
| --- | --- |
| `time`, `actor` | when, and who ran it, as for an event |
| `file` | the cases file, from the vault's root |
| `mode` | `recall`, or `search` with `--search` |
| `queries`, `k` | how many cases were scored, and at how many notes |
| `hitAtK`, `mrr`, `firstHit` | the scores, each from 0 to 1 |
| `schema` | the index schema version |
| `config` | the first eight hex digits of the SHA-256 of the recall config ranked by, its keys sorted, so runs under different numbers can be told apart |
| `version` | this package's version |

## Access

`access.yaml` names principals. The owner is the person; the CLI acts as the
owner unless `NOTO_VAULT_KEY` names another principal. The MCP server acts as
the principal its key names, or as `default`.

The file is the person's, often with comments, so the tools that change it
(`key add`, `key revoke`, and an editor through `addAgent`, `revokeAgent`
and `setFolderSensitivity`) change only the lines they are about, in the
file's own layout. Each change is proved before it is saved: the new text,
parsed as the server parses it, must equal the old policy with only that
change applied, or nothing is written. Where the editor and the parser could
disagree about a shape (a key written twice, a list where a map belongs),
that proof is what keeps a privacy click from quietly dropping an agent's
keys or a sealed folder. The file is replaced by a rename, never written in
place, and a `.noto/` or `access.yaml` that is a link is refused. A revoked
agent keeps its block, with `keys: []` and a `revoked:` time, so a list can
say when; `default` is revoked by giving it nothing to read. A folder's
privacy is its own pattern in one list, added only when the default or a
folder around it would not give that level already. A running MCP server
reads the file again before its next answer once it changes.

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

A proposal is a ref anyone with git can write, so what it may touch is
checked again when it is accepted: never a file under a dot folder (the
folder's settings in `.noto/`, its scripts, `.git`) or `node_modules`, and
never a file outside the vault when the vault is a folder of a larger
repository. Such a proposal is refused, named, and stays to be rejected.

Proposals are diffed without rename detection: a move is a deletion and an
addition, and the reviewer sees and the accept applies both. For showing one
file side by side, `vault.proposalFile(id, path)` gives it at both ends, null
where the file did not or will not exist; anyone but the owner sees only
their own proposals' files. Accepting merges
each file three ways (`git merge-file`: the file now, the base, the proposal)
into the working tree, and stops on a conflict for that file. The person commits the result their usual way. Accepting or rejecting
deletes the ref and records an event.

These events are the ledger of what became of each proposal. The `propose`
line names the proposal it made; an `accept` or `reject` names it again with
its author, and, when the caller gives them, a `reason` and a `reviewMs`
(`vault.accept(id, {reason, reviewMs})`, `proposals accept <id> --reason r
--review-ms n`). An accept that stops on a conflict records a `propose` line
naming the proposal, since it is not decided yet; the decision comes when it
is accepted again or rejected. The fields were added to the lines without
changing any other: a reader that does not know them reads the line as
before.

## Suggestions

`suggest` finds the links a vault is missing: a note that names another by
its title, a card's id or an alias without linking it (`mention`); two notes
opened or changed together again and again with no link between them
(`together`); a link that reaches its note only through an old path
(`stale`); and whatever the scripts add. Each has an id, the first seven hex
digits of the SHA-1 of its type, its note and its target, so the same
suggestion has the same id on every run.

A mention is weighed by how distinctive the name is, how many notes use it,
and how near the two notes sit: notes in the same folder, or sharing two or
more folders, are near, one shared folder counts 0.8, none 0.45, because across areas a title is as often an
ordinary phrase that is some other note's title. A day's log, and a card
named by an id or alias written in its frontmatter, are never further than
0.8. A title with Chinese running on into it on both sides counts 0.6. Only
running text is read: not frontmatter, headings, code, links (labels
included), URLs or paths.

A suggestion's change is a splice that also records the words it replaces;
`prepare(vault, suggestions)` turns the chosen ones into file changes and
leaves out, by name, any whose note no longer has those words there (it was
written to since, or is gone), so a list kept open for a while never puts a
link in the wrong place. A stale link is only offered where the note still
has a link at the place the index says.

Nothing is applied until the person says so: `suggest --review` asks about
each, strongest first, then makes the yes into one proposal and applies it
if asked; `--propose <id...>` makes a proposal; `--dismiss <id...>` says no.
A no is a line in `.noto/dismissed.jsonl`:

```json
{"type":"mention","from":"A/B.md","to":"C/D.md","time":"2026-11-05T10:45:40.247Z"}
{"type":"mention","from":"A/E.md","to":"C/D.md","time":"2026-11-05T10:46:02.118Z","reason":"not a name here","reviewMs":2500}
```

`reason` and `reviewMs` are there when the person gave them
(`dismiss(vault, items, {reason, reviewMs})`, `suggest --dismiss <id...>
--reason r --review-ms n`), with the same meaning as on a proposal's events.

The file holds the type and both paths, not the id, so it reads without this
package; a dismissal lapses when either note moves. `dismissals(vault)` lists
them, the latest first, and `undismiss(vault, ids | 'all')` takes some or all
back, keeping any line it cannot read as it was; both are the owner's, as
writing the file is.

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

Besides the verbs, the CLI has views over the same index that change nothing:
`backlinks`, `where`, `graph`, `suggest`, and `about`. `about <note>` (with
`--json`, the `AboutNote` that `about()` returns) is what a pane beside a note
in an editor shows: where its kind, known and sensitivity came from; its heat;
what supersedes it; the notes that link here; the notes it names without a
link, as `suggest` finds them; what is opened or changed with it; what recall
finds with its title as the cue, less everything in the lists before; its
broken links; reads per local day, readers and what led to it; commits and
appends; and which agents can see it, and why not. It needs the `read` verb,
leaves out of every list what the caller cannot see, and records nothing.
Anyone but the owner gets the same refusal for a hidden note as for a missing
one, and sees only its own entries among the readers and leads, and itself
among the agents; the reads per day and the together weights count everyone,
as heat, recall and suggest already do. It runs on every note switch, so it reads the index by the note's
own keys; the name matcher behind the mentions is kept by an open vault
until the index marks a change of names with a new `names` token in its meta table.

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
