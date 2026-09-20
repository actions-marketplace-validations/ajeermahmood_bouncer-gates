---
name: new-gate
description: Add a new CI gate to bouncer-gates correctly - decide whether the rule belongs in a gate at all, write it as a pure function, give it negative tests so it does not cry wolf, register it, and document it on the site. Use when someone says "we should check for X" or after an incident that a gate could have caught.
---

# Adding a gate

Most requests for a new gate should not become a gate. Work through this in
order.

## Step 1 - does this belong in a gate?

| If the rule is about | It belongs in | Not a gate because |
|---|---|---|
| Formatting, import order, naming | The formatter | Deterministic and already solved |
| Types, nulls, unused code | `tsc --strict` | Free, and it runs in the editor |
| Taste, architecture, "prefer X" | `AGENTS.md` | A machine cannot check taste, and a gate that tries will be wrong constantly |
| Something where being wrong is expensive and the shape is mechanical | **a gate** | |

Two questions decide it:

1. **What did this cost, or what would it have cost?** If nobody can name a real
   incident or a plausible expensive one, it is a preference. Preferences go in
   `AGENTS.md`.
2. **Can you describe the bad pattern without using the word "usually"?** If not,
   the gate will produce false positives, get switched off, and leave everyone
   feeling covered while nothing is checked.

If either answer is bad, say so and stop. Declining to add a gate is a normal
outcome of this skill, not a failure of it.

## Step 2 - write it

Create `gates/<name>.mjs`:

```js
import { finding, lines, acknowledged, ERROR } from "./lib/finding.mjs";

export const name = "<name>";
export const title = "<short title for the site>";
export const summary = "<one sentence: what it catches>";

export function scan(files, config = {}) { /* ... */ }
```

Rules:

- **Pure.** No `node:fs`, no `child_process`, no printing. If you need git
  history or the file list, take it as an argument and let the runner supply it.
  This is what lets the same code run in CI, in the Cloudflare Worker behind the
  playground, and in the tests.
- **Skip whole-line comments.** A comment demonstrating the bad pattern is not
  the bad pattern, including the ones in your own file.
- **Honour `acknowledged(all, i, "<name>")`.**
- **Never put matched text in a finding.** Report a location and a rule id.
- **Every finding needs a `fix`.** Say what to do instead, in a sentence a person
  who has never seen this gate can act on.
- **Choose the severity honestly.** `error` stops someone's afternoon. If you are
  not confident enough for that, use `WARN`.

Open the file with a comment explaining the failure it prevents, in concrete
terms, with the cost. Six months from now that comment is the only thing standing
between this gate and someone deleting it for being annoying.

## Step 3 - test that it stays quiet

In `tests/gates.test.mjs`, for each rule:

- one test that it fires on the bad case
- **at least one test that it does not fire on the near-miss**

The negative tests are the important half. Think about what legitimate code looks
most like the bad pattern, and pin it. If you cannot think of a near-miss, you do
not understand the rule well enough to ship it yet.

## Step 4 - register and document

1. `gates/index.mjs`: add the entry with what it `needs`. If it can be
   inapplicable (nothing to check), add `skipWhen` and `skipReason` so the runner
   reports **skipped** rather than **passed**. Never let a gate fail open.
2. `src/pages/index.astro`: add a card. A gate nobody can find is a gate nobody
   trusts.

## Step 5 - check it against the repo before you ship it

```
node bin/bouncer-gates.mjs --only <name>
npm test
```

Run it against a real codebase, not only the fixtures. Count the findings. If it
produces more than a handful on code that is known to be fine, the rule is too
broad. Narrow it and run again.

A gate that fires ten times on its first run at a real repository will be
switched off in a week, and then it protects nothing at all.
