import { finding, ERROR, WARN } from "./lib/finding.mjs";

/**
 * The window where the old code runs against the new schema.
 *
 * Almost every deploy pipeline migrates before it swaps the application:
 *
 *     migrate  ->  build  ->  restart
 *
 * Between step one and step three, the PREVIOUS version of your app is talking to
 * the NEW database. On a good day that window is ninety seconds. If the build
 * fails, that window is however long it takes someone to notice, which at 3am is
 * measured in hours.
 *
 * So a migration is not "does the new code work with this schema". It is "does
 * the OLD code survive this schema". The statements below break that, always.
 *
 * The fix is always the same shape, and it is called expand-contract: add the new
 * thing, deploy code that writes both, backfill, deploy code that reads the new
 * one, and only then, in a LATER release, remove the old thing. It is two deploys
 * where you wanted one. That is the price.
 *
 * Only NEW migrations are checked. History is already applied everywhere and is
 * none of this gate's business, so the caller passes in the added files.
 *
 * WHY THIS PARSES STATEMENTS RATHER THAN LINES. The first version matched line by
 * line, and quietly missed the very thing it existed for:
 *
 *     ALTER TABLE orders
 *       ADD COLUMN currency VARCHAR(3)
 *       NOT NULL;
 *
 * `ADD COLUMN` and `NOT NULL` are on different lines, so no single line matched
 * and the migration passed. Prisma emits single-line DDL, which is why it looked
 * fine in testing; hand-written migrations wrap constantly. Statements are split
 * on semicolons outside string literals, and each finding reports the line the
 * statement started on.
 */
export const name = "migration-safety";
export const title = "Migration safety";
export const summary =
  "Schema changes that break the previous version of the app during the deploy window.";

const RULES = [
  {
    rule: "migration/drop-table",
    re: /\bDROP\s+TABLE\b/i,
    message: "Dropping a table. The running version of the app still reads it until the deploy finishes.",
    fix: "Stop reading it in this release. Drop it in the next one.",
  },
  {
    rule: "migration/drop-column",
    // Postgres allows both `DROP COLUMN x` and the bare `DROP x` inside ALTER TABLE.
    // The negative lookahead keeps ALTER COLUMN x DROP DEFAULT, DROP NOT NULL,
    // DROP IDENTITY and DROP CONSTRAINT out. None of those removes a column, and
    // the first two are exactly what a careful expand-contract migration does.
    re: /\bDROP\s+(?:COLUMN\s+)?(?!(?:DEFAULT|NOT|IDENTITY|EXPRESSION|CONSTRAINT|INDEX|TABLE|IF)\b)"?\w+"?(?=\s*(?:,|;|$|\bCASCADE\b|\bRESTRICT\b))/i,
    guard: /\bALTER\s+TABLE\b/i,
    message: "Dropping a column. Any SELECT * or explicit read in the old version fails immediately.",
    fix: "Stop selecting it in this release, ship, then drop it in the next one.",
  },
  {
    rule: "migration/rename",
    // Only tables and columns. Renaming an index or a constraint changes nothing
    // the old application can see.
    re: /\bRENAME\s+(?:TO|COLUMN)\b/i,
    guard: /\bALTER\s+TABLE\b/i,
    message: "A rename is a drop plus an add. The old version knows only the old name.",
    fix: "Add the new name, write to both, backfill, move reads, then remove the old name later.",
  },
  {
    rule: "migration/add-not-null",
    // Checked clause by clause rather than with one regex over the statement.
    // The regex version had two bugs pulling in opposite directions: its
    // "no DEFAULT" lookahead stopped at the end of the line, so a DEFAULT on the
    // next line was invisible and a safe column was reported; and it read the
    // whole statement at once, so "ADD a INT DEFAULT 1, ADD b INT NOT NULL" was
    // excused by the first clause's default while the second had none.
    re: /\bADD\b[\s\S]*\bNOT\s+NULL\b/i,
    test: addsNotNullWithoutDefault,
    message: "Adding a NOT NULL column with no default. Every insert from the old version fails.",
    fix: "Add it nullable with a default, backfill, then tighten to NOT NULL in a later migration.",
  },
  {
    rule: "migration/set-not-null",
    re: /\bALTER\s+COLUMN\s+"?\w+"?\s+SET\s+NOT\s+NULL\b/i,
    message:
      "Tightening an existing column to NOT NULL. The old version can still insert rows without it, and on Postgres this also takes a full table scan under an exclusive lock.",
    fix: "Confirm no code path writes a null, backfill any that exist, and add a CHECK ... NOT VALID first if the table is large.",
  },
  {
    rule: "migration/type-narrowing",
    re: /\bALTER\s+COLUMN\b[\s\S]*?\bTYPE\b[\s\S]*?\b(?:VARCHAR|CHAR)\s*\(\s*\d+\s*\)/i,
    message: "Narrowing a column type can reject rows the old version still writes.",
    fix: "Widen freely; narrow only after you are certain nothing writes the longer value.",
    severity: WARN,
  },
  {
    rule: "migration/blocking-index",
    re: /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b(?![\s\S]*\bCONCURRENTLY\b)/i,
    message: "Creating an index without CONCURRENTLY holds a write lock on the table for the whole build.",
    fix: "Use CREATE INDEX CONCURRENTLY on any table that takes writes in production.",
    severity: WARN,
  },
  {
    rule: "migration/validated-fk",
    re: /\bADD\s+CONSTRAINT\b[\s\S]*?\b(?:FOREIGN\s+KEY|CHECK)\b(?![\s\S]*\bNOT\s+VALID\b)/i,
    message:
      "Adding a validated constraint scans the whole table under a lock that blocks writes for the duration.",
    fix: "Add it NOT VALID, then VALIDATE CONSTRAINT in a separate migration, which takes a far weaker lock.",
    severity: WARN,
  },
];

/**
 * The acknowledgement here is per FILE rather than per line, because a migration
 * is one unit of intent. If you have decided this migration is safe (the column
 * never shipped, the change deploys dark), you say so once at the top:
 *
 *     -- bouncer-ok(migration): add_referrals never reached production
 */
const ACK = /--\s*bouncer-ok\(migration\)\s*:\s*\S+/i;

/**
 * The ADD clauses of an ALTER TABLE, each cut at the next top-level comma.
 *
 * DECIMAL(10, 2) has a comma inside it, so this walks the parentheses rather
 * than splitting on the character.
 */
function addClauses(sql) {
  const out = [];
  const re = /\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?/gi;
  let m;
  while ((m = re.exec(sql))) {
    let depth = 0;
    let i = m.index + m[0].length;
    const start = i;
    for (; i < sql.length; i++) {
      const ch = sql[i];
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if ((ch === "," || ch === ";") && depth === 0) break;
    }
    out.push(sql.slice(start, i));
    re.lastIndex = i;
  }
  return out;
}

function addsNotNullWithoutDefault(sql) {
  for (const clause of addClauses(sql)) {
    if (/^\s*CONSTRAINT\b/i.test(clause)) continue;
    if (!/\bNOT\s+NULL\b/i.test(clause)) continue;
    if (/\bDEFAULT\b/i.test(clause)) continue;
    // An identity or serial column fills itself in. The old application never
    // has to supply it, so NOT NULL is safe here.
    if (/\b(?:IDENTITY|SERIAL|BIGSERIAL|SMALLSERIAL)\b/i.test(clause)) continue;
    return true;
  }
  return false;
}

/**
 * Tables this migration creates. A statement that only touches one of them
 * cannot break the previous version of the application, because the previous
 * version has never heard of the table. Without this, every Prisma migration
 * that creates a table and then indexes it produces a warning about a lock on a
 * table that has no rows and no readers.
 */
const CREATE_TABLE =
  /\bCREATE\s+(?:UNLOGGED\s+|TEMP(?:ORARY)?\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?("?[\w.]+"?)/gi;
const TARGET_TABLE =
  /\b(?:ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?|INDEX\b[^;]*?\bON\s+(?:ONLY\s+)?)("?[\w.]+"?)/i;

function tableName(raw) {
  const bare = raw.replace(/"/g, "");
  const dot = bare.lastIndexOf(".");
  return (dot === -1 ? bare : bare.slice(dot + 1)).toLowerCase();
}

function createdTables(stmts) {
  const set = new Set();
  for (const s of stmts) {
    for (const m of s.sql.matchAll(CREATE_TABLE)) set.add(tableName(m[1]));
  }
  return set;
}

/**
 * Split SQL into statements, remembering where each began.
 *
 * Handles the three things that actually appear in migration files and would
 * otherwise split a statement in the wrong place: line comments, single-quoted
 * literals (including the doubled-quote escape), and dollar-quoted bodies used
 * by functions and triggers.
 *
 * @returns {{sql: string, line: number}[]}
 */
export function statements(text) {
  const out = [];
  let buf = "";
  let line = 1;
  let startLine = 1;
  let i = 0;
  let started = false;

  const push = () => {
    if (buf.trim()) out.push({ sql: buf, line: startLine });
    buf = "";
    started = false;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      line++;
      buf += ch;
      i++;
      continue;
    }

    // -- line comment
    if (ch === "-" && text[i + 1] === "-") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }

    // /* block comment */
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }

    // 'literal', with '' as the escape
    if (ch === "'") {
      buf += ch;
      i++;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          buf += "''";
          i += 2;
          continue;
        }
        if (text[i] === "'") break;
        if (text[i] === "\n") line++;
        buf += text[i];
        i++;
      }
      buf += "'";
      i++;
      continue;
    }

    // $tag$ ... $tag$
    const dollar = /^\$(\w*)\$/.exec(text.slice(i, i + 32));
    if (dollar) {
      const tag = dollar[0];
      buf += tag;
      i += tag.length;
      const end = text.indexOf(tag, i);
      const body = end === -1 ? text.slice(i) : text.slice(i, end);
      for (const c of body) if (c === "\n") line++;
      buf += body + tag;
      i = end === -1 ? text.length : end + tag.length;
      continue;
    }

    if (ch === ";") {
      buf += ch;
      push();
      i++;
      continue;
    }

    if (!started && !/\s/.test(ch)) {
      started = true;
      startLine = line;
    }
    buf += ch;
    i++;
  }
  push();
  return out;
}

/**
 * @param {{path: string, text: string}[]} addedMigrations only files ADDED vs the base branch
 */
export function scan(addedMigrations) {
  const out = [];
  for (const file of addedMigrations) {
    if (!/\.sql$/i.test(file.path)) continue;
    if (ACK.test(file.text)) continue;

    const stmts = statements(file.text);
    const created = createdTables(stmts);

    for (const stmt of stmts) {
      const target = stmt.sql.match(TARGET_TABLE);
      if (target && created.has(tableName(target[1]))) continue;

      for (const r of RULES) {
        if (r.guard && !r.guard.test(stmt.sql)) continue;
        if (!r.re.test(stmt.sql)) continue;
        if (r.test && !r.test(stmt.sql)) continue;
        out.push(
          finding({
            path: file.path,
            line: stmt.line,
            rule: r.rule,
            message: r.message,
            fix: r.fix,
            severity: r.severity ?? ERROR,
          })
        );
        break; // one finding per statement; rules are ordered most severe first
      }
    }
  }
  return out;
}
