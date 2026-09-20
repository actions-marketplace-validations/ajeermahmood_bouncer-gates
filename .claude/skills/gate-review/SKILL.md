---
name: gate-review
description: Review a change for the things the automated gates structurally cannot see - whether a bouncer-gates-ok reason is still true, tenant scoping inside interactive transactions, new tenant-owned models missing from the config, and whether a migration is genuinely backward compatible. Use before merging any change that touches the database, money, or authentication.
---

# Gate review

The gates in `gates/` are mechanical. They match shapes. This skill is the part
that needs a reader who understands intent, and it exists because the honest
answer to "do your gates catch everything" is no, and the useful follow-up is
"here is exactly what they miss."

Run this on a change **after** `node bin/bouncer-gates.mjs` is green. A green run is
necessary, not sufficient.

## Step 1 - run the mechanical gates first

```
node bin/bouncer-gates.mjs --base origin/main
```

If it fails, stop. Fix those first. There is no point reasoning about subtle
cases while an obvious one is still open.

## Step 2 - the four blind spots

Read the diff and answer each of these explicitly. Do not skip one because it
"looks fine"; say why it is fine.

### 1. Every `bouncer-gates-ok` in the diff, and every one the diff touches

For each acknowledgement:

- Is the stated reason still true **today**?
- Does the code it excuses still do what the reason describes?

The failure mode is an acknowledgement written when a function did one thing,
still sitting there after the function was rewritten to do another. The comment
is now a lie that suppresses a real finding. Treat a `bouncer-gates-ok` whose
surrounding code has changed as unacknowledged until you have re-justified it.

### 2. Interactive transactions

```js
await db.$transaction(async (tx) => {
  await tx.order.updateMany({ ... })   // is tx scoped?
})
```

The scope gate cannot follow `tx`. It is bound inside a callback and the static
check gives up. So read every transaction body in the diff and confirm the client
it hands you is the scoped one. This is the single most likely place for a real
cross-tenant leak to survive a green build.

### 3. New models that nobody registered

Look for new tables or models in the diff that carry a tenant column. Are they in
`bouncer-gates.config.json` under `scope.models` and `scope.tables`?

If not, the scope gate silently does not check them. It does not warn, because it
has no way to know they exist. This is the config's weakest point and it is why
generating that list from the schema beats maintaining it by hand.

### 4. Migrations, for real

The migration gate reads statements. You should read intent:

- Does the **currently deployed** version of the app still work against this
  schema, for the whole window between migrate and restart?
- If the build fails halfway and that window becomes six hours, is it still fine?
- Is there a backfill, and does it hold a lock long enough to matter on the real
  row count rather than the row count in your dev database?

## Step 3 - report

For each of the four, one of:

- **clear** with a sentence saying why
- **finding**, with file, line, what breaks, and what to do instead

Then a verdict: safe to merge, or not.

Do not pad the report. If all four are clear, say so in four lines. A review that
manufactures concerns to look thorough trains people to skim reviews.

## What not to do

- Do not re-report what `bin/bouncer-gates.mjs` already found. That is noise.
- Do not review style, naming, or structure here. That is a different job and
  mixing them buries the one finding that mattered.
- Do not approve a change because the tests pass. None of the four blind spots
  above have tests, which is precisely why they are on this list.
