# Changelog

Notable changes. Dates are the day the work was done.

## 0.4.1 - 2026-09-20

Listing release. No behaviour changes.

`server.json` describes the MCP server for the official MCP Registry, and
`package.json` carries the `mcpName` the registry checks to confirm the npm
package and the listing are the same project. The listed launch command is
`npx bouncer-gates --mcp`, because plain `npx bouncer-gates` runs the CLI once
and exits rather than speaking MCP.

## 0.4.0 - 2026-09-13

The gates move into the editor, next to the agent writing the code.

### `bouncer --init-agents`, `--mcp` and `--hook`

CI sees a mistake after the pull request exists. An agentic editor can see it
in the turn it was made. `--mcp` serves the gates over the Model Context
Protocol on stdio, with no dependencies, so any client can call
`bouncer_scan`, `bouncer_scan_snippet`, `bouncer_explain` and
`bouncer_list_gates`. `--hook` reads a post-edit event on stdin, scans the one
file it names, and exits 2 with the findings when something blocks.
`--init-agents` writes both into `.mcp.json`, `.cursor/mcp.json` and
`.claude/settings.json`, merging with whatever is there.

Both paths report a runner failure as an error, never as "no findings", and
list skipped gates next to the findings. An agent told the code is clean when
the scope gate could not run would learn the wrong thing.

A file handed over by an editor is scanned whether or not git tracks it yet,
and an uncommitted `.sql` is treated as a new migration, so the migration gate
answers inside the editor even in a clone with no base ref.

### The scan is a function

`bin/lib/run.mjs` is what used to be the body of the CLI: git, file reads,
config, baseline, the gate loop with its try/catch. The CLI, the MCP server and
the hook all call it. The moment the hook had its own copy of the loop it would
have been the one caller that let a throwing gate read as clean.

### Telemetry

One anonymous ping a day: a random id, the version, the runtime, the OS and
the Node major. Nothing about the code. `BOUNCER_TELEMETRY=0` or
`DO_NOT_TRACK=1` turns it off, the first run says so, and
[docs/telemetry.md](docs/telemetry.md) is the complete list. `npm run stats`
reads the numbers back.

## 0.3.0 - 2026-09-05

A precision and adoption release. The gates were read against inputs they had
never been shown, and the documentation was rewritten for someone who has never
used a tool like this.

### The scope gate works without a scoped client

Until now the scope gate only checked code that reached around a tenant-scoped
wrapper. Most codebases do not have one yet, and for them the gate could not see
anything. `scope.clients` lists plain client names, and every list-style query
on a tenant-owned model must then mention the tenant column somewhere in the
call:

```ts
prisma.order.findMany({ where: { status: "paid" } })   // scope/unscoped-query
```

Single-row lookups by id are deliberately left alone, and the reference says why.

### `bouncer --init`

Writes a starter `bouncer.config.json`. If the repository has a Prisma schema,
every model with a `tenantId` field becomes a tenant-owned model, with its
`@@map` as the table name, and `clients` is set to `["prisma"]`. The tenant column is guessed from the schema (the owner-shaped field on the most
models, so a schema built on `storeId` works too). The `doc-links`
repo URL comes from the `origin` remote. The docs had always said the model list
should be generated from the schema; now something does.

### Secrets

- The placeholder allowance reads only the credential that matched, not the
  whole line. Any line that also contained `null`, `test` or `undefined` used
  to excuse a real password on it.
- `"${DB_PASSWORD}"` and `<fill-me-in>` were never treated as placeholders at
  all, because there is no word boundary between a quote and a dollar sign. They
  are now.
- Committed `.env` files are scanned, and a credential-named variable set to a
  real-looking value is reported as `secrets/env-file-credential`. Values in
  `.env` are never quoted, so the assignment rule had never matched them.
  `.env.example`, `.env.sample` and `.env.template` are left alone.
- New prefixes: Google API keys, npm tokens, GitLab tokens, SendGrid keys, and
  `sk-ant-` alongside `sk-proj-`.
- The AWS documentation key `AKIAIOSFODNN7EXAMPLE` is no longer reported.
- `.env.example` and friends are scanned but downgraded to warnings, like test
  fixtures, so a sample `DATABASE_URL` does not block a build.

### Money

`taxRate / 100`, `discountPercent / 100` and `Number(feePct)` are rates, not
amounts, and are no longer reported. The identifier's own suffix decides.

### Migration safety

- A `DEFAULT` on the line after `NOT NULL` is now seen. The old lookahead
  stopped at the end of the line, so a safe column was reported.
- `ADD a INT DEFAULT 1, ADD b INT NOT NULL` now reports `b`. The first clause's
  default used to excuse the whole statement. Clauses are read one at a time.
- Statements that only touch a table created in the same migration are skipped.
  Every Prisma migration that creates a table and then indexes it produced two
  warnings about locks on a table with no rows.
- `DROP DEFAULT`, `DROP NOT NULL`, `DROP IDENTITY` and `DROP CONSTRAINT` are no
  longer read as dropping a column. `ALTER INDEX ... RENAME` and
  `RENAME CONSTRAINT` are no longer read as a breaking rename. A `NOT NULL`
  identity or serial column is no longer reported.
- Locally, with no `--base` given, the usual branch names are tried in order
  (`origin/main`, `origin/master`, `main`, `master`) so a first run on a laptop
  does not skip the gate over a branch nobody mentioned.

### Doc links

Links inside fenced code blocks and inline code spans are no longer read as
links. The gate reference shows a broken link as its example of what the gate
catches, and the gate reported its own example. Any README with a markdown
sample would have hit the same thing.

### Documentation

The README is a fifth of its old length and written for a first-time user:
what it checks with an example each, how to run it, what to do when it finds
something, and a short glossary. The essays it used to carry moved to
`docs/design-notes.md`. The gate reference now has a bad example and a fixed
one for every gate, and a plain "what it misses" list.

### Tests

115, up from 86. Every fix above has a test that names the mistake.


## 0.2.5 - 2026-09-03

### A GitHub Action

`action.yml` at the repository root, so a consumer writes
`uses: ajeermahmood/bouncer@v0` instead of copying the npx line and the SARIF
plumbing. It is a composite action around the npm package, not a second
implementation: the same CLI runs, with `version` pinned by the consumer.

It writes `bouncer-findings.json` and a SARIF file even when the gates fail, so
a later step can explain the failure on the PR. It exits with the CLI's own code,
so `1` (findings) and `2` (the runner could not do its job) stay distinguishable,
and it warns by name when the checkout is shallow, which is the one setup mistake
that turns the migration gate into a permanent *skipped*.

A second workflow, `.github/workflows/action.yml`, runs the action from the
checked-out tree against this repository, so a change to the action is tested by
the pull request that makes it.

## 0.2.4 - 2026-09-01

An audit release. Nothing here was reported by a user; all of it came from
reading the project against its own claims.

### The core library was invisible to the tool

`gates/lib/finding.mjs` used **raw NUL bytes** as fingerprint separators. The
runtime behaviour was correct, but the file was binary, and the runner skips
binary files. So Bouncer's own core library was never scanned by any gate, for
several releases, and nothing in the output hinted at it.

Replaced with the escape sequence for the same character, so fingerprints are
byte-identical and no existing baseline is invalidated.

### The runner failed open on anything it could not read

The deeper bug behind that one. A tracked source file that was binary, larger
than 512KB, or unreadable was silently dropped and never scanned, while the run
still reported green. That is the exact failure this project exists to argue
against, sitting in the runner.

`read()` now returns a reason instead of null, and the report names the files it
could not open, in yellow, on every run. `--json` carries them too, because a
machine consumer needs to know about a hole in the run more than a human does,
not less.

### Four runtimes, one implementation, now actually true

The gate *rules* were shared. Everything around them was not: the scope config,
the list of gates to run, the try/catch that stops a throwing gate reading as a
pass, the sort order and the response shape were copy-pasted into the Cloudflare
Worker, the Pages Function, the Railway service, the browser playground and the
benchmark.

So the project's central claim was true of the rules and unverified for the rest,
and adding one tenant-owned model would have updated one caller while leaving
four answering differently. Now in `shared/demo-config.mjs` and
`shared/demo-scan.mjs`, with `tests/demo-parity.test.mjs` asserting that no
caller imports a gate directly.

### Smaller things

- The playground received the `unavailable` array and dropped it, so the page
  showed three gates' results while implying five ran.
- `globToRe` was exported from `bin/bouncer.mjs`, which runs the whole CLI at
  import time, so it could never be tested. Moved to `gates/lib/glob.mjs` and
  covered.
- Removed a dead `redact()` export and an unused `gateByName()`.
- Fixed "1 files could not be read".
- 86 tests, up from 64. The new ones pin the classes above: no source file may be
  binary, no caller may reimplement the scan, and the shared scan must sort
  deterministically.

## 0.2.3 - 2026-09-01

- **The published npm README had nineteen broken links.** A README on the registry
  keeps its relative links verbatim, and they resolve against npmjs.com rather than
  the repository, so every `docs/gates.md` reference 404d on the package page. An
  instructive thing to discover about a tool whose job includes catching
  documentation that lies. The README now uses absolute URLs.
- **`doc-links` learned to check absolute links back into the same repository**, so
  making the README absolute did not cost the coverage. Set
  `{"doc-links": {"repoUrl": "..."}}` and links to your own repo are unwrapped and
  checked as paths. Without it they would be skipped as external, which is how a
  fix for one problem quietly creates another.
- The Railway service now returns the `unavailable` array the Worker already did,
  naming the two gates that cannot answer for a single pasted snippet. Returning
  findings from three gates and letting the caller assume five ran is the exact
  failure this project argues against, and the hosted API was doing it.
- All four runtimes are live and linked from the README, so the claim about one
  implementation running in four places is checkable rather than asserted.

## 0.2.2 - 2026-08-31

- **The install command was wrong.** Every doc said `npx bouncer`. That name
  belongs to an unrelated package already on npm at 0.0.5, so the first command in
  the README would have downloaded and run a stranger's code. Published as
  `bouncer-gates`; the binary it installs is still `bouncer`.
- **Added a Cloudflare Worker entry** (`worker/index.js` and `wrangler.toml`) so
  `/api/scan` exists on a Workers deployment. `functions/api/scan.js` is the Pages
  convention and Workers ignores it, so the first deployment served the static 404
  page for that route and the playground fell back to running in the browser. It
  worked, which is what made it hard to notice: the fallback covered the outage
  completely. The footer naming which runtime answered is the only reason this was
  visible at all.
- Corrected the homepage and `site` URL, which pointed at a `pages.dev` address
  that was never created.

## 0.2.1 - 2026-08-31

- `doc-links` no longer reports a root-absolute link with no file extension as
  broken. Found by running the gate over a Next.js site, where `[estate](/work/estate)`
  is a route the renderer resolves against the deployment rather than a file on
  disk. On GitHub the same syntax means repo-root, so the notation is genuinely
  ambiguous and only the extension separates the two readings. Requiring an
  extension keeps coverage of real repo-root document links like `/docs/guide.md`
  while dropping a false positive that would fire on every content-driven website.

## 0.2.0 - 2026-08-31

The first version was correct on its own test fixtures. This one was run against a
real 1,209 file production monorepo, and most of what follows came from reading
every finding it produced by hand.

### Precision

Blocking findings on that repository went from **45 to 13**, and all 13 remaining
were verified as genuine defects. The 32 that went away were false positives in
three families.

- **Test fixtures downgraded, not excluded.** Credential-shaped strings in
  `*.spec.*`, `*.test.*`, `__tests__/`, `fixtures/` and `e2e/` were 35% of all
  findings and every one was deliberate test data. They now report as warnings.
  Excluding those files outright would have hidden a genuinely leaked key, so they
  are still scanned. `sk_live_` stays blocking even in a test, because Stripe
  separates live from test credentials by prefix.
- **Percentages no longer read as money bugs.** `Math.round(x * 100)` is both the
  canonical currency defect and the canonical way to render a percentage.
  Suppressed by a literal `%`, by a percentage-shaped identifier, or by a division
  inside the rounded expression, since a percentage is a part over a whole and
  money conversion never divides before scaling. Only unambiguous money words
  override the last one: `total`, `net` and `gross` are ordinary counting words,
  and a progress pill was being reported as a currency defect because of one.
- **Local development credentials ignored.**
  `postgresql://postgres:postgres@localhost:5432/app` in a setup script grants
  nothing to whoever reads it.
- **Documentation domains narrowed.** `example.com` and friends are reserved by
  RFC 2606 and are placeholders by definition. `example-corp.io` is somebody's
  real company and is no longer excused by a loose word match.
- Money findings in test files downgrade to warnings, for the same reason as
  secrets.

### Correctness

- **`migration-safety` parses statements instead of lines.** A wrapped
  `ALTER TABLE / ADD COLUMN / NOT NULL` was missed entirely, which is exactly the
  case the gate exists for. Prisma emits single-line DDL, which is why it looked
  fine in testing. Statements are split on semicolons outside string literals,
  line and block comments, and dollar-quoted bodies.
- **A gate that cannot see git history now says so.** A shallow clone has no base
  ref, so no migration looks new, so the previous version printed "no new
  migrations in this change" while checking nothing at all. `skipWhen` now returns
  a reason string and the two cases read differently.
- **Unknown CLI flags exit 2** rather than being ignored. Silently accepting
  `--onyl scope` and scanning everything is how a job passes for a year while
  checking nothing intended.
- **Exit code 2** separated from 1: the runner failing to do its job is not the
  same as a codebase with problems.
- `doc-links` decodes percent-escaped paths, ignores links that climb above the
  repository root, and no longer carries regex state between files.
- New migration rules: `migration/set-not-null` and `migration/validated-fk`.
- Removed NUL bytes used as placeholder tokens in the runner's glob compiler. They
  worked, and they made the file read as binary to `grep` and to Bouncer's own
  file reader, so the tool could not scan its own runner.

### Features

- **`--baseline-write` and `bouncer.baseline.json`.** Grandfather what a codebase
  already has so a gate can be switched on without fixing two hundred things
  first. Fingerprints are content-based, not line-based, so a grandfathered
  finding survives code moving and starts blocking again the moment its line is
  edited. Stale entries are reported so the file can shrink.
- **`--changed`** scans only files that differ from the base ref. Refuses to run
  rather than guessing when the base ref is missing.
- **`--sarif`** emits SARIF 2.1.0 for GitHub code scanning.
- **`--explain <gate>`** describes a gate and how to acknowledge a case.
- **`--no-baseline`, `--no-color`, `--version`, `--help`**, and `--flag=value`
  syntax.
- `scope` reports skipped when no tenant-owned models are configured, instead of
  passing silently.

### Performance

Total scan time on that repository went from **291 ms to 73.6 ms**, a 4.0x
improvement, median of seven runs. Details and method in
[docs/performance.md](docs/performance.md).

- The acknowledgement regex was being compiled once per line per gate, roughly a
  million times on that repository. Now cached, behind a cheap substring reject.
- `scope` was building an alias matcher inside its inner loop, per alias, per
  line. Hoisted to once per alias per file. This alone is 11.3x for that gate.
- Each gate now tests a union of all its rules against the whole file, then
  against each line, before entering the per-rule loop.
- Lines are split once by the runner and shared, rather than once per gate.
- The compiled `scope` config and the `doc-links` directory set are cached, which
  matters for the hosted API and the playground rather than the CLI.
- Fixed a quadratic in the money gate.

### Documentation

- `docs/gates.md`, every rule with what it catches and what it deliberately misses
- `docs/architecture.md`, `docs/adoption.md`, `docs/performance.md`
- `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue and PR templates
- `tools/bench.mjs`, with a `--gates` flag so the performance claims above can be
  checked against an older commit rather than trusted

## 0.1.0 - 2026-08-31

First version. Five gates, a runner, a Cloudflare Pages Function, a Node service
for Railway, and an Astro site.

Two bugs found while writing it, both now regression tests:

- The placeholder allowance applied to every rule, so
  `curl https://get.example.com/install.sh | sh` was skipped because the line
  contained "example". Right for a secret, exactly backwards for a shape rule.
- The raw-SQL check read a fixed window of lines forward, so a scoped query
  cleared an unscoped one above it. It failed open.
