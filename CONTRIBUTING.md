# Contributing

```bash
npm install
npm test                        # unit tests
npm run check                   # bouncer-gates on itself
npm run bench -- ../some-repo   # measure against a real codebase
npm run dev                     # the site
```

Everything must be green before a pull request: `npm test`, `npm run check`, and
`npm run build`. CI runs all three.

## Adding a gate

### Step 1: decide whether it should be a gate at all

Most requests for a new gate should not become one. Put each rule in the cheapest
place that can hold it:

| Kind of rule | Where | Why not a gate |
|---|---|---|
| Formatting, import order | Formatter | Deterministic, already solved |
| Types, nulls, unused code | `tsc --strict` | Free, and it runs in the editor |
| Taste, architecture, "prefer X" | `AGENTS.md` | A machine cannot check taste, and a gate that tries will be wrong constantly |
| Wrong is expensive, and the shape is mechanical | **a gate** | |

Two questions settle it:

1. **What did this cost, or what would it have cost?** If nobody can name a real
   incident or a plausible expensive one, it is a preference. Preferences go in
   `AGENTS.md`.
2. **Can you describe the bad pattern without using the word "usually"?** If not,
   the gate will produce false positives, get switched off, and leave everyone
   feeling covered while nothing is checked.

Declining to add a gate is a normal outcome, not a failure.

### Step 2: write it

Create `gates/<name>.mjs`:

```js
import { finding, lines, acknowledged, isCommentLine, ERROR } from "./lib/finding.mjs";

export const name = "<name>";
export const title = "<short title, shown on the site>";
export const summary = "<one sentence: what it catches>";

export function scan(files, config = {}) { /* ... */ }
```

Rules, all of them enforced by review:

- **Pure.** No `node:fs`, no `child_process`, no `process.env`, no printing. If you
  need git history or the repository file list, take it as an argument and let the
  runner supply it. This is what lets the same module run in CI, in a Cloudflare
  Worker, on Railway and in a browser tab.
- **No dependencies.** `gates/` must run with nothing installed.
- **Skip whole-line comments** with `isCommentLine`. A comment demonstrating the
  bad pattern is not the bad pattern, including the ones in your own file. Every
  gate here has flagged its own documentation at least once.
- **Honour `acknowledged(all, i, "<name>")`.**
- **Never put matched text in a finding.** Report a location and a rule id.
- **Every finding needs a `fix`** that somebody who has never seen this gate can
  act on.
- **Choose severity honestly.** `error` stops someone's afternoon. If you are not
  confident enough for that, use `WARN`.

Open the file with a comment explaining the failure it prevents, concretely, with
the cost. In six months that comment is the only thing standing between the gate
and somebody deleting it for being annoying.

### Step 3: test that it stays quiet

In `tests/gates.test.mjs`, for each rule:

- one test that it fires on the bad case
- **at least one test that it does not fire on the near-miss**

The negative tests are the important half. Think about what legitimate code looks
most like the bad pattern and pin it. If you cannot think of a near-miss, you do
not understand the rule well enough to ship it yet.

When you find a false positive in the wild, add it as a test **named for what it
was**, so the next person knows it was a real mistake and not a hypothetical. See
the existing ones about percentages and local development credentials.

### Step 4: register it

`gates/index.mjs`, with what it `needs`. If it can be inapplicable, add
`skipWhen` returning a **reason string**:

```js
skipWhen: (ctx) => (ctx.addedSql.length === 0 ? "no new migrations in this change" : null)
```

Never let a gate fail open. "We looked and found nothing" and "we could not look"
must not print the same message.

### Step 5: check it against a real codebase

```bash
node bin/bouncer-gates.mjs --only <name> --root ../some-real-repo
npm test
```

Count the findings and read every one. If it produces more than a handful on code
that is known to be fine, the rule is too broad. Narrow it and run again.

A gate that fires ten times on its first run at a real repository will be switched
off within a week, and then it protects nothing.

### Step 6: document it

Add a section to [`docs/gates.md`](docs/gates.md) with a rule table and a **"what
it misses"** part. Every gate here has blind spots and stating them is the
specification, not an apology. Add a card to `src/pages/index.astro` if it is not
picked up automatically.

## Style

- ES modules, `.mjs` for anything Node runs directly.
- No em dashes in prose or comments.
- Comments explain **why**, not what. The what is in the code.
- Plain SCSS in the site, no framework.

## Things that will waste your time

- **Windows checkouts.** `git ls-files` returns forward slashes, `path.join` does
  not. Normalise with `.replace(/\\/g, "/")` before comparing paths. An early
  version of `doc-links` passed on Windows and silently checked almost nothing on
  Linux.
- **Control characters in source.** An early `globToRe` used NUL as a placeholder
  token. It worked, and it made the file read as binary to `grep` and to bouncer-gates's
  own file reader, so the tool could not scan its own runner.
- **`npm ci` needs `package-lock.json` committed.** It is.

## Reporting a false positive

Open an issue with the smallest snippet that reproduces it and what the code
actually does. That is the most useful contribution to this project, more than a
new gate: precision is what decides whether any of this survives contact with a
real team.
