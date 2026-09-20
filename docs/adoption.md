# Rolling this out on a codebase that already has problems

The hard part of a tool like this is not the first run. It is the second month.

## Day one, in three commands

```bash
npx bouncer-gates --init             # writes bouncer-gates.config.json; reads your Prisma schema if there is one
npx bouncer-gates                    # see what it finds
npx bouncer-gates --baseline-write   # if there is existing debt, record it so only new problems block
```

Commit `bouncer-gates.config.json` and, if you wrote one, `bouncer-gates.baseline.json`.
Then add the workflow step from the README. The rest of this page is about
what happens after that.


## The problem with day one

Turn on a new gate in a mature repository and it surfaces two hundred existing
findings. Nobody is going to fix two hundred things before merging anything else,
so the realistic options are:

1. **Do not add the gate.** The rule stays a convention, and conventions decay.
2. **Add it as a warning.** Everybody learns to scroll past a wall of yellow, and
   within a month it is decoration. Worse than nothing, because the workflow file
   now says the check exists.
3. **Fix all two hundred first.** In a giant pull request, touching code nobody
   has context on, reviewed by someone who will approve it out of exhaustion.

## The baseline

```bash
npx bouncer-gates --baseline-write
git add bouncer-gates.baseline.json && git commit -m "Baseline existing findings"
```

That writes what is already wrong. Those findings stop blocking. Anything **new**
blocks from the next pull request onward.

The debt stays visible and countable, and the bleeding stops the same afternoon.
That is the whole trade: you give up on fixing history in exchange for never
adding to it.

## Why the fingerprint is not the line number

This is the detail that decides whether a baseline survives.

Keyed on line numbers, a baseline is invalidated the first time somebody adds an
import at the top of a file. Two hundred grandfathered findings reappear at once,
in a pull request that had nothing to do with any of them. The author has no idea
why, cannot fix them, and the team's conclusion is that the tool is broken. It is
switched off that week.

bouncer-gates fingerprints on **rule, path, and the normalised text of the offending
line**. So:

| What happens | Effect |
|---|---|
| Code moves up or down the file | Still grandfathered |
| The file is reformatted, indentation changes | Still grandfathered |
| **The offending line itself is edited** | **Blocks again** |
| The file is renamed | Blocks again |

That last-but-one row is the point. If you are already editing that line, you have
the context to deal with it, and it is exactly the right moment to be asked.

## Reading the baseline file

It is deliberately human-readable, because a baseline nobody can read in a pull
request is a baseline nobody ever shrinks:

```json
{
  "version": 1,
  "created": "2026-08-31",
  "count": 2,
  "entries": {
    "1a2b3c4": { "rule": "money/hardcoded-exponent", "path": "src/orders/csv.ts" },
    "5d6e7f8": { "rule": "doc-links/broken", "path": "docs/LEDGER.md" }
  }
}
```

Review it in the pull request that introduces it. `count` going up in a later
diff is a thing to ask about.

## Shrinking it

Fix a finding and the entry stops matching. bouncer-gates says so:

```
2 baseline entries are no longer found. Run --baseline-write to shrink the file.
```

Re-running `--baseline-write` drops them. It never re-adds a finding you have
fixed, because it writes what is currently found, not what was previously
recorded.

A reasonable rhythm is to shrink it whenever the message appears, and to treat the
`count` field as a number that should only ever go down.

## A suggested order for switching gates on

Not all at once. Each gate is a separate conversation with the team.

1. **`doc-links` first.** Almost always a handful of findings, always trivially
   fixable, and it gets people used to the tool being right. Start where you do
   not need a baseline at all.
2. **`secrets` next.** Nobody argues with it. Expect the test-file noise to be
   already handled as warnings.
3. **`migration-safety`.** Only fires on new migrations, so it has no history to
   grandfather. Add `fetch-depth: 0` at the same time or it silently reports
   skipped.
4. **`money`, then `scope`.** These are the ones with real existing debt, and the
   ones where the baseline earns its place.

`scope` last on purpose: it needs a configured model list, and that list should be
generated from your schema rather than typed by hand, which is a small piece of
work in itself.

## Speed on a large repository

```yaml
- run: npx bouncer-gates --changed --base origin/${{ github.base_ref }}
```

`--changed` scans only what the branch touched. On a 1,200 file repository the
full scan is around 200ms, so this is not usually about time. It is about **noise
on the pull request**: a contributor should be told about the file they touched,
not handed a report on the whole codebase.

Run the full scan on `main` and the changed-only scan on pull requests. That way
nothing rots unnoticed, and nobody is handed somebody else's debt.

## When a gate is wrong

In order of preference:

1. **Fix the gate.** If it is wrong here it is wrong elsewhere. Add the case as a
   test that asserts the gate stays quiet.
2. **Acknowledge the line**, with a real reason, if the code is genuinely a
   deliberate exception.
3. **Exclude the file**, if it is a fixture or generated. The run prints how many
   files each pattern removed, every time.

There is deliberately no way to switch a rule off across the whole repository. If
a gate needs that, it is not ready.
