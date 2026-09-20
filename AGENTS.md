# AGENTS.md

Read this before changing anything. It is short on purpose.

## What this repository is

bouncer-gates is a set of CI gates. Each gate is a pure function that takes files and
returns findings. The gates are the product; the website in `src/` is
documentation for them.

Deeper reading, in order of usefulness: [docs/architecture.md](docs/architecture.md),
[docs/gates.md](docs/gates.md), [CONTRIBUTING.md](CONTRIBUTING.md).

## The one rule that matters here

**A gate must never fail open.**

If a gate cannot do its job (no git history, a file it cannot parse, a config it
does not understand), it reports that it was *skipped* and says why. It does not
return an empty array and let the build go green. "We looked and it was fine" and
"we could not look" are different answers, and only one of them is safe to merge
on.

This has already gone wrong once here, and it is worth knowing how, because the
failure was invisible: a shallow CI clone has no base ref, so no migration looked
new, so the gate printed "no new migrations in this change" and everybody assumed
migrations were being checked. `skipWhen` now returns a reason string precisely so
those two cases cannot render the same.

If you are adding a code path where a gate returns no findings, ask which of those
two things just happened, and make the output say so.

## Where a rule belongs

Not everything belongs in a gate. Put each rule in the cheapest place that can
hold it:

| Kind of rule | Where | Why |
|---|---|---|
| Formatting, import order | Formatter | Deterministic, already solved |
| Types, null safety | Compiler, strict mode | Free, and it runs in the editor |
| Taste, context, intent | This file | A machine cannot check taste |
| Wrong is expensive | **A gate in `gates/`** | Only this category actually holds |

A rule in this file that you would be upset to find broken in production is in the
wrong place. Move it into a gate.

## Gates are pure

A gate imports from `./lib/finding.mjs` and nothing else. No `node:fs`, no
`child_process`, no `process.env`, no printing.

This is not style. The same functions run in four places:

- `bin/bouncer-gates.mjs`, the CLI, which reads from disk through `bin/lib/run.mjs`
- `bin/lib/mcp.mjs` and `bin/lib/agents.mjs`, the MCP server and editor hook, same runner
- `functions/api/scan.js`, a Cloudflare Worker, where no filesystem exists
- `server/index.mjs`, a Node service on Railway
- `src/components/Playground.tsx`, in the browser

If a gate needs git history, it takes the history as an argument. The caller
decides where it comes from. See `migration-safety`.

## Precision is the product

Speed is easy. Not crying wolf is what decides whether any of this survives a
month on a real team.

When you touch a matcher, run it against a real codebase before you ship it:

```bash
node bin/bouncer-gates.mjs --only <gate> --root ../some-real-repo
```

Read every finding. If more than a handful are wrong, the rule is too broad.

Three false-positive families have already been found this way and each is now a
named test: credential fixtures in spec files, percentages that look like money
conversions, and local development credentials. Do not reintroduce them.

## Adding a gate

1. New file in `gates/`, exporting `name`, `title`, `summary`, `scan`.
2. Register it in `gates/index.mjs` with what it `needs`, and a `skipWhen` that
   returns a reason string if it can be inapplicable.
3. Tests in `tests/gates.test.mjs`. **Test that it stays quiet**, not only that it
   fires. At least one negative test per rule.
4. Document it in `docs/gates.md`, including what it misses.

Full version in [CONTRIBUTING.md](CONTRIBUTING.md). The
[`new-gate`](.claude/skills/new-gate/SKILL.md) skill walks through it, including
the part where it tells you the rule should not be a gate at all.

## Findings

- Report a location and a rule id. **Never include the matched text.** A secret
  scanner that quotes what it found writes the secret into the CI log, which is
  more public than the file it came from.
- Every finding needs a `fix` that says what to do instead, actionable by somebody
  who has never seen this gate.
- `error` blocks the merge. `warn` does not. Choose `warn` when you are not
  confident enough to stop someone's afternoon.

## The escape hatch

Every gate honours a comment on the offending line or the line above:

```
// bouncer-gates-ok(scope): admin dashboard reports across all tenants by design
```

The reason is required. A bare `bouncer-gates-ok(scope):` suppresses nothing. That is
the whole design: easy to use, impossible to use silently, and the justification
ends up in the file where the next reader finds it.

Do not add a config option that disables a gate globally. If a gate is wrong often
enough to need that, fix the gate. File-level `exclude` exists, and the runner
prints how many files each pattern removed on every run so the list cannot grow
quietly.

## Things that will waste your time

- **Windows checkouts.** `git ls-files` returns forward slashes, `path.join` does
  not. Normalise with `.replace(/\\/g, "/")` before comparing paths. An earlier
  version of the doc-links gate passed on Windows and silently checked almost
  nothing on Linux.
- **Writing a gate that scans its own rule table and flags itself.** Whole-line
  comments are skipped for this reason. Use `isCommentLine`.
- **Control characters in source.** An early glob compiler used NUL as a
  placeholder token. It worked, and it made the file read as binary to `grep` and
  to bouncer-gates's own file reader, so the tool could not scan its own runner.
- **Regex-heavy edits through a shell heredoc.** Doubled backslashes get eaten and
  the result is a regex that silently matches the wrong thing. Write the file
  directly.
- **`npm ci` needs `package-lock.json` committed.** It is.

## Conventions

- ES modules, `.mjs` for anything that runs in Node directly.
- No dependencies in `gates/`. It must run with nothing installed.
- No em dashes in prose or comments.
- Comments explain why, not what.
- Plain SCSS in the site, no framework.
