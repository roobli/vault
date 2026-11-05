# @roobli/vault

A folder of Markdown notes, kept as memory that a person and their agents
share. The notes stay plain files in git; this package adds one link resolver,
an index that can always be rebuilt, a record of what was read, scoped access
for agents, recall, link suggestions, and proposals that wait for the person.

No runtime dependencies. Node 22.13 or later (it uses `node:sqlite`), and it
runs the same inside Electron, so Noto can embed it.

The design, with every file format and the access model, is in
[docs/design.md](docs/design.md).

## Use

```sh
pnpm install && pnpm build
alias noto-vault="node $PWD/bin/noto-vault.mjs"

cd ~/my-vault
noto-vault init          # .noto/brain.yaml, .noto/access.yaml, .noto/scripts/
noto-vault index         # about 9 s for 8,000 notes the first time, under 100 ms after
noto-vault recall "what did we decide about index names"
noto-vault search 改造方案
noto-vault suggest       # links the notes are missing, each with an id
noto-vault suggest --review               # one at a time: link it, never, skip; then apply the yes
noto-vault suggest --propose <id...>      # or name them, as a proposal to review
noto-vault suggest --dismiss <id...>      # never suggest these again
noto-vault proposals show <id>
noto-vault proposals accept <id>
noto-vault graph --out graph.json         # nodes with heat, edges with weights
```

`noto-vault help` lists every command.

## Agents

An agent gets a key, and the key names what it may do:

```sh
noto-vault key add claude-code      # prints the key once, adds the principal to .noto/access.yaml
claude mcp add noto-vault -e NOTO_VAULT_ROOT=$HOME/my-vault -e NOTO_VAULT_KEY=<key> \
  -- node /path/to/vault/bin/noto-vault.mjs mcp
```

The MCP server speaks both the `initialize` handshake (2025-11-25 and earlier)
and per-request metadata (2026-07-28). Its tools are the eight verbs: `recall`,
`search`, `read`, `append`, `propose`, `write`, `link`, `supersede`, listed
only as far as the key allows. Without a key an agent reads what is `open`
and writes nothing.

## A vault's own rules

Every vault names things its own way. `.noto/brain.yaml` maps frontmatter
values onto the four kinds (log, note, card, decision) and sets the
half-lives and budgets. Anything more is a script in `.noto/scripts/`:

```js
export default {
  derive(note) {
    if (note.path.includes('/ref_')) return { source: 'heard' };
  },
  text(note) { return note.body.replace(/<!-- generated -->[\s\S]*?<!-- end -->/g, ''); },
};
```

Scripts run as code, so `.noto/` is never writable by an agent.

## Develop

```sh
pnpm verify                         # typecheck, tests, build
NOTO_VAULT_PROFILE=1 noto-vault index --full    # phase timings on stderr
```
