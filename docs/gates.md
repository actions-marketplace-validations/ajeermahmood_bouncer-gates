# Gate reference

Every rule: what it catches, a bad example and a fixed one, what it deliberately
does not catch, and how to excuse a case it gets wrong.

One thing applies to all of them. These are **pattern matches, not proofs**.
Each section has a "what it misses" part. Those are not apologies, they are the
specification. A tool that claims to catch everything teaches people to stop
reading, and then the one it missed ships.

Excusing a line is the same everywhere: a comment on the line or the line above
it, with a reason. A bare marker does nothing.

```js
// bouncer-gates-ok(<gate>): why this is fine here
```

---

## secrets

**Passwords, keys and tokens committed to the repository, plus a few shapes that
are risky no matter where they point.**

### Bad, then fixed

```js
// reported
const stripe = new Stripe("sk_live_...");
const db = "postgres://app:Hunter2Hunter2@db.acme-corp.io/app";

// fixed
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const db = process.env.DATABASE_URL;
```

```dotenv
# .env committed to git: reported
DB_PASSWORD=Hunter2Hunter2!

# .env.example committed instead: fine
DB_PASSWORD=change-me
```

### Rules

| Rule | Fires on |
|---|---|
| `secrets/private-key` | A `-----BEGIN ... PRIVATE KEY-----` header |
| `secrets/aws-access-key` | `AKIA` or `ASIA` followed by 16 uppercase alphanumerics |
| `secrets/github-token` | `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` plus 36 or more characters |
| `secrets/gitlab-token` | `glpat-` plus 20 or more characters |
| `secrets/slack-token` | `xoxb-`, `xoxa-`, `xoxp-`, `xoxr-`, `xoxs-` |
| `secrets/stripe-key` | `sk_live_` or `rk_live_` |
| `secrets/openai-key` | `sk-`, `sk-proj-` or `sk-ant-` plus 32 or more characters |
| `secrets/google-api-key` | `AIza` plus 35 characters |
| `secrets/npm-token` | `npm_` plus 36 characters |
| `secrets/sendgrid-key` | `SG.` followed by the two SendGrid segments |
| `secrets/connection-string` | A database URL with a password in it |
| `secrets/assigned-credential` | `password`, `secret`, `api_key`, `access_token` or `client_secret` assigned a quoted value of 8 or more characters |
| `secrets/env-file-credential` | In a committed `.env` file, a variable named like a credential set to a real-looking value |

### Risky shapes

These are not secrets. They are code that reads like an attack, and a
repository containing them gets treated with suspicion by reviewers and by AI
coding agents alike. On a real team, agents kept refusing to work in files that
were completely benign because the surrounding code looked like this. Keeping
the shape clean fixed it.

| Rule | Fires on | Severity |
|---|---|---|
| `shape/pipe-to-shell` | `curl` or `wget` piped into a shell | error |
| `shape/tls-disabled` | `rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`, `verify=False`, `InsecureSkipVerify: true`, `curl -k` | error |
| `shape/host-key-bypass` | `StrictHostKeyChecking=no`, `UserKnownHostsFile=/dev/null` | error |
| `shape/decoded-payload` | A base64 blob decoded into `eval`, `exec` or a privileged path | warn |
| `shape/chmod-777` | `chmod 777` | warn |

### What it will not report

- **A value that is obviously a placeholder.** `your-api-key-here`, `changeme`,
  `<REPLACE_ME>`, `${DB_PASSWORD}`, `process.env.X`, the AWS documentation key
  `AKIAIOSFODNN7EXAMPLE`, and a host on a reserved documentation domain such as
  `example.com`. Only the credential itself is judged, not the rest of the line,
  so a real password next to the word `null` is still reported.
- **A credential pointing at a local host.** `postgres://postgres:postgres@localhost:5432/app`
  grants nothing to whoever reads it.
- **`.env.example`, `.env.sample`, `.env.template`.** Those files exist to hold
  placeholders.
- **Anything in a test file, at error severity.** Findings in `*.spec.*`,
  `*.test.*`, `__tests__/`, `fixtures/` and `e2e/` become warnings, so a real key
  pasted into a test is still visible without blocking on fixture data.
  **`sk_live_` stays blocking**, because Stripe separates live from test keys by
  prefix and a live key is never plausible test data.

### What it misses

- A secret split across lines or built from pieces.
- A high-entropy string with no recognisable prefix. Entropy scanning produces
  more noise than it is worth at this size. For that, and for scanning git
  history, use gitleaks or trufflehog.

### Excusing a case

```js
const url = "postgres://u:p@db.acme-corp.io/x"; // bouncer-gates-ok(secrets): documented sample, credentials revoked
```

---

## scope

**Queries on multi-tenant tables that are not limited to one tenant.**

The bug: one customer can read or write another customer's rows. It is the worst
bug a SaaS product can ship, it is silent, and care alone does not prevent it,
because preventing it means every developer remembering it on every query
forever.

There are two ways to run this gate, depending on what your codebase has.

### Mode 1: you use the database client directly

Most codebases. List the client names under `clients` and every list-style query
on a tenant-owned model must mention the tenant column somewhere in the call.

```json
{
  "scope": {
    "models": ["order", "customer"],
    "tables": ["orders", "customers"],
    "column": "tenantId",
    "clients": ["prisma"]
  }
}
```

```ts
// reported: nothing in the call mentions tenantId
const rows = await prisma.order.findMany({ where: { status: "paid" } });

// fine
const rows = await prisma.order.findMany({ where: { tenantId, status: "paid" } });

// also fine: the filter is built by something named for the tenant
const rows = await prisma.order.findMany({ where: tenantWhere(req) });
```

`bouncer-gates --init` fills in `models` and `tables` from every model in your Prisma
schema that has a `tenantId` field, and sets `clients` to `["prisma"]`.

### Mode 2: you have a scoped client

The stronger setup. A wrapper injects the tenant filter so ordinary code cannot
forget it, and the raw client is reachable only by name. Set `rawAccessor` to
that name and leave `clients` empty. The gate then flags every place code
reaches around the wrapper.

```ts
db.forTenant(id).order.findMany()      // safe, the wrapper adds the filter
db.raw.order.findMany()                // reported: reaches around it
const c = db.raw; c.order.findMany()   // reported: same thing through an alias
db.$queryRaw`SELECT * FROM orders`     // reported: raw SQL with no tenantId
```

### Rules

| Rule | Fires on | Mode |
|---|---|---|
| `scope/unscoped-query` | `<client>.<tenantModel>.findMany(...)` and friends with no tenant column anywhere in the call | 1 |
| `scope/raw-client` | `<rawAccessor>.<tenantModel>` | 2 |
| `scope/raw-alias` | The same, through a local alias | 2 |
| `scope/raw-sql` | `$queryRaw` and friends touching a tenant-owned table with no tenant column in the statement | both |

The query methods checked in mode 1 are `findMany`, `findFirst`,
`findFirstOrThrow`, `updateMany`, `deleteMany`, `count`, `aggregate` and
`groupBy`. Override the list with `queryMethods`. Raw SQL calls are
`$queryRaw`, `$queryRawUnsafe`, `$executeRaw` and `$executeRawUnsafe`; override
with `rawSqlCalls`.

With no models and no tables configured the gate reports **skipped**, not passed.

### What it misses

- **Single-row lookups.** `findUnique({ where: { id } })`, `update` and `delete`
  address one row by its own id. They are left to review, because one finding per
  lookup would be noise rather than signal. This is where a real leak can still
  hide.
- **Interactive transactions.** `prisma.$transaction(async (tx) => ...)` hands you
  a client in a variable the gate cannot follow.
- **A filter it cannot see.** Mode 1 accepts any identifier containing `tenant`
  as evidence of scoping. A helper called `scopedWhere()` is invisible to it and
  gets reported; excuse the line, or rename the helper.
- **A tenant-owned model nobody listed.** Generate the list from the schema with
  `--init`, and re-run it when the schema changes.
- **Whether a `bouncer-gates-ok(scope)` reason is still true** months later.

The raw-SQL check reads one statement, bounded by paren balance and capped at 40
lines. It does not read forward into the next statement: an earlier version did,
found the *following* query's `tenantId`, and cleared an unscoped query because
the line below it happened to be correct.

---

## money

**Currency handled as floats, and the hardcoded 100.**

```js
Math.round(parseFloat(input) * 100)
```

This is how most codebases turn `"12.34"` into cents. It is wrong twice.

1. **Floats.** `10.005` cannot be represented exactly, so it is stored slightly
   below, and `Math.round` gives `1000` instead of `1001`. The customer is charged
   a cent less, the ledger disagrees with the payment provider, and it happens
   rarely enough that nobody reproduces it for months.
2. **The 100.** It assumes two decimal places. Japanese yen has none, so a JPY
   amount comes out 100x too large. Bahraini dinar has three, so it comes out 10x
   too small.

### Bad, then fixed

```ts
// reported
const minor = Math.round(parseFloat(input) * 100);
const display = totalAmount / 100;

// fixed: never let a float touch money, and get the exponent from the currency
const minor = parseDecimalToMinor(input, currency);   // "12.34" -> 1234 with no float in between
const display = formatMinor(totalAmount, currency);
```

### Rules

| Rule | Fires on |
|---|---|
| `money/float-to-minor` | `Math.round(... * 100)` outside a percentage context |
| `money/hardcoded-exponent` | A money-named value multiplied or divided by a literal `100` |
| `money/float-parse` | `parseFloat` or `Number` applied to a money-named value |
| `money/float-accumulate` | `+=` on a money-named value, only in a file that already has one of the above |

Money-named means the identifier contains a word like `amount`, `price`,
`total`, `fee`, `tax`, `discount`, `refund`, `cents` or `minor`.

### What it will not report

- **Percentages.** `Math.round((done / total) * 100)`, anything rendered next to a
  `%`, and identifiers like `pct`, `ratio`, `scale`, `progress`, `opacity`.
- **Rates.** `taxRate / 100`, `discountPercent / 100`, `Number(feePct)`. The
  identifier contains a money word but its suffix says it is a rate.
- **Comments** describing the bug.
- **Test files** at error severity. A money bug in an assertion is arithmetic,
  not a charge to a customer, so it is a warning there.

### What it misses

- Only JavaScript and TypeScript are read.
- A float that reaches money through a variable with an innocent name.
- Arithmetic in a template or a spreadsheet formula.

---

## migration-safety

**Schema changes that break the version of the app still running during a
deploy.**

Almost every pipeline migrates first and swaps the application second:

```
migrate  ->  build  ->  restart
```

Between the first step and the last, the **previous** version of your app is
talking to the **new** database. On a good day that window is ninety seconds. If
the build fails, it is however long it takes someone to notice.

So the question is not "does the new code work with this schema". It is "does the
old code survive this schema".

### Bad, then fixed

```sql
-- reported: the running app still selects total
ALTER TABLE orders DROP COLUMN total;

-- fixed: two releases. Stop reading the column, ship, then drop it.
```

```sql
-- reported: every insert from the old app fails, it does not know this column
ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL;

-- fixed: add it with a default, backfill, tighten later
ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'USD';
```

### Rules

| Rule | Fires on | Severity |
|---|---|---|
| `migration/drop-table` | `DROP TABLE` | error |
| `migration/drop-column` | `DROP COLUMN x`, or the bare `DROP x` inside `ALTER TABLE` | error |
| `migration/rename` | `RENAME TO` or `RENAME COLUMN` inside `ALTER TABLE` | error |
| `migration/add-not-null` | An added column that is `NOT NULL` with no `DEFAULT`, checked one clause at a time | error |
| `migration/set-not-null` | `ALTER COLUMN ... SET NOT NULL` on an existing column | error |
| `migration/type-narrowing` | `ALTER COLUMN ... TYPE VARCHAR(n)` | warn |
| `migration/blocking-index` | `CREATE INDEX` without `CONCURRENTLY` | warn |
| `migration/validated-fk` | `ADD CONSTRAINT ... FOREIGN KEY` or `CHECK` without `NOT VALID` | warn |

The fix is always the same shape, and it is called **expand-contract**: add the
new thing, deploy code that writes both, backfill, deploy code that reads the new
one, and only then, in a later release, remove the old thing. Two deploys where
you wanted one. That is the price.

### What it will not report

- **A table this migration creates.** Indexing, constraining or adding columns to
  a table that did not exist before this migration cannot break anything, because
  the old app has never heard of it. Prisma migrations do this constantly.
- **`DROP DEFAULT`, `DROP NOT NULL`, `DROP IDENTITY`, `DROP CONSTRAINT`.** None
  removes a column, and the first two are exactly what a careful migration does.
- **Renaming an index or a constraint.** The old app cannot see either.
- **An identity or serial column that is `NOT NULL`.** It fills itself in.
- **Migrations already applied.** Only `.sql` files **added** relative to the base
  branch are read.

### Only new migrations, and what that needs

Reading only added files needs git history. In CI that means `fetch-depth: 0` on
the checkout. Without it the gate reports:

```
skip  migration-safety (cannot see history: the base ref "origin/main" is not in
      this clone, so no migration can be identified as new)
```

That is different from "no new migrations in this change", and an earlier version
printed the reassuring one when it meant the other. Locally, if you did not pass
`--base`, the usual names are tried in order: `origin/main`, `origin/master`,
`main`, `master`.

### What it misses

- Migrations written in JavaScript or TypeScript (Knex, TypeORM, Drizzle in TS).
- A `DROP COLUMN` on a table the app has genuinely stopped reading. The gate
  cannot know that; the file-level comment below is how you tell it.

### Excusing a migration

Per file, because a migration is one unit of intent:

```sql
-- bouncer-gates-ok(migration): add_referrals never reached production
DROP TABLE referrals;
```

---

## doc-links

**Markdown links to files that do not exist.**

The cheapest gate, and it earns its place because of what happens when an AI
coding agent reads a repository. A human who hits a dead link shrugs and greps.
An agent follows it, finds nothing, and then either invents what the document
probably said or spends a long time hunting. Docs that lie are a correctness
problem now, not a tidiness one.

### Bad, then fixed

```markdown
<!-- reported: docs/setup.md was renamed -->
See [the setup guide](docs/setup.md).

<!-- fixed -->
See [the setup guide](docs/getting-started.md).
```

### What it skips

- Anything inside a fenced code block or an inline code span. That is where a
  document shows a link as an example, like the ones on this page.
- External links, `mailto:`, bare `#anchors`, and images
- The anchor part of `guide.md#setup`. Whether the heading exists is a different
  and much noisier check.
- Links that climb above the repository root, which a monorepo doc pointing at a
  sibling package legitimately does
- A root-absolute link with no file extension, like `/work/estate`, which on a
  website is a route rather than a file

Percent-escaped paths are decoded before checking.

### Links back into your own repository

Set `repoUrl` and absolute links to your own repo are checked as paths too:

```json
{ "doc-links": { "repoUrl": "https://github.com/you/yourrepo" } }
```

This exists because of npm. A README published to the registry keeps its
relative links, and they resolve against npmjs.com, where they all 404. Writing
them as absolute GitHub URLs fixes npm and would normally cost the check, since
absolute links are skipped as external. Recognising your own repository keeps
both. `--init` sets this from your `origin` remote.
