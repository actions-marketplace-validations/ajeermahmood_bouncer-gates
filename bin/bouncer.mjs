#!/usr/bin/env node
/**
 * The runner. All the I/O lives here so the gates can stay pure.
 *
 * Exit codes:
 *   0  nothing blocking
 *   1  blocking findings, or a gate crashed
 *   2  the runner could not do its job (bad flag, unreadable config, not a repo)
 *
 * The 1/2 split matters in CI. A failed check and a broken tool need different
 * reactions, and collapsing them means a misconfigured runner looks exactly like
 * a codebase full of problems.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, join } from "node:path";
import { GATES } from "../gates/index.mjs";
import { lines } from "../gates/lib/finding.mjs";
import { globToRe } from "../gates/lib/glob.mjs";
import {
  fingerprintAll,
  createBaseline,
  applyBaseline,
  validateBaseline,
} from "../gates/lib/baseline.mjs";
import { prismaTenantModels, detectTenantColumn, repoUrlFromRemote } from "../gates/lib/prisma.mjs";

const VERSION = "0.3.0";

const HELP = `bouncer ${VERSION}
CI gates that let anyone contribute without being able to break things.

  bouncer                          run every gate over the whole repository
  bouncer --init                   write a starter bouncer.config.json
  bouncer --changed                only files that differ from the base ref
  bouncer --only scope,money       run named gates
  bouncer --explain scope          what a gate checks and how to acknowledge it

Options
  --base <ref>       what "changed" and "new" are measured against (default origin/main)
  --changed          scan only files that differ from the base ref
  --baseline-write   record current findings so they stop blocking; new ones still do
  --no-baseline      ignore an existing baseline file
  --json             machine-readable output
  --sarif            SARIF 2.1.0, for GitHub code scanning
  --quiet            print failures only
  --no-color         plain output
  --root <dir>       repository root (default: cwd)
  --version, --help
`;

const argv = process.argv.slice(2);

const KNOWN_FLAGS = new Set([
  "init",
  "changed",
  "baseline-write",
  "no-baseline",
  "json",
  "sarif",
  "quiet",
  "help",
  "version",
  "no-color",
]);
const KNOWN_VALUES = new Set(["base", "only", "root", "explain"]);

function fail(msg) {
  process.stderr.write(`bouncer: ${msg}\n`);
  process.exit(2);
}

// An unrecognised flag is a usage error, not something to ignore. Silently
// accepting `--onyl scope` and scanning everything anyway is how a CI job passes
// for a year while checking nothing anybody intended.
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith("--")) continue;
  const nameOnly = a.slice(2).split("=")[0];
  if (KNOWN_VALUES.has(nameOnly)) {
    if (!a.includes("=")) i++;
    continue;
  }
  if (!KNOWN_FLAGS.has(nameOnly)) fail(`unknown option "${a}"\n\n${HELP}`);
}

const flag = (n) => argv.includes(`--${n}`);
const value = (n, d) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  if (eq) return eq.slice(n.length + 3);
  const i = argv.indexOf(`--${n}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

if (flag("help")) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (flag("version")) {
  process.stdout.write(VERSION + "\n");
  process.exit(0);
}

const SARIF_OUT = flag("sarif");
const JSON_OUT = flag("json");
const QUIET = flag("quiet") || JSON_OUT || SARIF_OUT;
const CHANGED = flag("changed");
const WRITE_BASELINE = flag("baseline-write");
const NO_BASELINE = flag("no-baseline");
const ONLY = value("only", "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const BASE_GIVEN =
  argv.some((a) => a === "--base" || a.startsWith("--base=")) || Boolean(process.env.BOUNCER_BASE_REF);
let BASE = value("base", process.env.BOUNCER_BASE_REF || "origin/main");
const ROOT = resolve(value("root", process.cwd()));
const EXPLAIN = value("explain", "");

// Committed .env files are scanned on purpose. Git only lists what is tracked,
// so a .env that appears here is one somebody committed, which is the mistake
// the secrets gate most wants to see.
const SOURCE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|astro|vue|svelte|py|go|rb|php|sh|ya?ml|json|env|sql|tf)$|(?:^|\/)\.env(?:\.[\w.-]+)?$/i;
const TEXT_MAX = 512 * 1024;
const BASELINE_PATH = join(ROOT, "bouncer.baseline.json");

// ---------------------------------------------------------------- helpers

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

function wrap(s, width = 78) {
  const out = [];
  let line = "";
  for (const w of s.split(/\s+/)) {
    if (line && line.length + w.length + 1 > width) {
      out.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) out.push(line);
  return out.join("\n");
}

function loadJson(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    fail(`${label} is not valid JSON: ${e.message}`);
  }
}

/**
 * Read a tracked file, or say why not.
 *
 * Returning a reason rather than a bare null is the same rule the gates follow.
 * A file that cannot be read is a file that is not scanned, and an earlier
 * version dropped those silently, so a source file could sit in the repository
 * being checked by nothing at all while the run reported green.
 *
 * That is not hypothetical. `gates/lib/finding.mjs` used raw NUL bytes as
 * fingerprint separators, which made it binary, which made this function skip it.
 * The tool's own core library was invisible to the tool for several releases, and
 * nothing in the output hinted at it.
 *
 * @returns {{text: string} | {reason: string}}
 */
function read(path) {
  let buf;
  try {
    buf = readFileSync(join(ROOT, path));
  } catch (e) {
    return { reason: e.code === "ENOENT" ? "not on disk" : "unreadable" };
  }
  if (buf.length > TEXT_MAX) return { reason: "larger than 512KB" };
  if (buf.includes(0)) return { reason: "binary" };
  return { text: buf.toString("utf8") };
}

/**
 * Resolve the base ref once. Empty string means it is not available here.
 *
 * When nobody chose a base, the usual names are tried in order. A developer
 * running this for the first time on a laptop, in a repository whose default
 * branch is `master` or that has no remote yet, should see the migration gate
 * run rather than a skip message about a branch they never mentioned. An
 * explicit --base is never second-guessed.
 */
function resolveBase() {
  const candidates = BASE_GIVEN ? [BASE] : [BASE, "origin/master", "main", "master"];
  for (const ref of candidates) {
    if (!git(["rev-parse", "--verify", "--quiet", ref]).trim()) continue;
    BASE = ref;
    return git(["merge-base", ref, "HEAD"]).trim();
  }
  return "";
}

// ---------------------------------------------------------------- explain

if (EXPLAIN) {
  const gate = GATES.find((g) => EXPLAIN === g.name || EXPLAIN.startsWith(g.name + "/"));
  if (!gate) {
    fail(`no gate matches "${EXPLAIN}". Known gates: ${GATES.map((g) => g.name).join(", ")}`);
  }
  process.stdout.write(`\n${gate.title}  (${gate.name})\n\n${wrap(gate.summary)}\n`);
  process.stdout.write(
    `\nAcknowledge a deliberate case on the line, or the line above it:\n\n` +
      `    // bouncer-ok(${gate.name}): why this is fine here\n\n` +
      `The reason is required; a bare marker suppresses nothing.\n`
  );
  process.exit(0);
}

// ---------------------------------------------------------------- init

/**
 * A starting config, with the scope gate filled in from a Prisma schema.
 *
 * The docs have always said the model list should come from the schema. Until
 * this existed, that was advice; now it is what happens. A repository without a
 * Prisma schema still gets a config, with the scope section empty and a line of
 * output saying exactly what that means.
 */
if (flag("init")) {
  const target = join(ROOT, "bouncer.config.json");
  if (existsSync(target)) {
    fail("bouncer.config.json already exists. Edit it, or delete it and run --init again.");
  }
  const tracked = git(["ls-files"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const schemas = [];
  for (const schemaPath of tracked.filter((p) => /\.prisma$/i.test(p))) {
    const r = read(schemaPath);
    if (!r.reason) schemas.push({ schemaPath, text: r.text });
  }
  // The column is guessed from all schemas together, then every model that has
  // it becomes tenant-owned. The output names the guess so a wrong one is
  // obvious on the first run rather than silent.
  const column = detectTenantColumn(schemas.map((s) => s.text).join("\n"));
  const found = [];
  for (const { schemaPath, text } of schemas) {
    for (const m of prismaTenantModels(text, column)) found.push({ ...m, schemaPath });
  }

  const config = {
    exclude: [],
    scope: {
      models: found.map((m) => m.model),
      tables: found.map((m) => m.table),
      column,
      rawAccessor: "raw",
      clients: found.length ? ["prisma"] : [],
    },
  };
  const repoUrl = repoUrlFromRemote(git(["remote", "get-url", "origin"]));
  if (repoUrl) config["doc-links"] = { repoUrl };

  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");

  const lines = [
    "Wrote bouncer.config.json",
    "",
  ];
  if (found.length) {
    const schemas = [...new Set(found.map((m) => m.schemaPath))].join(", ");
    lines.push(
      "  scope: " +
        found.length +
        " tenant-owned model" +
        (found.length === 1 ? "" : "s") +
        " found in " +
        schemas +
        " (every model with a \"" +
        column +
        "\" field, the owner column used most): " +
        found.map((m) => m.model).join(", "),
      "         \"clients\" is set to [\"prisma\"], so plain prisma.<model> queries are checked",
      "         for the tenant column. If you have a scoped wrapper, set \"rawAccessor\" to its",
      "         raw client name and empty \"clients\" instead."
    );
  } else {
    lines.push(
      "  scope: no Prisma schema with a \"" + column + "\" field was found, so the scope gate",
      "         will report skipped until you list your tenant-owned models under \"scope\"."
    );
  }
  if (repoUrl) lines.push("  doc-links: absolute links back to " + repoUrl + " will be checked too");
  lines.push(
    "",
    "Next:",
    "  npx bouncer-gates                    see what it finds",
    "  npx bouncer-gates --baseline-write   if there is existing debt, record it so only new problems block",
    "  npx bouncer-gates --explain scope    what a gate checks and how to excuse one case",
    ""
  );
  process.stdout.write(lines.join("\n"));
  process.exit(0);
}

// ---------------------------------------------------------------- context

function buildContext(gates, config) {
  const needed = new Set(gates.flatMap((g) => g.needs));
  let tracked = git(["ls-files"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!tracked.length) {
    fail(
      `no tracked files found in ${ROOT}.\n` +
        `Bouncer reads the file list from git, so it runs on what is committed rather ` +
        `than whatever is lying in the directory. Run it inside a git repository.`
    );
  }

  const mergeBase = needed.has("addedSql") || CHANGED ? resolveBase() : "";

  // Excluded paths.
  //
  // A repository of gates necessarily contains the patterns those gates look
  // for: test fixtures and playground examples are hardcoded secrets and
  // cross-tenant queries on purpose. So exclusion has to exist.
  //
  // What matters is that it is loud. These are declared in bouncer.config.json,
  // never inferred, and the runner prints how many files each pattern removed on
  // every run. An exclude list that silently grows to cover half the codebase is
  // the most likely way a setup like this rots.
  //
  // This removes a FILE from scanning. It is not a way to switch a rule off
  // across the repo; that is the per-line escape hatch, and it demands a reason.
  const patterns = Array.isArray(config.exclude) ? config.exclude : [];
  const excluded = [];
  if (patterns.length) {
    const res = patterns.map((p) => ({ pattern: p, re: globToRe(p) }));
    const kept = [];
    for (const path of tracked) {
      const hit = res.find((r) => r.re.test(path));
      if (hit) excluded.push({ path, pattern: hit.pattern });
      else kept.push(path);
    }
    tracked = kept;
  }

  // --changed narrows the scan to this branch's own work. On a large repository
  // that is the difference between a check people run and one they wait for.
  //
  // If the base ref is missing (a shallow CI clone), this does NOT quietly fall
  // back to scanning everything or nothing. Scanning everything would be a
  // surprise timeout; scanning nothing would pass for the wrong reason. It stops
  // and says so, which is the same rule the gates themselves follow.
  let changedSet = null;
  if (CHANGED) {
    if (!mergeBase) {
      fail(
        `--changed needs the base ref "${BASE}", which is not in this clone.\n` +
          `In GitHub Actions add "fetch-depth: 0" to actions/checkout, or pass --base.`
      );
    }
    const names = git(["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]);
    changedSet = new Set(
      names
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  const ctx = {
    source: [],
    markdown: [],
    // repoFiles keeps excluded and unchanged paths. A link to a test fixture is
    // still a link to a file that exists, and doc-links would call it broken.
    repoFiles: new Set([...tracked, ...excluded.map((e) => e.path)]),
    addedSql: [],
    excluded,
    unreadable: [],
    changedCount: changedSet ? changedSet.size : null,
    baseAvailable: Boolean(mergeBase),
    baseRef: BASE,
  };

  if (needed.has("source") || needed.has("markdown")) {
    for (const path of tracked) {
      if (changedSet && !changedSet.has(path)) continue;
      const isMd = /\.mdx?$/i.test(path);
      if (!isMd && !SOURCE_EXT.test(path)) continue;
      const r = read(path);
      if (r.reason) {
        // Not scanned, and therefore worth saying out loud. Silence here means a
        // file is checked by nothing while the run still reports green.
        ctx.unreadable.push({ path, reason: r.reason });
        continue;
      }
      // Split once here. Gates share the array through lines(), so a repository
      // with three line-based gates splits each file once instead of three times.
      const file = { path, text: r.text, lines: r.text.split(/\r\n|\r|\n/) };
      if (isMd) ctx.markdown.push(file);
      else ctx.source.push(file);
    }
  }

  if (needed.has("addedSql") && mergeBase) {
    const out = git(["diff", "--name-only", "--diff-filter=A", mergeBase, "HEAD"]);
    ctx.addedSql = out
      .split("\n")
      .map((s) => s.trim())
      .filter((p) => p && /\.sql$/i.test(p))
      .map((path) => {
        const r = read(path);
        if (r.reason) ctx.unreadable.push({ path, reason: r.reason });
        return { path, text: r.text ?? "" };
      });
  }

  return ctx;
}

// ---------------------------------------------------------------- run

const config = loadJson(join(ROOT, "bouncer.config.json"), "bouncer.config.json") ?? {};
const selected = ONLY.length ? GATES.filter((g) => ONLY.includes(g.name)) : GATES;
if (ONLY.length) {
  const unknown = ONLY.filter((n) => !GATES.some((g) => g.name === n));
  if (unknown.length) {
    fail(
      `unknown gate(s) in --only: ${unknown.join(", ")}. ` +
        `Available: ${GATES.map((g) => g.name).join(", ")}`
    );
  }
}

const started = Date.now();
const ctx = buildContext(selected, config);
const results = [];

for (const gate of selected) {
  const skip = gate.skipWhen?.(ctx, config);
  if (skip) {
    results.push({ gate: gate.name, status: "skipped", reason: skip, findings: [] });
    continue;
  }
  try {
    results.push({ gate: gate.name, status: "ran", findings: gate.run(ctx, config) ?? [] });
  } catch (e) {
    // A crashed gate is a failure. The alternative is a build that goes green
    // because the check threw before it could find anything.
    results.push({ gate: gate.name, status: "crashed", reason: e.message, findings: [] });
  }
}

// Fingerprint against the source line, for the baseline.
const byPath = new Map();
for (const f of [...ctx.source, ...ctx.markdown, ...ctx.addedSql]) byPath.set(f.path, f);
const lineTextOf = (f) => {
  const file = byPath.get(f.path);
  return file ? lines(file)[f.line - 1] ?? "" : "";
};

for (const r of results) r.findings = fingerprintAll(r.findings, lineTextOf);
let all = results.flatMap((r) => r.findings);

if (WRITE_BASELINE) {
  const baseline = createBaseline(all);
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
  process.stdout.write(
    `Wrote ${BASELINE_PATH}\n${baseline.count} existing finding` +
      `${baseline.count === 1 ? "" : "s"} recorded. They no longer block; anything new will.\n`
  );
  process.exit(0);
}

let grandfathered = [];
let stale = [];
if (!NO_BASELINE) {
  const baseline = loadJson(BASELINE_PATH, "bouncer.baseline.json");
  if (baseline) {
    const problem = validateBaseline(baseline);
    if (problem) fail(`bouncer.baseline.json: ${problem}`);
    const split = applyBaseline(all, baseline);
    all = split.blocking;
    grandfathered = split.grandfathered;
    stale = split.stale;
    const keep = new Set(all.map((f) => f.fp));
    for (const r of results) r.findings = r.findings.filter((f) => keep.has(f.fp));
  }
}

for (const r of results) {
  if (r.status !== "ran") continue;
  const errs = r.findings.filter((f) => f.severity === "error").length;
  r.status = errs ? "failed" : r.findings.length ? "warned" : "passed";
}

const errorCount = all.filter((f) => f.severity === "error").length;
const crashed = results.some((r) => r.status === "crashed");
const elapsed = Date.now() - started;

if (SARIF_OUT) process.stdout.write(JSON.stringify(sarif(all), null, 2) + "\n");
else if (JSON_OUT) {
  process.stdout.write(
    JSON.stringify(
      {
        version: VERSION,
        elapsedMs: elapsed,
        results,
        errorCount,
        grandfathered: grandfathered.length,
        stale,
        // Machine consumers need to know about a hole in the run just as much as
        // a human reading the terminal does, and more, since nobody is watching.
        unreadable: ctx.unreadable,
        excluded: ctx.excluded.length,
      },
      null,
      2
    ) + "\n"
  );
} else report();

process.exit(errorCount > 0 || crashed ? 1 : 0);

// ---------------------------------------------------------------- output

function sarif(findings) {
  const rules = [];
  const seen = new Set();
  for (const f of findings) {
    if (seen.has(f.rule)) continue;
    seen.add(f.rule);
    const gate = GATES.find((g) => f.rule.startsWith(g.name + "/"));
    rules.push({
      id: f.rule,
      name: f.rule,
      shortDescription: { text: gate?.title ?? f.rule },
      fullDescription: { text: gate?.summary ?? f.message },
      help: { text: f.fix ?? gate?.summary ?? f.message },
      defaultConfiguration: { level: f.severity === "error" ? "error" : "warning" },
    });
  }
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "Bouncer",
            version: VERSION,
            informationUri: "https://github.com/ajeermahmood/bouncer",
            rules,
          },
        },
        results: findings.map((f) => ({
          ruleId: f.rule,
          level: f.severity === "error" ? "error" : "warning",
          message: { text: f.fix ? `${f.message} ${f.fix}` : f.message },
          locations: [
            {
              physicalLocation: {
                artifactLocation: { uri: f.path.replace(/\\/g, "/") },
                region: { startLine: f.line },
              },
            },
          ],
          partialFingerprints: { bouncerFingerprint: f.fp },
        })),
      },
    ],
  };
}

function report() {
  const useColor = process.stdout.isTTY && !process.env.NO_COLOR && !flag("no-color");
  const paint = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  const red = paint(31);
  const yellow = paint(33);
  const green = paint(32);
  const dim = paint(2);
  const bold = paint(1);

  if (!QUIET) {
    const scope = ctx.changedCount === null ? "" : " (changed only)";
    process.stdout.write(
      `\n${bold("bouncer")} ${dim(
        `${ctx.source.length} source, ${ctx.markdown.length} markdown, ` +
          `${ctx.addedSql.length} new migrations${scope}`
      )}\n`
    );
    if (ctx.excluded.length) {
      const byPattern = new Map();
      for (const e of ctx.excluded) byPattern.set(e.pattern, (byPattern.get(e.pattern) ?? 0) + 1);
      const parts = [...byPattern].map(([p, n]) => `${p} (${n})`).join(", ");
      process.stdout.write(dim(`        ${ctx.excluded.length} files not scanned: ${parts}\n`));
    }
    if (grandfathered.length) {
      process.stdout.write(
        dim(`        ${grandfathered.length} grandfathered by bouncer.baseline.json\n`)
      );
    }
    // Printed in yellow rather than dim, because unlike an exclusion this was not
    // anybody's decision. A tracked source file the reader could not open is a
    // hole in the run, and a green result does not cover it.
    if (ctx.unreadable.length) {
      const byReason = new Map();
      for (const u of ctx.unreadable) byReason.set(u.reason, (byReason.get(u.reason) ?? 0) + 1);
      const parts = [...byReason].map(([r, n]) => `${n} ${r}`).join(", ");
      process.stdout.write(
        yellow(`        ${ctx.unreadable.length} file${ctx.unreadable.length === 1 ? "" : "s"} could not be read and ${ctx.unreadable.length === 1 ? "was" : "were"} NOT scanned: ${parts}\n`)
      );
      for (const u of ctx.unreadable.slice(0, 5)) {
        process.stdout.write(dim(`          ${u.path} (${u.reason})\n`));
      }
    }
    process.stdout.write("\n");
  }

  for (const r of results) {
    const gate = GATES.find((g) => g.name === r.gate);
    if (r.status === "passed") {
      if (!QUIET) process.stdout.write(`  ${green("pass")}  ${r.gate}\n`);
      continue;
    }
    if (r.status === "skipped") {
      if (!QUIET) process.stdout.write(`  ${dim("skip")}  ${r.gate} ${dim(`(${r.reason})`)}\n`);
      continue;
    }
    if (r.status === "crashed") {
      process.stdout.write(`  ${red("CRASH")} ${r.gate}: ${r.reason}\n`);
      continue;
    }

    const label = r.status === "failed" ? red("FAIL") : yellow("warn");
    process.stdout.write(`\n  ${label}  ${bold(r.gate)} ${dim(gate?.summary ?? "")}\n`);
    for (const f of r.findings) {
      const mark = f.severity === "error" ? red("x") : yellow("!");
      process.stdout.write(`\n    ${mark} ${bold(`${f.path}:${f.line}`)}  ${dim(f.rule)}\n`);
      process.stdout.write(`      ${f.message}\n`);
      if (f.fix) process.stdout.write(`      ${dim("fix: " + f.fix)}\n`);
    }
    process.stdout.write("\n");
  }

  if (stale.length && !QUIET) {
    process.stdout.write(
      dim(
        `\n  ${stale.length} baseline entr${stale.length === 1 ? "y is" : "ies are"} ` +
          `no longer found. Run --baseline-write to shrink the file.\n`
      )
    );
  }

  const warns = all.length - errorCount;
  if (errorCount) {
    process.stdout.write(
      `\n${red(`${errorCount} blocking ${errorCount === 1 ? "finding" : "findings"}`)}` +
        `${warns ? dim(`, ${warns} warning${warns === 1 ? "" : "s"}`) : ""} ${dim(`in ${elapsed}ms`)}\n` +
        dim(
          `Each one is either a real problem, or a place to write // bouncer-ok(<gate>): <why>.\n` +
            `The reason is required. That is what stops the escape hatch becoming a blanket ignore.\n`
        )
    );
  } else if (!QUIET) {
    process.stdout.write(
      `\n${green("All gates passed.")}` +
        `${warns ? dim(` ${warns} warning${warns === 1 ? "" : "s"}.`) : ""} ${dim(`${elapsed}ms`)}\n`
    );
  }
}
