# Design notes

The reasoning behind the decisions that are easy to undo by accident. The README
stays short so a new user can get running; this is where the arguments live.

## The problem it answers

More people can write code now than a year ago. A designer can produce a working
page. A support lead can fix their own copy. An agent can open twenty pull
requests before lunch.

Review did not get faster. So the bottleneck moved: it is no longer writing the
change, it is being confident the change is safe.

There are two usual answers and both are bad. Review harder, which does not scale
and puts the whole safety system inside one tired person's attention. Or restrict
contribution to the people who already know where the mines are, which throws
away most of what just became possible.

Gates are the third answer. Write the expensive mistakes down once, as code, and
let the machine check every change forever. A contributor then does not need to
know that `orders` is tenant-scoped or that a float cannot hold money. They will
be told, by name, on the line, with what to do instead.

## Four decisions worth stealing even if you never run this

**A gate never fails open.** If it cannot do its job, no git history, a missing
config, it reports *skipped* and says why. It does not return an empty array and
let the build go green. "We looked and it was fine" and "we could not look" are
different answers and only one is safe to merge on. This is the single most
important line in the repo, and getting it wrong is subtle: a shallow CI clone has
no base ref, so no migration looks new, so an early version printed the
reassuring "no new migrations in this change" while checking nothing at all.

**Findings never quote what they matched.** A secret scanner that prints what it
found writes the secret into the CI log, which is usually more public than the
file it came from. So a finding carries a location and a rule id, and a human
opens the file. A deliberate usability cost, paid on purpose.

**Gates are pure functions.** A gate takes `{path, text}[]` and returns findings.
No filesystem, no git, no printing; all input gathering lives in the runner. That
is not tidiness. It is why the same modules run in four places with no duplicated
rule logic, and all four are live so you can check rather than take my word:

| Runtime | Where | Check it |
|---|---|---|
| Node CLI | [`bin/bouncer-gates.mjs`](../bin/bouncer-gates.mjs) | `npx bouncer-gates --version` |
| Cloudflare Worker | [`worker/index.js`](../worker/index.js) | [POST /api/scan](https://bouncer-gates.ajeermdk001.workers.dev) |
| Node on Railway | [`server/index.mjs`](../server/index.mjs) | [GET /health](https://bouncer-production-9470.up.railway.app/health) |
| Browser | [`Playground.tsx`](../src/components/Playground.tsx) | the playground, offline |

A gate needing git history takes the history as an argument.

**Half the tests assert that gates stay quiet.** Catching the bad case is easy.
Not firing on the twenty near-misses around it is the difference between a gate
people keep and one that gets switched off in a month.

## The escape hatch

Every gate honours a comment on the offending line or the line above it:

```js
// bouncer-gates-ok(scope): finance dashboard, spans all tenants by design
return db.raw.order.aggregate({ _sum: { totalMinor: true } });
```

**The reason is required.** A bare `bouncer-gates-ok(scope):` suppresses nothing.

That one requirement is the whole design. The hatch has to be easy, or people
route around the gate entirely and you lose the signal. It has to be impossible to
use silently, or it decays into a blanket ignore within a quarter. Requiring a
reason gets both, and it puts the justification in the file where the next reader
finds it rather than in a pull request nobody will open again.

There is deliberately no config option to disable a gate across the repository. If
a gate is wrong often enough to need one, the gate is wrong. File-level exclusions
do exist, and the runner prints how many files each pattern removed on every run,
because an exclude list that quietly grows to cover half the codebase is the most
likely way a setup like this rots.

## Precision: the first pass

Speed is easy. Not crying wolf is the hard part, and it is what decides whether a
gate survives its first month.

Run over a real 1,209 file production monorepo, an early build reported **45
blocking findings**. Every one was read by hand. **32 were false positives**, and
they came in three families:

- **Test fixtures.** Credential-shaped strings inside `.spec.ts` files were 35% of
  all findings and every one was deliberate test data. These now downgrade to
  warnings rather than being excluded, so a genuinely leaked key stays visible.
  A live Stripe key stays blocking even in a test, because Stripe separates live
  from test credentials by prefix and `sk_live_` is not plausible fixture data.
- **Percentages.** `Math.round(x * 100)` is both the canonical money bug and the
  canonical way to render a percentage. Progress bars, histogram bins and aspect
  ratio trims were all reported as currency defects.
- **Local development credentials.** `postgresql://postgres:postgres@localhost:5432/app`
  in a setup script's help text. It grants nothing to whoever reads it.

After fixing those the same repository reports **13 blocking findings, and all 13
are real**: four money conversions that break for zero-decimal currencies, four
float parses of currency values, and five documentation links pointing at a file
that no longer exists.

Every one of those false positives is now a named test asserting the gate stays
quiet. Those are the most valuable tests in the suite, because each is a mistake
this tool actually made.

## Precision: the second pass

Version 0.3.0 came from reading each gate against inputs it had never been shown,
rather than from a repository. The families this time:

- **Rates that contain a money word.** `taxRate / 100` and
  `discountPercent / 100` are on the checkout page of every shop, and both were
  reported as currency bugs because `tax` and `discount` are money words. The
  identifier's own suffix now settles it.
- **Migrations that only touch a table they create.** A Prisma migration that
  creates a table and then indexes it produced two warnings about locks on a
  table with no rows and no readers. Statements on a table created in the same
  file are skipped.
- **`DROP DEFAULT` read as dropping a column**, `ALTER INDEX ... RENAME` read as
  renaming a table, and a `DEFAULT` on the line after `NOT NULL` not being seen
  at all, so a safe column was reported and an unsafe one hidden behind a
  neighbouring clause's default. The add-not-null rule now reads one clause at
  a time.
- **The placeholder allowance read the whole line.** Any line that also contained
  `null`, `test` or `undefined` excused a real password on it. The allowance now
  reads only the credential that matched. The same pass found that
  `"${DB_PASSWORD}"` and `<fill-me-in>` had never been excused at all, because
  there is no word boundary between a quote and a dollar sign.

And two things it did not check that it should have: values in a committed
`.env` file, which are never quoted so the assignment rule never matched, and
plain Prisma queries in a codebase that has no scoped client yet, which was the
most common shape of codebase and the one the gate could not see.

## Two bugs worth reading about

Both are in the code as comments, because in six months those comments are the
only thing standing between a gate and someone deleting it for being annoying.

**The placeholder allowance applied to every rule.** So
`curl https://get.example.com/install.sh | sh` sailed straight through: the line
contains "example", and the check assumed anything mentioning "example" was
documentation. For a *secret* that reasoning is right, a fake key is harmless. For
a *shape* rule it is exactly backwards, because piping a download into a shell is
dangerous regardless of where it points.

**The raw-SQL check read a fixed window of lines forward.** Given an unscoped
query followed by a scoped one, it found the second query's `tenantId` and cleared
the first. A cross-tenant leak excused because the line below it happened to be
correct. It now stops at the end of the statement. It failed open, which is the
only direction that actually hurts.

## How fast

Measured on a real 1,209 file production monorepo, 947 scannable files, 7.6 MB of
source. Median of seven runs, scan only, on a laptop:

| Gate | Before optimisation | After | |
|---|---|---|---|
| `secrets` | 92.6 ms | 38.8 ms | 2.4x |
| `scope` | 97.3 ms | 8.6 ms | 11.3x |
| `money` | 97.0 ms | 24.3 ms | 4.0x |
| `doc-links` | 4.1 ms | 1.8 ms | 2.3x |
| **total** | **291.0 ms** | **73.6 ms** | **4.0x** |

Reproduce with `npm run bench -- /path/to/repo`.

Three changes did nearly all of it, and none was clever. A union regex tested per
line so most lines skip the per-rule loop; the acknowledgement regex cached
instead of recompiled once per line per gate; and the scope gate's alias matcher
hoisted out of the inner loop, where it was building a `RegExp` per alias per
line. That last one is the 11x. [Details](performance.md).

## Where a rule belongs

Not everything belongs in a gate. Put each rule in the cheapest place that can
hold it:

| Kind of rule | Where | Why |
|---|---|---|
| Formatting, import order | Formatter | Deterministic, already solved |
| Types, null safety | Compiler, strict mode | Free, and it runs in the editor |
| Taste, context, intent | `AGENTS.md` | A machine cannot check taste |
| Wrong is expensive | **A gate** | Only this category actually holds |

A rule in an instructions file that you would be upset to find broken in
production is in the wrong place.
