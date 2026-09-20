import { finding, lines, acknowledged, isCommentLine, escapeRe, ERROR } from "./lib/finding.mjs";

/**
 * "Every row belongs to somebody, and you must say who."
 *
 * The bug class: a multi-tenant application where one customer can read or write
 * another customer's rows. It is the worst bug a SaaS product can ship, it is
 * silent, and no amount of care prevents it, because preventing it requires every
 * developer to remember it on every query forever.
 *
 * The fix is not this gate. The fix is a scoped database client that injects the
 * tenant filter automatically, so ordinary feature code CANNOT get it wrong.
 * Build that first.
 *
 * This gate closes the gap the scoped client leaves: code that reaches AROUND it.
 *
 *     db.forTenant(id).order.findMany()   // safe, filter injected
 *     db.raw.order.findMany()             // reaches around it. this is the gap.
 *     const c = db.raw; c.order.findMany() // same, via an alias
 *     db.$queryRaw(`SELECT * FROM orders`) // same, via raw SQL
 *
 * So the gate is deliberately narrow. It does not try to understand your queries.
 * It finds the three ways to bypass the safe path and asks you to justify each
 * one. That is a mechanical check, not a proof, and the difference matters:
 *
 * Not every codebase has a scoped client yet. For those, "clients" lists the
 * plain client names (say, "prisma") and the gate checks that every list-style
 * query on a tenant-owned model mentions the tenant column somewhere in the
 * call. That is a weaker guarantee than a scoped client, and it says so in its
 * message, but it is the check that turns "we should always filter by tenant"
 * from a convention into something the build enforces on day one.
 *
 * KNOWN BLIND SPOTS, stated so nobody trusts this further than it deserves:
 *   - Interactive transactions. `db.$transaction((tx) => ...)` hands you a client
 *     bound to a variable this gate cannot follow. Cover those in review.
 *   - Whether a `bouncer-gates-ok(scope):` reason is still TRUE months later.
 *   - A scoped model that nobody added to the config.
 *
 * The first two need a reader who understands intent, which is what
 * `.claude/skills/gate-review` is for. The third is why the config should be
 * generated from your schema rather than hand-maintained.
 */
export const name = "scope";
export const title = "Tenant scope";
export const summary =
  "Queries on tenant-owned tables that are not limited to one tenant: through the raw client, an alias of it, raw SQL, or a plain client with no tenant filter.";

/** Sensible defaults for a Prisma codebase. Override in bouncer-gates.config.json. */
export const DEFAULTS = {
  models: [],
  tables: [],
  column: "tenantId",
  rawAccessor: "raw",
  rawSqlCalls: ["$queryRaw", "$queryRawUnsafe", "$executeRaw", "$executeRawUnsafe"],
  // Plain client names to check directly, for codebases with no scoped client.
  // Empty by default: a repository that has a scoped wrapper does not want its
  // raw client name listed here, because the wrapper is what makes it safe.
  clients: [],
  // The query methods that return or touch many rows. findUnique, update and
  // delete address one row by its own id and are left to review, because a
  // finding on every one of them would be noise rather than signal.
  queryMethods: [
    "findMany",
    "findFirst",
    "findFirstOrThrow",
    "updateMany",
    "deleteMany",
    "count",
    "aggregate",
    "groupBy",
  ],
};

const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage)\//;

/**
 * Compiled form of one config, cached.
 *
 * The CLI calls scan() once, so this looks like nothing. The Railway service
 * calls it per request, and the playground calls it on every keystroke, where
 * recompiling nine regexes each time is pure waste. Keyed on the config's own
 * values rather than object identity, so a caller that rebuilds an equivalent
 * config object still hits the cache.
 */
const COMPILED = new Map();

function compile(config) {
  const cfg = { ...DEFAULTS, ...config };
  const key = JSON.stringify([
    cfg.models,
    cfg.tables,
    cfg.column,
    cfg.rawAccessor,
    cfg.rawSqlCalls,
    cfg.clients,
    cfg.queryMethods,
  ]);
  const hit = COMPILED.get(key);
  if (hit) return hit;

  const modelAlt = cfg.models.map(escapeRe).join("|");
  const tableAlt = cfg.tables.map(escapeRe).join("|");
  const clientAlt = (cfg.clients ?? []).map(escapeRe).join("|");
  const methodAlt = (cfg.queryMethods ?? DEFAULTS.queryMethods).map(escapeRe).join("|");
  const direct = Boolean(clientAlt && modelAlt);

  const built = {
    active: Boolean(cfg.models.length || cfg.tables.length),
    column: cfg.column,
    // db.raw.order / this.prisma.raw.order
    viaRaw: modelAlt
      ? new RegExp("\\." + escapeRe(cfg.rawAccessor) + "\\.(" + modelAlt + ")\\b")
      : null,
    // const c = db.raw  -> uses of `c` after this are suspect
    aliasDecl: new RegExp(
      "(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*[\\w.$]*\\." +
        escapeRe(cfg.rawAccessor) +
        "\\s*;?\\s*$"
    ),
    modelAlt,
    rawSql: new RegExp("\\.(?:" + cfg.rawSqlCalls.map(escapeRe).join("|") + ")\\b"),
    touchesTable: tableAlt
      ? new RegExp("\\b(?:FROM|JOIN|UPDATE|INTO|TABLE)\\s+\"?(" + tableAlt + ")\"?\\b", "i")
      : null,
    hasScopeColumn: new RegExp("\\b" + escapeRe(cfg.column) + "\\b", "i"),
    // prisma.order.findMany(   /  this.prisma.order.count(
    // A dot may precede the client name, so "prisma" also covers "this.prisma".
    // "db.raw.order" does not match "db" because ".raw." sits between them.
    directQuery: direct
      ? new RegExp(
          "(?:^|[^\\w$])(?:" + clientAlt + ")\\.(" + modelAlt + ")\\.(?:" + methodAlt + ")\\s*\\("
        )
      : null,
    // The call is scoped if the column appears, or if anything in it is named
    // for the tenant: a "tenantWhere" built two lines up counts, because the
    // alternative is flagging every query that builds its filter in a variable.
    tenantHint: new RegExp("\\b" + escapeRe(cfg.column) + "\\b|tenant", "i"),
    // Whole-file reject: if none of these substrings appear, no line can match.
    trigger: new RegExp(
      "\\." +
        escapeRe(cfg.rawAccessor) +
        "\\b|" +
        cfg.rawSqlCalls.map(escapeRe).join("|") +
        (direct ? "|(?:" + clientAlt + ")\\.(?:" + modelAlt + ")\\." : "")
    ),
  };

  COMPILED.set(key, built);
  return built;
}

export function scan(files, config = {}) {
  const c = compile(config);
  const out = [];
  if (!c.active) return out;

  for (const file of files) {
    const norm = file.path.replace(/\\/g, "/");
    if (!SOURCE.test(norm) || SKIP_PATH.test(norm)) continue;
    if (!c.trigger.test(file.text)) continue;

    const all = lines(file);
    // Alias name -> compiled matcher. Built once per alias per file, rather than
    // once per alias per LINE, which is what the first version did and was by far
    // the hottest allocation in the program.
    const aliasRes = new Map();

    for (let i = 0; i < all.length; i++) {
      const line = all[i];

      const decl = line.match(c.aliasDecl);
      if (decl && c.modelAlt && !aliasRes.has(decl[1])) {
        aliasRes.set(
          decl[1],
          new RegExp("\\b" + escapeRe(decl[1]) + "\\.(" + c.modelAlt + ")\\b")
        );
      }

      if (acknowledged(all, i, "scope")) continue;

      // A comment demonstrating the bad pattern is not the bad pattern. This
      // gate found its own documentation on the first run, which is funny once
      // and then is just a false positive that teaches people to ignore output.
      // Only whole-line comments are skipped, so a trailing `// why` on real
      // code still gets checked.
      if (isCommentLine(line)) continue;

      if (c.viaRaw) {
        const m = line.match(c.viaRaw);
        if (m) {
          out.push(
            finding({
              path: file.path,
              line: i + 1,
              rule: "scope/raw-client",
              message:
                '"' +
                m[1] +
                '" is tenant-owned, but this reads it through the unscoped client, so it can see every tenant\'s rows.',
              fix:
                "Go through the scoped client instead. If this genuinely must span tenants " +
                "(an admin report, a cron job), say so: // bouncer-gates-ok(scope): <why>",
              severity: ERROR,
            })
          );
          continue;
        }
      }

      if (aliasRes.size) {
        for (const [alias, re] of aliasRes) {
          const m = line.match(re);
          if (!m) continue;
          out.push(
            finding({
              path: file.path,
              line: i + 1,
              rule: "scope/raw-alias",
              message:
                '"' + m[1] + '" is reached through "' + alias + '", an alias for the unscoped client.',
              fix:
                "Aliasing the raw client hides the bypass from a reader. Use the scoped " +
                "client, or acknowledge with // bouncer-gates-ok(scope): <why>",
              severity: ERROR,
            })
          );
          break;
        }
      }

      if (c.directQuery) {
        const m = line.match(c.directQuery);
        if (m) {
          const stmt = statementAt(all, i);
          if (!c.tenantHint.test(stmt)) {
            out.push(
              finding({
                path: file.path,
                line: i + 1,
                rule: "scope/unscoped-query",
                message:
                  '"' +
                  m[1] +
                  '" is tenant-owned, but nothing in this query mentions "' +
                  c.column +
                  '", so it returns rows from every tenant.',
                fix:
                  "Add " +
                  c.column +
                  " to the where clause, or go through a tenant-scoped client. " +
                  "If this must span tenants (an admin report, a cron job), say so: // bouncer-gates-ok(scope): <why>",
                severity: ERROR,
              })
            );
          }
          continue;
        }
      }

      // Raw SQL: look at the statement, which often wraps across lines.
      //
      // The obvious version of this ("take the next 12 lines") is wrong, and it
      // fails in the dangerous direction. Given:
      //
      //     await db.$queryRaw(`SELECT * FROM orders WHERE id = 1`);        // unsafe
      //     await db.$queryRaw(`SELECT * FROM orders WHERE tenantId = $1`); // safe
      //
      // a fixed window starting at the first line reaches into the second, finds
      // its `tenantId`, and concludes the FIRST query was scoped. A cross-tenant
      // leak is cleared because the line below it happened to be correct.
      // So the window ends where the statement ends.
      if (c.touchesTable && c.rawSql.test(line)) {
        const stmt = statementAt(all, i);
        const t = stmt.match(c.touchesTable);
        if (t && !c.hasScopeColumn.test(stmt)) {
          out.push(
            finding({
              path: file.path,
              line: i + 1,
              rule: "scope/raw-sql",
              message:
                'This raw SQL touches "' +
                t[1] +
                '", which is tenant-owned, and no "' +
                c.column +
                '" appears anywhere in the statement.',
              fix:
                "Add the " +
                c.column +
                " predicate as a bound parameter, never string interpolation. " +
                "If the query is deliberately cross-tenant, acknowledge it.",
              severity: ERROR,
            })
          );
        }
      }
    }
  }
  return out;
}

/**
 * The single statement beginning on line `start`, by paren balance.
 *
 * Counts round brackets and backticks so a template literal spanning lines stays
 * whole, and stops the moment the call closes. Capped at 40 lines so a file that
 * confuses the counter costs one bounded scan rather than the rest of the file.
 */
function statementAt(all, start) {
  let depth = 0;
  let started = false;
  let inTemplate = false;
  const collected = [];

  for (let i = start; i < all.length && i < start + 40; i++) {
    const line = all[i];
    collected.push(line);

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === "\\") {
        j++;
        continue;
      }
      if (ch === "`") {
        inTemplate = !inTemplate;
        continue;
      }
      if (inTemplate) continue;
      if (ch === "(") {
        depth++;
        started = true;
      } else if (ch === ")") depth--;
    }
    if (started && depth <= 0) break;
  }
  return collected.join("\n");
}
