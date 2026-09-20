import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { globToRe } from "../gates/lib/glob.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8", maxBuffer: 6e7 })
  .split("\n")
  .map((s) => s.trim())
  .filter(Boolean);

const SOURCE = /\.(?:m?[jt]sx?|astro|json|md|scss|ya?ml|toml)$/i;

describe("repository health", () => {
  it("has no source file the tool would skip as binary", () => {
    // This is a regression test for a bug the tool had for several releases.
    //
    // `gates/lib/finding.mjs` used raw NUL bytes as fingerprint separators. The
    // runtime behaviour was fine, but the file was then binary, and the runner
    // skips binary files, so the core library was silently never scanned by any
    // gate. Nothing in the output suggested it.
    //
    // A control character in source is almost always accidental, and this is the
    // cheapest possible way to never let it happen quietly again.
    const binary = [];
    for (const path of tracked) {
      if (!SOURCE.test(path)) continue;
      const buf = readFileSync(join(ROOT, path));
      if (buf.includes(0)) binary.push(path);
    }
    expect(binary).toEqual([]);
  });

  it("does not duplicate the demo scope config", () => {
    // The gate logic was correctly shared across four runtimes while the gate
    // CONFIG was copy-pasted into five of them, which is the same drift this
    // project argues against, sitting inside the project. One definition only.
    const offenders = tracked.filter((path) => {
      if (!SOURCE.test(path)) return false;
      if (path === "shared/demo-config.mjs" || path.startsWith("tests/")) return false;
      const buf = readFileSync(join(ROOT, path));
      if (buf.includes(0)) return false;
      return buf.toString("utf8").includes('models: ["order", "customer", "invoice"');
    });
    expect(offenders).toEqual([]);
  });
});

describe("globToRe", () => {
  // Lives in gates/lib so it can be tested at all. It used to be exported from
  // bin/bouncer-gates.mjs, which runs the entire CLI at import time, so importing it
  // to test it would have executed a scan and called process.exit.
  const matches = (pattern, path) => globToRe(pattern).test(path);

  it("matches a single star within one segment only", () => {
    expect(matches("src/*.ts", "src/a.ts")).toBe(true);
    expect(matches("src/*.ts", "src/deep/a.ts")).toBe(false);
  });

  it("spans directories with a double star", () => {
    expect(matches("tests/**", "tests/a.mjs")).toBe(true);
    expect(matches("tests/**", "tests/deep/nested/a.mjs")).toBe(true);
  });

  it("treats docs/**/x as also matching docs/x", () => {
    expect(matches("docs/**/x.md", "docs/x.md")).toBe(true);
    expect(matches("docs/**/x.md", "docs/a/b/x.md")).toBe(true);
  });

  it("escapes regex metacharacters in a literal path", () => {
    expect(matches("a.b/c+d.ts", "a.b/c+d.ts")).toBe(true);
    expect(matches("a.b/c+d.ts", "axb/c+d.ts")).toBe(false);
  });

  it("anchors, so a pattern does not match a longer path", () => {
    expect(matches("src/a.ts", "other/src/a.ts")).toBe(false);
    expect(matches("src/a.ts", "src/a.ts.bak")).toBe(false);
  });

  it("supports ? as a single non-slash character", () => {
    expect(matches("a?.ts", "ab.ts")).toBe(true);
    expect(matches("a?.ts", "a/.ts")).toBe(false);
  });
});

describe("telemetry transport", () => {
  const source = readFileSync(join(ROOT, "bin/lib/telemetry.mjs"), "utf8");

  it("does not send the ping with fetch", () => {
    // Node's fetch is undici, which keeps the socket pooled after the response.
    // The runner calls process.exit() straight after the ping, and tearing that
    // pooled handle down mid-close trips a libuv assertion on Windows:
    //
    //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c
    //
    // The scan had already finished and printed correctly, so the tool looked
    // like it crashed at the end of a successful run. Only on a FIRST run,
    // because the daily throttle silences later ones, which is precisely the
    // run where somebody is deciding whether to trust this thing.
    //
    // `node:https` with `agent: false` gives the request its own socket and
    // closes it with the response. Do not put fetch back.
    expect(source).not.toMatch(/globalThis\.fetch/);
    expect(source).toMatch(/from "node:https"/);
    expect(source).toMatch(/agent:\s*false/);
  });

  it("still lets a test inject its own transport", () => {
    // The deps.fetch hook is how every other telemetry test drives this
    // without touching the network, so it has to survive the change above.
    expect(source).toMatch(/deps\.fetch/);
  });
});

describe("one version, not three", () => {
  it("reports package.json's version from the CLI, SARIF and MCP", async () => {
    // These used to be two constants. package.json said 0.4.1 while
    // bin/lib/run.mjs still said 0.4.0, so --version, the SARIF driver version
    // and the MCP handshake all claimed a release two behind. Nothing failed,
    // which is exactly why it went unnoticed for two releases.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const { VERSION } = await import("../bin/lib/run.mjs");
    expect(VERSION).toBe(pkg.version);
  });

  it("keeps server.json in step with package.json", () => {
    // The MCP registry listing names a version and an npm version. If either
    // drifts, the listing points at a package that does not exist yet.
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const server = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));
    expect(server.version).toBe(pkg.version);
    expect(server.packages[0].version).toBe(pkg.version);
    expect(server.packages[0].identifier).toBe(pkg.name);
    // The registry verifies ownership by matching this against the package.
    expect(server.name).toBe(pkg.mcpName);
  });
});
