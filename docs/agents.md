# bouncer-gates inside the editor

CI runs after the pull request exists. By then the secret is in a commit, the
unscoped query is in three files, and the person fixing it is not the one who
wrote it. Increasingly that person is not a person at all.

This page is about running the same gates while the file is still open, in
Claude Code, Cursor, and anything else that speaks the Model Context Protocol
or can run a command after an edit.

## One command

```bash
npx bouncer-gates --init-agents
```

writes three files into the repository and touches nothing else in them:

| File | What it adds |
|---|---|
| `.mcp.json` | A `bouncer-gates` MCP server. Claude Code reads this on start. |
| `.cursor/mcp.json` | The same server, where Cursor looks for it. |
| `.claude/settings.json` | A `PostToolUse` hook on `Edit`, `Write`, `MultiEdit` and `NotebookEdit` that runs `bouncer-gates --hook`. |

Commit them. Everyone who opens the repository in either editor gets the gates
without doing anything, and so does every agent.

## What the agent sees

### The hook

After every file the agent writes, the hook scans that one file. If nothing
blocks, it is silent. If something does, the agent gets this in the same turn:

```
bouncer-gates found 1 blocking finding. Fix each one, or if it is deliberate, add a comment on that line or the line above:
  // bouncer-gates-ok(<gate>): <why this is fine here>
The reason is required. A bare marker suppresses nothing.

x src/orders.ts:12  scope/unscoped-query
  "order" is tenant-owned, but nothing in this query mentions "tenantId", so it returns rows from every tenant.
  fix: Add tenantId to the where clause, or go through a tenant-scoped client.

skip migration-safety: no new migrations in this change
```

Every finding carries a fix written for someone who has never seen the gate.
That was designed for a new contributor. It turns out to be exactly what a
model needs to correct itself in one step, which is why the format did not
change for this.

Skips are listed too. An agent told "no findings" when the scope gate could not
run would learn that the code is fine. It is not; it is unchecked, and the
output says which.

### The MCP tools

| Tool | Does |
|---|---|
| `bouncer_gates_scan` | Scan named files, tracked or not, or the whole repository, or only changed files. |
| `bouncer_gates_scan_snippet` | Scan code that is not on disk yet, with this repository's config. |
| `bouncer_gates_explain` | What one gate checks and how to excuse one line. |
| `bouncer_gates_list_gates` | The gates, one line each. |

The server's instructions tell the agent to scan the files it changed before
finishing, to fix blocking findings, to write a real reason if it excuses one,
and never to edit the config or the baseline to make a finding disappear.

## Other editors

Any MCP client:

```json
{ "mcpServers": { "bouncer-gates": { "command": "npx", "args": ["-y", "bouncer-gates", "--mcp"] } } }
```

Any post-edit hook. Pipe JSON with `file_path`, or `paths: []`, or the Claude
Code shape `tool_input.file_path`, to:

```bash
npx -y bouncer-gates --hook
```

It exits 0 with nothing on stdout or stderr when the file is clean, and 2 with
the findings on stderr when something blocks. It also exits 2 when it could not
run at all, with a message saying the file was not checked. Exit 0 only ever
means "looked, and it was fine".

## What this is not

- It is not a linter. Five gates, five expensive bug classes. It does not slow
  down on a clean file and it does not comment on style.
- It does not replace CI. The hook sees one file at a time and the MCP server
  runs when asked. The CI run is the one that sees everything and blocks the
  merge. Run both.
- It cannot stop an agent from writing `bouncer-gates-ok(secrets): fine` with no
  real reason. It can make the reason mandatory and put it in the file, where a
  reviewer sees it. The `gate-review` skill in `.claude/skills/` is for that
  reviewer.

## Migrations from the editor

In CI, a migration is "new" if it was added since the base branch. An editor
handing over a `.sql` file that is not committed yet has no base to compare
against, so any uncommitted `.sql` the hook or `bouncer_gates_scan` is given is
treated as new. That is the only honest reading of a migration somebody is
writing right now, and it means the migration gate answers inside the editor
even in a shallow clone where the CLI would have to skip.
