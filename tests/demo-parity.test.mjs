import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { runDemoGates } from "../shared/demo-scan.mjs";
import { DEMO_SCOPE_CONFIG, UNAVAILABLE, MAX_SNIPPET_BYTES } from "../shared/demo-config.mjs";
import { DEFAULTS } from "../gates/scope.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

/**
 * The project's central claim is that one implementation of every rule runs in
 * four places. That was asserted in the README and tested nowhere.
 *
 * These tests pin the two halves of it: the shared scan behaves as expected, and
 * no hosted caller has quietly grown its own copy of the logic again.
 */

const SAMPLE = [
  "const a = db.raw.order.findMany();",
  "const minor = Math.round(parseFloat(price) * 100);",
  'const password = "hunter2hunter2";',
].join("\n");

describe("runDemoGates", () => {
  it("runs all three snippet-capable gates", () => {
    const { findings } = runDemoGates(SAMPLE);
    expect(findings.map((f) => f.rule)).toEqual([
      "scope/raw-client",
      "money/float-to-minor",
      "secrets/assigned-credential",
    ]);
  });

  it("sorts by line, then deterministically by rule", () => {
    // Two findings on one line must not swap order between runs, or a caller
    // diffing responses sees phantom changes.
    const twice = [runDemoGates(SAMPLE).findings, runDemoGates(SAMPLE).findings];
    expect(twice[0]).toEqual(twice[1]);
    const linesAsc = runDemoGates(SAMPLE).findings.map((f) => f.line);
    expect(linesAsc).toEqual([...linesAsc].sort((a, b) => a - b));
  });

  it("always names the gates that could not run", () => {
    // Including for empty input, which is the response a freshly loaded page gets.
    expect(runDemoGates("").unavailable).toEqual(UNAVAILABLE);
    expect(runDemoGates(SAMPLE).unavailable.map((u) => u.gate)).toEqual([
      "migration-safety",
      "doc-links",
    ]);
  });

  it("returns nothing and crashes nothing on empty input", () => {
    const r = runDemoGates("");
    expect(r.findings).toEqual([]);
    expect(r.crashed).toEqual([]);
  });

  it("treats the filename as the scanned path", () => {
    const { findings } = runDemoGates('const password = "hunter2hunter2";', "deploy.ts");
    expect(findings[0].path).toBe("deploy.ts");
  });

  it("exposes a frozen config, so one caller cannot mutate another", () => {
    expect(Object.isFrozen(DEMO_SCOPE_CONFIG)).toBe(true);
    expect(Object.isFrozen(UNAVAILABLE)).toBe(true);
    expect(MAX_SNIPPET_BYTES).toBe(64 * 1024);
  });
});

describe("no hosted caller reimplements the scan", () => {
  const callers = [
    "worker/index.js",
    "functions/api/scan.js",
    "server/index.mjs",
    "src/components/Playground.tsx",
  ];

  const tracked = new Set(
    execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 6e7 })
      .split("\n")
      .map((s) => s.trim())
  );

  it.each(callers)("%s goes through runDemoGates", (file) => {
    expect(tracked.has(file)).toBe(true);
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).toContain("runDemoGates");
  });

  it.each(callers)("%s does not import the gates directly", (file) => {
    // Importing a gate here is how the shared loop gets bypassed and the
    // runtimes start drifting again. Each of these files had its own copy of the
    // try/catch and the sort before this was factored out.
    const text = readFileSync(join(ROOT, file), "utf8");
    expect(text).not.toMatch(/from "[./]*gates\/(?:secrets|scope|money)\.mjs"/);
  });
});

describe("the demo config keeps up with the gates", () => {
  it("demonstrates the scope check that applies without a scoped client", () => {
    // Direct-client mode landed in the gate in 0.3.0 and was not added here, so
    // for two releases the public playground answered "nothing wrong" to the
    // single most likely thing a visitor would paste. The gate was right; the
    // demo was misconfigured, which is worse, because the visitor concludes the
    // tool is weak and leaves.
    const { findings } = runDemoGates('const a = await prisma.order.findMany({ where: { status: "paid" } });');
    expect(findings.map((f) => f.rule)).toContain("scope/unscoped-query");
  });

  it("stays quiet when the pasted query is properly scoped", () => {
    const { findings } = runDemoGates(
      'const a = await prisma.order.findMany({ where: { tenantId, status: "paid" } });'
    );
    expect(findings).toHaveLength(0);
  });

  it("exercises every configurable key the scope gate reads", () => {
    // A cheap guard against the same drift happening again: if the gate grows a
    // new configurable behaviour, this fails until the demo config decides
    // whether to show it off.
    const configurable = Object.keys(DEFAULTS).filter((k) => k !== "queryMethods" && k !== "rawSqlCalls");
    for (const key of configurable) {
      expect(Object.keys(DEMO_SCOPE_CONFIG)).toContain(key);
    }
  });
});
