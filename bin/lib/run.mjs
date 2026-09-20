/**
 * The scan, as a function.
 *
 * Everything that reads the world lives here: git, the filesystem, the config,
 * the baseline. The gates stay pure. What used to be the body of the CLI is now
 * something three callers share:
 *
 *   bin/bouncer-gates.mjs            the CLI, which prints and picks an exit code
 *   bin/bouncer-gates.mjs --mcp      the MCP server an agentic editor talks to
 *   bin/bouncer-gates.mjs --hook     the post-edit hook Claude Code and friends run
 *
 * The same rule that made the hosted demos share `runDemoGates` applies here.
 * The moment the hook grew its own copy of the gate loop it would have been the
 * one caller without the try/catch, and a rule that threw inside an editor would
 * have read as clean.
 *
 * Nothing here calls process.exit or prints. A caller that cannot proceed gets a
 * RunnerError with a message written for a person, and decides what to do.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, isAbsolute, relative } from "node:path";
import { GATES } from "../../gates/index.mjs";
import { lines } from "../../gates/lib/finding.mjs";
import { globToRe } from "../../gates/lib/glob.mjs";
import { fingerprintAll, applyBaseline, validateBaseline } from "../../gates/lib/baseline.mjs";

/**
 * Read from package.json rather than written down here.
 *
 * This was a second source of truth and it had already drifted: package.json
 * said 0.4.1 while this still said 0.4.0, so `--version`, the SARIF driver
 * version and the MCP handshake all reported a release that was two behind.
 * Nothing failed, which is why nobody noticed. package.json ships inside the
 * npm package, so this resolves for an installed copy too.
 */
export const VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
).version;

/** The runner could not do its job. Maps to exit 2 in the CLI. */
export class RunnerError extends Error {}

// Committed .env files are scanned on purpose. Git only lists what is tracked,
// so a .env that appears here is one somebody committed, which is the mistake
// the secrets gate most wants to see.
export const SOURCE_EXT =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|astro|vue|svelte|py|go|rb|php|sh|ya?ml|json|env|sql|tf)$|(?:^|\/)\.env(?:\.[\w.-]+)?$/i;
const TEXT_MAX = 512 * 1024;

export function git(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return "";
  }
}

export function loadJson(path, label) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RunnerError(`${label} is not valid JSON: ${e.message}`);
  }
}

/**
 * Read a file, or say why not.
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
export function read(root, path) {
  let buf;
  try {
    buf = readFileSync(join(root, path));
  } catch (e) {
    return { reason: e.code === "ENOENT" ? "not on disk" : "unreadable" };
  }
  if (buf.length > TEXT_MAX) return { reason: "larger than 512KB" };
  if (buf.includes(0)) return { reason: "binary" };
  return { text: buf.toString("utf8") };
}

/**
 * A path as git would print it: relative to the root, forward slashes.
 * Returns "" for a path outside the repository, including one on another
 * drive on Windows, where relative() gives back an absolute path rather than
 * a "../" prefix.
 */
export function repoPath(root, p) {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs).replace(/\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return "";
  return rel;
}

/**
 * Resolve the base ref once. Returns the merge-base commit and the ref that
 * worked; an empty commit means history is not available here.
 *
 * When nobody chose a base, the usual names are tried in order. A developer
 * running this for the first time on a laptop, in a repository whose default
 * branch is `master` or that has no remote yet, should see the migration gate
 * run rather than a skip message about a branch they never mentioned. An
 * explicit base is never second-guessed.
 */
function resolveBase(root, base, baseGiven) {
  const candidates = baseGiven ? [base] : [base, "origin/master", "main", "master"];
  for (const ref of candidates) {
    if (!git(root, ["rev-parse", "--verify", "--quiet", ref]).trim()) continue;
    return { mergeBase: git(root, ["merge-base", ref, "HEAD"]).trim(), ref };
  }
  return { mergeBase: "", ref: base };
}

/**
 * @typedef {object} RunOptions
 * @property {string} root            repository root
 * @property {string} [base]          ref that "changed" and "new" are measured against
 * @property {boolean} [baseGiven]    the caller chose the base, so do not try others
 * @property {boolean} [changed]      only files that differ from the base
 * @property {string[]} [only]        gate names to run
 * @property {string[]} [paths]       only these files, tracked or not. For an editor
 *                                    hook scanning the file that was just written.
 * @property {boolean} [noBaseline]   ignore bouncer-gates.baseline.json
 * @property {object} [config]        parsed bouncer-gates.config.json; read from root if absent
 * @property {{path: string, text: string}[]} [snippets]
 *                                    in-memory files, scanned with the repository's
 *                                    config. For an agent asking about code it has
 *                                    not written to disk yet.
 */

function buildContext(opts, gates, config) {
  const { root } = opts;
  const needed = new Set(gates.flatMap((g) => g.needs));
  let tracked = git(root, ["ls-files"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const snippets = new Map(
    (opts.snippets ?? []).map((f) => [repoPath(root, f.path) || "snippet.ts", f.text])
  );
  const readAny = (path) => (snippets.has(path) ? { text: snippets.get(path) } : read(root, path));

  if (!tracked.length && !snippets.size) {
    throw new RunnerError(
      `no tracked files found in ${root}.\n` +
        `bouncer-gates reads the file list from git, so it runs on what is committed rather ` +
        `than whatever is lying in the directory. Run it inside a git repository.`
    );
  }

  const base = opts.base || "origin/main";
  const { mergeBase, ref } =
    needed.has("addedSql") || opts.changed ? resolveBase(root, base, opts.baseGiven) : { mergeBase: "", ref: base };

  // Excluded paths.
  //
  // A repository of gates necessarily contains the patterns those gates look
  // for: test fixtures and playground examples are hardcoded secrets and
  // cross-tenant queries on purpose. So exclusion has to exist.
  //
  // What matters is that it is loud. These are declared in bouncer-gates.config.json,
  // never inferred, and the runner prints how many files each pattern removed on
  // every run. An exclude list that silently grows to cover half the codebase is
  // the most likely way a setup like this rots.
  //
  // This removes a FILE from scanning. It is not a way to switch a rule off
  // across the repo; that is the per-line escape hatch, and it demands a reason.
  const patterns = Array.isArray(config.exclude) ? config.exclude : [];
  const excludeRes = patterns.map((p) => ({ pattern: p, re: globToRe(p) }));
  const excluded = [];
  const excludedSeen = new Set();
  const isExcluded = (path) => {
    const hit = excludeRes.find((r) => r.re.test(path));
    // A path can be checked twice, once from the tracked list and once as an
    // explicit path from an editor. The count the runner prints must not
    // double it.
    if (hit && !excludedSeen.has(path)) {
      excludedSeen.add(path);
      excluded.push({ path, pattern: hit.pattern });
    }
    return Boolean(hit);
  };
  const allTracked = tracked;
  tracked = tracked.filter((p) => !isExcluded(p));

  // --changed narrows the scan to this branch's own work. On a large repository
  // that is the difference between a check people run and one they wait for.
  //
  // If the base ref is missing (a shallow CI clone), this does NOT quietly fall
  // back to scanning everything or nothing. Scanning everything would be a
  // surprise timeout; scanning nothing would pass for the wrong reason. It stops
  // and says so, which is the same rule the gates themselves follow.
  let changedSet = null;
  if (opts.changed) {
    if (!mergeBase) {
      throw new RunnerError(
        `--changed needs the base ref "${ref}", which is not in this clone.\n` +
          `In GitHub Actions add "fetch-depth: 0" to actions/checkout, or pass --base.`
      );
    }
    const names = git(root, ["diff", "--name-only", "--diff-filter=ACMR", mergeBase, "HEAD"]);
    changedSet = new Set(
      names
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  // Explicit paths come from an editor, and the file an agent just wrote is
  // usually not tracked yet. So these are read from disk whether or not git
  // knows them, and the exclude list still applies.
  let toScan = tracked;
  if (opts.paths || snippets.size) {
    const trackedSet = new Set(allTracked);
    toScan = [];
    for (const p of opts.paths ?? []) {
      const rel = repoPath(root, p);
      if (!rel) continue;
      if (!trackedSet.has(rel) && !existsSync(join(root, rel))) continue;
      if (isExcluded(rel)) continue;
      toScan.push(rel);
    }
    for (const rel of snippets.keys()) if (!isExcluded(rel)) toScan.push(rel);
  }

  const ctx = {
    source: [],
    markdown: [],
    // repoFiles keeps excluded and unchanged paths. A link to a test fixture is
    // still a link to a file that exists, and doc-links would call it broken.
    repoFiles: new Set([...allTracked, ...toScan]),
    addedSql: [],
    excluded,
    unreadable: [],
    changedCount: changedSet ? changedSet.size : null,
    scannedPaths: opts.paths || snippets.size ? toScan : null,
    // A file handed over by an editor is new by definition, so the migration
    // gate can answer even in a clone with no base ref.
    baseAvailable: Boolean(mergeBase) || Boolean(opts.paths || snippets.size),
    baseRef: ref,
  };

  if (needed.has("source") || needed.has("markdown")) {
    for (const path of toScan) {
      if (changedSet && !changedSet.has(path)) continue;
      const isMd = /\.mdx?$/i.test(path);
      if (!isMd && !SOURCE_EXT.test(path)) continue;
      const r = readAny(path);
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

  if (needed.has("addedSql") && (mergeBase || opts.paths || snippets.size)) {
    const out = mergeBase ? git(root, ["diff", "--name-only", "--diff-filter=A", mergeBase, "HEAD"]) : "";
    let added = out
      .split("\n")
      .map((s) => s.trim())
      .filter((p) => p && /\.sql$/i.test(p));
    // An editor asking about one file wants an answer about that file. A .sql
    // that is not yet committed cannot be "added relative to the base" in git's
    // eyes, so it is treated as new: the only honest reading of a migration
    // somebody is writing right now.
    if (opts.paths || snippets.size) {
      const addedSet = new Set(added);
      const trackedSet = new Set(allTracked);
      added = toScan.filter((p) => /\.sql$/i.test(p) && (addedSet.has(p) || !trackedSet.has(p)));
    }
    ctx.addedSql = added.map((path) => {
      const r = readAny(path);
      if (r.reason) ctx.unreadable.push({ path, reason: r.reason });
      return { path, text: r.text ?? "" };
    });
  }

  return ctx;
}

/**
 * Run the gates. Never prints, never exits.
 *
 * @param {RunOptions} opts
 */
export function runGates(opts) {
  const root = resolve(opts.root ?? process.cwd());
  const config = opts.config ?? loadJson(join(root, "bouncer-gates.config.json"), "bouncer-gates.config.json") ?? {};
  const only = opts.only ?? [];
  const selected = only.length ? GATES.filter((g) => only.includes(g.name)) : GATES;
  if (only.length) {
    const unknown = only.filter((n) => !GATES.some((g) => g.name === n));
    if (unknown.length) {
      throw new RunnerError(
        `unknown gate(s): ${unknown.join(", ")}. Available: ${GATES.map((g) => g.name).join(", ")}`
      );
    }
  }

  const started = Date.now();
  const ctx = buildContext({ ...opts, root }, selected, config);
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

  let grandfathered = [];
  let stale = [];
  const baselinePath = join(root, "bouncer-gates.baseline.json");
  if (!opts.noBaseline) {
    const baseline = loadJson(baselinePath, "bouncer-gates.baseline.json");
    if (baseline) {
      const problem = validateBaseline(baseline);
      if (problem) throw new RunnerError(`bouncer-gates.baseline.json: ${problem}`);
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

  return {
    version: VERSION,
    root,
    config,
    ctx,
    results,
    all,
    grandfathered,
    stale,
    errorCount,
    crashed,
    baselinePath,
    elapsedMs: Date.now() - started,
  };
}

/** The JSON document `--json` prints and the MCP server returns. */
export function toJson(run) {
  return {
    version: run.version,
    elapsedMs: run.elapsedMs,
    results: run.results,
    errorCount: run.errorCount,
    grandfathered: run.grandfathered.length,
    stale: run.stale,
    // Machine consumers need to know about a hole in the run just as much as
    // a human reading the terminal does, and more, since nobody is watching.
    unreadable: run.ctx.unreadable,
    excluded: run.ctx.excluded.length,
  };
}

/**
 * Findings and skips as short text, for an agent or a hook.
 *
 * Written for a reader who will act on it immediately and has never seen this
 * tool. Every finding says where, what and what to do; every skip says why the
 * gate could not answer, because "no findings" and "did not look" must never
 * read the same, even inside an editor.
 */
export function toText(run, { header = true } = {}) {
  const out = [];
  const shown = run.results.filter((r) => r.findings.length || r.status === "crashed");
  if (header) {
    if (run.errorCount || run.crashed) {
      out.push(
        `bouncer-gates found ${run.errorCount} blocking finding${run.errorCount === 1 ? "" : "s"}` +
          (run.crashed ? " and a gate crashed" : "") +
          ". Fix each one, or if it is deliberate, add a comment on that line or the line above:"
      );
      out.push("  // bouncer-gates-ok(<gate>): <why this is fine here>");
      out.push("The reason is required. A bare marker suppresses nothing.");
    } else if (run.all.length) {
      out.push(`bouncer-gates has ${run.all.length} warning${run.all.length === 1 ? "" : "s"}. None blocks a merge.`);
    } else {
      out.push("bouncer-gates found nothing.");
    }
  }
  for (const r of shown) {
    if (r.status === "crashed") {
      out.push(`\nCRASH ${r.gate}: ${r.reason}. Treat this as a failure, not a pass.`);
      continue;
    }
    for (const f of r.findings) {
      out.push(`\n${f.severity === "error" ? "x" : "!"} ${f.path}:${f.line}  ${f.rule}`);
      out.push(`  ${f.message}`);
      if (f.fix) out.push(`  fix: ${f.fix}`);
    }
  }
  const skipped = run.results.filter((r) => r.status === "skipped");
  if (skipped.length) {
    out.push("");
    for (const s of skipped) out.push(`skip ${s.gate}: ${s.reason}`);
  }
  if (run.ctx.unreadable.length) {
    out.push("");
    out.push(
      `${run.ctx.unreadable.length} file${run.ctx.unreadable.length === 1 ? " was" : "s were"} NOT scanned: ` +
        run.ctx.unreadable.map((u) => `${u.path} (${u.reason})`).join(", ")
    );
  }
  return out.join("\n") + "\n";
}
