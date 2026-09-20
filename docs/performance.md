# Performance

Measured, not estimated. Reproduce anything here with:

```bash
npm run bench -- /path/to/some/repo
```

## The numbers

Target: a real production monorepo. 1,209 tracked files, of which 947 are
scannable, 7.6 MB of source. Median of seven runs, scan only, on a laptop.

| Gate | Before | After | |
|---|---|---|---|
| `secrets` | 92.6 ms | 38.8 ms | 2.4x |
| `scope` | 97.3 ms | 8.6 ms | 11.3x |
| `money` | 97.0 ms | 24.3 ms | 4.0x |
| `doc-links` | 4.1 ms | 1.8 ms | 2.3x |
| **total** | **291.0 ms** | **73.6 ms** | **4.0x** |

End to end, including Node startup, reading 947 files and shelling out to git, the
CLI runs in about 200 ms on that repository.

## What the benchmark deliberately does not measure

File reads and git calls happen outside the timed region. They are the runner's
work, identical whatever the gates do, and including them would flatter or punish
a change for a reason that has nothing to do with it.

It reports the **median**, not the mean. A benchmark on a laptop competes with
whatever else the machine is doing, and one 400 ms outlier moves a mean of seven
runs by fifty milliseconds while leaving the median untouched.

It clears the per-file line cache between runs. Without that, every run after the
first measures a warm cache and reports a number the real CLI never sees.

## The three changes that did nearly all of it

None of them is clever. All three were invisible until measured.

### 1. The acknowledgement regex was compiled once per line, per gate

```js
// before: inside the per-line loop, for every gate
const pattern = new RegExp("bouncer-gates-ok\\(" + gateName + "\\)\\s*:\\s*\\S+");
```

On 947 files with three line-based gates that is roughly a million `RegExp`
constructions for a repository where the string `bouncer-gates-ok` appears zero times.

Now it is cached per gate name, behind a cheap `indexOf("bouncer-gates-ok")` reject that
skips the regex entirely for the ~99.99% of lines that cannot contain one.

### 2. The scope gate built an alias matcher inside the inner loop

This is the 11x.

```js
// before
for (const a of aliases) {
  const aliasUse = new RegExp("\\b" + a + "\\.(" + modelAlt + ")\\b");  // every line
  ...
}
```

A fresh `RegExp` per alias, per line, per file. The alias set rarely has more than
one entry, but the model alternation makes each compilation genuinely expensive,
and it was happening for every line of every source file.

Now the matcher is compiled once per alias per file, into a `Map`, at the point
the alias is declared.

### 3. A union regex per gate, tested before the per-rule loop

The overwhelming majority of lines in a codebase contain nothing interesting.
Running thirteen separate regexes over each of them to discover that is waste.

Each gate now builds one alternation of all its rules at module load, and tests it
twice: once against the whole file, so a file that cannot match is skipped without
even being split into lines, and once per line, so a line that cannot match never
enters the rule loop.

## Smaller things, in rough order of what they were worth

- **Split lines once, in the runner.** `lines(file)` caches the array on the file
  object, so three line-based gates split each file once rather than three times.
  Worth roughly a third of the remaining time.
- **Cache the compiled scope config.** Keyed on the config's values, not object
  identity, so a caller that rebuilds an equivalent object still hits it. Nothing
  for the CLI, which calls `scan` once; meaningful for the hosted API and the
  playground, which call it per request and per keystroke.
- **Cache the doc-links directory set**, in a `WeakMap` keyed on the file-list
  `Set`. Deriving it walks every path segment of every tracked file, and the CLI
  did it once, but the hosted service did it per request.
- **Fix a quadratic in the money gate.** `out.some((f) => f.path === file.path)`
  ran on every line to decide whether a soft rule should report, making the gate
  quadratic in findings-per-file. A boolean flag is the same logic in O(1).
- **Reject by path before reading.** Extension and directory checks first, so
  `node_modules`, `dist` and lockfiles never reach a regex.

## What was not done, and why

**Worker threads.** At 73 ms of scan time the startup cost of a worker pool is
larger than the work. It would make the tool slower on every repository small
enough to care about latency, to help the ones large enough not to notice.

**Incremental caching between runs.** `--changed` already solves the real case, is
simpler, and has no cache to invalidate incorrectly. A stale cache in a security
gate fails open, which is the one direction that is not acceptable here.

**Rewriting the matchers as a hand-rolled scanner.** Probably another 2x, at the
cost of every rule becoming unreadable. The rules are the product; a rule nobody
can review is worse than a rule that takes 40 ms.

## A note on measuring

Every number here was taken before and after on the same machine, in the same
session, against the same repository. The "before" figures come from running the
benchmark against the pre-optimisation commit:

```bash
git worktree add /tmp/old <commit>
npm run bench -- /path/to/repo --gates /tmp/old/gates
```

That flag exists purely so the claims in this document can be checked rather than
trusted.
