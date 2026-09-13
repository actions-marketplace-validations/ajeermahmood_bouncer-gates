#!/usr/bin/env node
/**
 * The CLI. Argument parsing, printing and exit codes live here; the scan itself
 * is `bin/lib/run.mjs`, shared with the MCP server and the editor hook.
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
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { GATES } from "../gates/index.mjs";
import { createBaseline } from "../gates/lib/baseline.mjs";
import { prismaTenantModels, detectTenantColumn, repoUrlFromRemote } from "../gates/lib/prisma.mjs";
import { runGates, toJson, RunnerError, VERSION, git, read } from "./lib/run.mjs";
import { recordUse, NOTICE } from "./lib/telemetry.mjs";

const HELP = `bouncer ${VERSION}
CI gates that let anyone, or any agent, contribute without being able to break things.

  bouncer                          run every gate over the whole repository
  bouncer --init                   write a starter bouncer.config.json
  bouncer --init-agents            wire Bouncer into Claude Code and Cursor for this repo
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
  --mcp              serve the gates over MCP on stdin/stdout, for an agentic editor
  --hook             read an editor hook event on stdin, scan the file it names, exit 2 on findings
  --version, --help

Telemetry: one anonymous ping a day. BOUNCER_TELEMETRY=0 turns it off. See docs/telemetry.md.
`;

const argv = process.argv.slice(2);

const KNOWN_FLAGS = new Set([
  "init",
  "init-agents",
  "changed",
  "baseline-write",
  "no-baseline",
  "json",
  "sarif",
  "quiet",
  "help",
  "version",
  "no-color",
  "mcp",
  "hook",
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
const BASE = value("base", process.env.BOUNCER_BASE_REF || "origin/main");
const ROOT = resolve(value("root", process.cwd()));
const EXPLAIN = value("explain", "");

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

/**
 * The usage ping, after the work is done and never in the way of it.
 *
 * The first-run notice goes to stderr so it cannot corrupt --json or --sarif
 * output, and it is printed once, when the id file is created.
 */
async function ping(runtime) {
  const r = await recordUse(runtime, VERSION).catch(() => ({ notice: false }));
  if (r.notice && runtime === "cli") process.stderr.write("\n" + NOTICE);
}

// ---------------------------------------------------------------- mcp / hook

if (flag("mcp")) {
  const { serve } = await import("./lib/mcp.mjs");
  serve({ root: ROOT, base: BASE_GIVEN ? BASE : "" });
  ping("mcp");
} else if (flag("hook")) {
  const { hook } = await import("./lib/agents.mjs");
  // Run by hand with nothing piped in, this would sit waiting for stdin
  // forever and look hung. Say what it expects instead.
  if (process.stdin.isTTY) {
    fail("--hook reads a hook event as JSON on stdin, for example: echo '{\"file_path\":\"src/a.ts\"}' | bouncer --hook");
  }
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const { code, message } = hook(Buffer.concat(chunks).toString("utf8"), {
    root: ROOT,
    base: BASE_GIVEN ? BASE : "",
  });
  if (message) process.stderr.write(message);
  await ping("hook");
  process.exit(code);
} else if (flag("init-agents")) {
  const { initAgents } = await import("./lib/agents.mjs");
  try {
    process.stdout.write("Wired Bouncer into the agentic editors for this repository\n\n" + initAgents(ROOT).join("\n"));
  } catch (e) {
    if (e instanceof RunnerError) fail(e.message);
    throw e;
  }
  process.exit(0);
} else if (EXPLAIN) {
  explain();
} else if (flag("init")) {
  init();
} else {
  await main();
}

// ---------------------------------------------------------------- explain

function explain() {
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
function init() {
  const target = join(ROOT, "bouncer.config.json");
  if (existsSync(target)) {
    fail("bouncer.config.json already exists. Edit it, or delete it and run --init again.");
  }
  const tracked = git(ROOT, ["ls-files"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const schemas = [];
  for (const schemaPath of tracked.filter((p) => /\.prisma$/i.test(p))) {
    const r = read(ROOT, schemaPath);
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
  const repoUrl = repoUrlFromRemote(git(ROOT, ["remote", "get-url", "origin"]));
  if (repoUrl) config["doc-links"] = { repoUrl };

  writeFileSync(target, JSON.stringify(config, null, 2) + "\n");

  const lines = ["Wrote bouncer.config.json", ""];
  if (found.length) {
    const names = [...new Set(found.map((m) => m.schemaPath))].join(", ");
    lines.push(
      "  scope: " +
        found.length +
        " tenant-owned model" +
        (found.length === 1 ? "" : "s") +
        " found in " +
        names +
        ' (every model with a "' +
        column +
        '" field, the owner column used most): ' +
        found.map((m) => m.model).join(", "),
      '         "clients" is set to ["prisma"], so plain prisma.<model> queries are checked',
      '         for the tenant column. If you have a scoped wrapper, set "rawAccessor" to its',
      '         raw client name and empty "clients" instead.'
    );
  } else {
    lines.push(
      '  scope: no Prisma schema with a "' + column + '" field was found, so the scope gate',
      '         will report skipped until you list your tenant-owned models under "scope".'
    );
  }
  if (repoUrl) lines.push("  doc-links: absolute links back to " + repoUrl + " will be checked too");
  lines.push(
    "",
    "Next:",
    "  npx bouncer-gates                    see what it finds",
    "  npx bouncer-gates --init-agents      run the same gates inside Claude Code and Cursor",
    "  npx bouncer-gates --baseline-write   if there is existing debt, record it so only new problems block",
    "  npx bouncer-gates --explain scope    what a gate checks and how to excuse one case",
    ""
  );
  process.stdout.write(lines.join("\n"));
  process.exit(0);
}

// ---------------------------------------------------------------- run

async function main() {
  let run;
  try {
    run = runGates({
      root: ROOT,
      base: BASE,
      baseGiven: BASE_GIVEN,
      changed: CHANGED,
      only: ONLY,
      // --baseline-write wants every finding, including the ones a previous
      // baseline hides, or the new file would silently drop them.
      noBaseline: NO_BASELINE || WRITE_BASELINE,
    });
  } catch (e) {
    if (e instanceof RunnerError) fail(e.message);
    throw e;
  }

  if (WRITE_BASELINE) {
    const baseline = createBaseline(run.all);
    writeFileSync(run.baselinePath, JSON.stringify(baseline, null, 2) + "\n");
    process.stdout.write(
      `Wrote ${run.baselinePath}\n${baseline.count} existing finding` +
        `${baseline.count === 1 ? "" : "s"} recorded. They no longer block; anything new will.\n`
    );
    process.exit(0);
  }

  if (SARIF_OUT) process.stdout.write(JSON.stringify(sarif(run.all), null, 2) + "\n");
  else if (JSON_OUT) process.stdout.write(JSON.stringify(toJson(run), null, 2) + "\n");
  else report(run);

  await ping("cli");
  process.exit(run.errorCount > 0 || run.crashed ? 1 : 0);
}

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

function report(run) {
  const { ctx, results, all, grandfathered, stale, errorCount, elapsedMs: elapsed } = run;
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
