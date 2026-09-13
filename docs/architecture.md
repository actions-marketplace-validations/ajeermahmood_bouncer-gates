# Architecture

Small enough to read in one sitting. There are three pieces: pure gates, a runner
that does all the I/O, and a handful of thin callers.

```
gates/*.mjs          pure: (files) -> findings.  no fs, no git, no printing
gates/index.mjs      the registry: what each gate needs, when it must skip
gates/lib/           finding shape, acknowledgements, fingerprints, baseline, glob
bin/lib/run.mjs      the runner as a function: git, file reads, config, baseline
bin/bouncer.mjs      the CLI: flags, printing, exit codes
bin/lib/mcp.mjs      the same runner, served over MCP to an agentic editor
bin/lib/agents.mjs   the post-edit hook, and the --init-agents config writer
bin/lib/telemetry.mjs  one anonymous ping a day, see docs/telemetry.md
shared/demo-*.mjs    the config and scan the hosted demos share
worker/index.js      Cloudflare Worker: the API route, assets behind it
functions/api/       the same endpoint for a Cloudflare Pages deployment
server/index.mjs     Node service for Railway
src/                 Astro site, with a browser-side caller
```

## Gates are pure functions

A gate takes `{ path, text, lines? }[]` and returns findings. It does not read the
filesystem, shell out to git, read the environment, or print.

This is not a style preference. It is why one implementation of every rule runs in
four places:

| Caller | Runtime | Why it exists |
|---|---|---|
| `bin/bouncer.mjs` | Node CLI | CI, pre-commit, local |
| `bin/bouncer.mjs --mcp` | Node, stdio | Claude Code, Cursor and any MCP client, while the file is open |
| `bin/bouncer.mjs --hook` | Node, one shot | after every file an agent writes |
| `worker/index.js` | Cloudflare Worker | the deployed playground; no filesystem exists there |
| `functions/api/scan.js` | Cloudflare Pages Function | the same endpoint, for a Pages deployment |
| `server/index.mjs` | Node service on Railway | a hosted API for teams not running Node |
| `src/components/Playground.tsx` | browser | works with no server at all |

Workers and Pages need different plumbing for the same route, and the difference
is silent when you get it wrong. Pages compiles `functions/api/scan.js` by
convention; Workers ignores that directory entirely and expects one entry that
routes what it wants and hands the rest to an assets binding. The first
deployment of this site went out as a Worker, so `/api/scan` returned the static
404 page and the playground quietly fell back to running in the browser, exactly
as designed. The fallback worked so well it hid the outage. That is the real
hazard of a good fallback, and it is why the footer names which runtime answered.

A playground with its own copy of the regexes would drift from the real gates
within a month and start teaching visitors something false. There is nothing to
drift, because there is nothing to copy.

The rule has one real consequence: **a gate that needs git history takes the
history as an argument.** `migration-safety` does not run `git diff`; the runner
does, and hands it the added `.sql` files. That keeps the gate testable on string
literals and keeps every "where does this data come from" decision in one file.

## The registry

`gates/index.mjs` declares what each gate needs, so the runner gathers each input
once rather than every gate reaching for it:

```js
{ ...scope, needs: ["source"], run: (ctx, cfg) => scope.scan(ctx.source, cfg.scope) }
```

Available inputs: `source`, `markdown`, `repoFiles`, `addedSql`.

`skipWhen(ctx, config)` returns a **reason string** when the gate cannot or need
not run, and something falsy otherwise. Returning a reason rather than a boolean
is what makes these two visibly different:

```
skip  migration-safety (no new migrations in this change)
skip  migration-safety (cannot see history: the base ref "origin/main" is not in this clone)
```

The first means we looked and there was nothing to check. The second means we
could not look at all. An early version rendered both as the first, so a shallow
CI clone printed the reassuring message while checking nothing, and would have
kept doing that indefinitely.

## One rule, one implementation, four callers

The gate logic was shared from the start. What was not shared, for several
releases, was everything around it: which gates a hosted endpoint runs, the
try/catch that stops a throwing gate from reading as a pass, the sort order, and
the response shape. That was copy-pasted into the Worker, the Pages Function, the
Railway service and the browser playground, along with the scope config itself.

Which means the central claim was true of the rules and unverified for the rest.
Adding a tenant-owned model would have updated one caller and left three
answering differently, silently, forever.

It now lives in `shared/demo-scan.mjs` and `shared/demo-config.mjs`, and
`tests/demo-parity.test.mjs` asserts that no caller imports a gate directly.
That test exists because "we share the important part" is the easy half; the
important part is whatever actually differs between two runs, and configuration
usually is.

## The runner is a function too

The CLI used to be one script that read the world, ran the gates and printed.
When the MCP server and the hook arrived, that script became
`bin/lib/run.mjs`, which returns a result and never prints or exits, and the
CLI became one of three callers of it. The same reasoning that produced
`runDemoGates` for the hosted demos applies: the part worth sharing is the ten
lines around the gates, the try/catch and the skip handling, because the caller
that retypes them is the one that lets a crashed gate read as a pass.

Two things an editor needs that CI does not: scanning a file git does not track
yet, because the agent just wrote it, and treating an uncommitted `.sql` as a
new migration, because there is no base to diff it against and "new" is the
only honest reading.

## A gate never fails open

Stated once here because it is the property everything else serves.

- Cannot read the input? **Skip, with a reason.** Never pass.
- Threw an exception? **The run fails.** A crashed gate is a failure, not a
  silence; otherwise the build goes green because the check broke before it could
  find anything.
- Unrecognised CLI flag? **Exit 2.** Silently accepting `--onyl scope` and scanning
  everything is how a job passes for a year while checking nothing intended.
- `--changed` with no base ref? **Exit 2.** Scanning everything would be a surprise
  timeout and scanning nothing would pass for the wrong reason, so it stops and
  says which.

## Exit codes

| Code | Means |
|---|---|
| 0 | Nothing blocking |
| 1 | Blocking findings, or a gate crashed |
| 2 | The runner could not do its job |

The 1/2 split matters in CI. A failed check and a broken tool need different
reactions, and collapsing them means a misconfigured runner looks exactly like a
codebase full of problems.

## The finding shape

```js
{ path, line, rule, message, fix, severity }   // severity: "error" | "warn"
```

Two rules about findings, both load-bearing:

**Never include the matched text.** A secret scanner that quotes what it found
writes the secret into the CI log, which is usually more public than the file it
came from. A finding carries a location and a rule id; a human opens the file.

**Every finding needs a `fix`.** "This is wrong" with no way forward is how a gate
earns a reputation as an obstacle. The `fix` has to be actionable by somebody who
has never seen the gate before, because increasingly that is who is reading it.

## The escape hatch

`acknowledged(lines, index, gateName)` looks for a marker on the offending line or
the line above:

```
// bouncer-ok(scope): finance dashboard, spans all tenants by design
```

The trailing reason is required by the regex. A bare marker matches nothing.

The design tension: the hatch has to be easy, or people route around the gate
entirely and you lose the signal. It has to be impossible to use silently, or it
decays into a blanket ignore. Requiring a reason gets both, and puts the
justification in the file rather than in a pull request nobody reopens.

There is deliberately **no config option to disable a gate globally.** If a gate is
wrong often enough to need one, the gate is wrong and should be fixed. File-level
`exclude` exists, and the runner prints how many files each pattern removed on
every run so the list cannot grow quietly.

## Performance shape

Every line-based gate follows the same three-stage funnel, cheapest first:

1. **Path reject.** Extension and directory checks, no file read.
2. **Whole-file union regex.** One alternation of every rule in the gate. If the
   file cannot match, skip it entirely, including the line split.
3. **Per-line union, then the per-rule loop.** Most lines fail the union and never
   reach the loop.

Lines are split once by the runner and shared through `lines(file)`, which caches
on the file object, so three line-based gates split each file once rather than
three times.

See [performance.md](performance.md) for what that was worth, measured.

## Adding a gate

See [CONTRIBUTING.md](../CONTRIBUTING.md), or run the
[`new-gate`](../.claude/skills/new-gate/SKILL.md) skill, which will also tell you
when the rule you want should not be a gate at all.
