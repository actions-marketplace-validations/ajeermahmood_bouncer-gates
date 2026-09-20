# bouncer-gates

**Five checks that stop the expensive mistakes before they merge, whether a
person or an agent wrote the code.**

Hardcoded secrets. Database queries that leak one customer's data to another.
Float maths on money. Migrations that break the running app. Docs that link to
files which no longer exist.

Agents write most new code now, and they make exactly these mistakes: a key
pasted in to make a test pass, a query with no tenant filter because the prompt
never mentioned tenants. bouncer-gates runs inside Claude Code and Cursor, so the
agent hears about it in the same turn it wrote it, and again in CI so nothing
gets through.

Try it on any repository in ten seconds:

```bash
npx bouncer-gates
```

Or paste some code into the [playground](https://bouncer-gates.ajeermdk001.workers.dev)
and watch the same checks run on it.

---

## Quick start

```bash
npx bouncer-gates --init          # writes bouncer-gates.config.json, reads your Prisma schema if you have one
npx bouncer-gates --init-agents   # wires the same checks into Claude Code and Cursor for this repo
npx bouncer-gates                 # runs every check and prints what it found
```

Add it to GitHub Actions:

```yaml
steps:
  - uses: actions/checkout@v4
    with:
      fetch-depth: 0             # needed so the migration check can see what is new
  - uses: ajeermahmood/bouncer-gates@v0
    with:
      version: "0.5.0"
```

That is the whole setup. Everything below is detail.

## In the editor, with the agent

`--init-agents` commits two things into the repository: an MCP server the agent
can call, and a hook that scans every file the agent writes. When a file has a
blocking finding, the agent sees the file, the line, what is wrong and what to
do instead, in the same turn:

```
x src/orders.ts:12  scope/unscoped-query
  "order" is tenant-owned, but nothing in this query mentions "tenantId", so it returns rows from every tenant.
  fix: Add tenantId to the where clause, or go through a tenant-scoped client.
```

Any other MCP client can run `npx -y bouncer-gates --mcp`, and any post-edit
hook can pipe its event to `npx -y bouncer-gates --hook`.
[How it works, and what it will not do](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/agents.md).

## What it checks

| Check | Catches | Example of what it stops |
|---|---|---|
| **secrets** | Passwords, API keys and private keys committed to the repo, plus a few risky shapes like `curl ... \| sh` | `const apiKey = "sk_live_..."`, a committed `.env` with a real password |
| **scope** | Queries on multi-tenant tables that are not limited to one tenant | `prisma.order.findMany({ where: { status: "paid" } })` with no `tenantId` |
| **money** | Currency handled as floats, or `* 100` assuming every currency has two decimals | `Math.round(parseFloat(price) * 100)` |
| **migration-safety** | SQL migrations that break the version of the app still running during a deploy | `ALTER TABLE orders DROP COLUMN total` while old code still reads it |
| **doc-links** | Markdown links to files that do not exist | `[setup](docs/setup.md)` after the file moved |

Each check exists because of a real, expensive bug. None is a style opinion.
The [gate reference](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/gates.md)
explains every rule with a bad example and a fixed one.

## When it finds something

Every finding names the file, the line, what is wrong and what to do instead:

```
  FAIL  scope

    x src/orders.ts:2  scope/unscoped-query
      "order" is tenant-owned, but nothing in this query mentions "tenantId", so it returns rows from every tenant.
      fix: Add tenantId to the where clause, or go through a tenant-scoped client.
```

You have three options, in this order:

1. **Fix it.** Usually the right answer.
2. **Explain why it is fine.** Put a comment on the line, or the line above it,
   with a reason. The reason is required; a bare marker does nothing.
   ```js
   // bouncer-gates-ok(scope): nightly revenue report spans every tenant by design
   const all = await prisma.order.findMany();
   ```
3. **Record existing problems so only new ones block.** On a codebase that
   already has findings, run this once and commit the file it writes:
   ```bash
   npx bouncer-gates --baseline-write
   ```
   Old findings stop blocking. Anything new still does. The file is readable,
   and the count in it should only ever go down.

## Configuration

`bouncer-gates --init` writes this for you. Edit it by hand any time.

```json
{
  "exclude": ["fixtures/**"],
  "scope": {
    "models": ["order", "customer"],
    "tables": ["orders", "customers"],
    "column": "tenantId",
    "clients": ["prisma"],
    "rawAccessor": "raw"
  },
  "doc-links": { "repoUrl": "https://github.com/you/your-repo" }
}
```

- **exclude**: files not to scan at all. The run prints how many files each
  pattern removed, every time, so the list cannot grow quietly.
- **scope.models / tables**: the models and tables that belong to a tenant.
  `--init` fills these from any model in your Prisma schema that has a
  `tenantId` field.
- **scope.clients**: plain client names, like `prisma`, whose queries should be
  checked for the tenant column. Use this when you do not have a scoped wrapper.
- **scope.rawAccessor**: if you *do* have a scoped wrapper, this is the name of
  the raw client it hides, like `db.raw`. Reaching for it gets flagged.
- **doc-links.repoUrl**: lets absolute links back to your own repository be
  checked as file paths too.

Without a scope section, the scope check reports **skipped**, not passed.

## All the commands

```bash
npx bouncer-gates                        # every check, whole repository
npx bouncer-gates --init                 # write a starter config
npx bouncer-gates --init-agents          # wire the gates into Claude Code and Cursor
npx bouncer-gates --mcp                  # serve the gates over MCP, for any agentic editor
npx bouncer-gates --hook                 # scan the file named by a hook event on stdin
npx bouncer-gates --changed              # only files this branch touched
npx bouncer-gates --only scope,money     # just some checks
npx bouncer-gates --explain scope        # what a check does and how to excuse a case
npx bouncer-gates --baseline-write       # record existing findings
npx bouncer-gates --json                 # machine-readable output
npx bouncer-gates --sarif                # for the GitHub Security tab
```

Exit code `0` means clean, `1` means something blocked, `2` means the tool
itself could not run (bad flag, broken config, not a git repository). CI treats
`1` and `2` differently on purpose: a broken tool should not look like a
codebase full of problems.

## What it does not do

Honest limits, so nobody trusts it further than it deserves:

- It matches shapes in text. It does not understand your code. A tenant filter
  built in a helper the check cannot see will be reported, and the comment above
  is the fix.
- The money and scope checks only read JavaScript and TypeScript.
- The migration check only reads `.sql` files. Migrations written in JavaScript
  or TypeScript are not checked.
- Secrets split across lines, or with no recognisable prefix, are not found. For
  deep history scanning use gitleaks or trufflehog; this is the cheap guard on
  the door, not the audit.
- A query inside `prisma.$transaction(async (tx) => ...)` uses a client the
  check cannot follow.

Every rule's blind spots are listed in the
[gate reference](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/gates.md).

## Words used here

- **Gate** or **check**: one of the five things it looks for.
- **Finding**: one problem it reports, with a file and line.
- **Blocking**: a finding that makes the run exit `1`. Warnings do not.
- **Baseline**: the file that records findings you have chosen to live with for
  now, so only new ones block.
- **Acknowledge** or **excuse**: the `bouncer-gates-ok` comment that says a specific
  line is fine, and why.

## Telemetry

One anonymous ping a day: a random id, the version, the runtime, the OS and the
Node major. Nothing about your code, ever. `BOUNCER_TELEMETRY=0` turns it off.
[Everything it sends](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/telemetry.md).

## More

- [Inside the editor](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/agents.md): the MCP server and the hook, what the agent sees, other editors
- [Gate reference](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/gates.md): every rule, a bad and a good example, what it misses
- [Rolling it out on an existing codebase](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/adoption.md)
- [Design notes](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/design-notes.md): why it never fails open, why findings never quote the secret, the false-positive story, and the speed work
- [Architecture](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/architecture.md): gates are pure functions, which is why the same code runs in the CLI, in a Cloudflare Worker and in your browser
- [Deployment](https://github.com/ajeermahmood/bouncer-gates/blob/main/docs/deployment.md): the playground, the API and npm
- [Contributing](https://github.com/ajeermahmood/bouncer-gates/blob/main/CONTRIBUTING.md): adding a gate, and how to decide whether something should be one

## Development

```bash
npm install
npm test                        # unit tests
npm run check                   # bouncer-gates on itself
npm run bench -- ../some-repo   # measure against a real codebase
npm run dev                     # the playground site
```

## Licence

MIT. Take any of it.

Built by [Ajeer Mohammed](https://ajeer.website). The rules come from running
checks like these across eight production repositories, on a multi-tenant
platform where missing one meant a merchant seeing another merchant's orders.
