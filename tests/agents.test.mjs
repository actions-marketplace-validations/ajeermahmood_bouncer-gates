import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runGates, toText, RunnerError } from "../bin/lib/run.mjs";
import { handleMessage, callTool, INSTRUCTIONS } from "../bin/lib/mcp.mjs";
import { hook, pathsFromEvent, initAgents } from "../bin/lib/agents.mjs";
import { recordUse, telemetryDisabled, NOTICE } from "../bin/lib/telemetry.mjs";

/**
 * The runner as a library, the MCP server, the editor hook and the usage ping.
 *
 * The property under test throughout is the same one the CLI has: the answer
 * "nothing found" must only ever come from having looked. An editor that gets
 * an empty result because the runner threw, or because the file was silently
 * out of scope, would teach the model that the code is fine.
 */

let root;
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "bouncer-gates-agents-"));
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "clean.ts"), "export const ok = 1;\n");
  writeFileSync(
    join(root, "bouncer-gates.config.json"),
    JSON.stringify({
      exclude: ["fixtures/**"],
      scope: { models: ["order"], tables: ["orders"], column: "tenantId", clients: ["prisma"] },
    })
  );
  git("add", ".");
  git("commit", "-qm", "init");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const LEAK = 'const password = "hunter2hunter2";\n';

describe("runGates with explicit paths", () => {
  it("scans a file git does not track yet", () => {
    writeFileSync(join(root, "src", "new.ts"), LEAK);
    const run = runGates({ root, paths: ["src/new.ts"] });
    expect(run.all.map((f) => f.rule)).toEqual(["secrets/assigned-credential"]);
    expect(run.ctx.scannedPaths).toEqual(["src/new.ts"]);
  });

  it("accepts an absolute path and reports it repository-relative", () => {
    const run = runGates({ root, paths: [join(root, "src", "new.ts")] });
    expect(run.all[0].path).toBe("src/new.ts");
  });

  it("still honours the exclude list", () => {
    mkdirSync(join(root, "fixtures"), { recursive: true });
    writeFileSync(join(root, "fixtures", "leak.ts"), LEAK);
    const run = runGates({ root, paths: ["fixtures/leak.ts"] });
    expect(run.all).toEqual([]);
    expect(run.ctx.excluded.map((e) => e.path)).toContain("fixtures/leak.ts");
  });

  it("treats an uncommitted .sql as a new migration, even with no base ref", () => {
    // A shallow clone has no base, so the CLI skips migration-safety with a
    // reason. An editor handing over the migration being written right now is
    // a different situation: that file is new by definition.
    writeFileSync(join(root, "001.sql"), "ALTER TABLE orders DROP COLUMN total;\n");
    const run = runGates({ root, paths: ["001.sql"] });
    const m = run.results.find((r) => r.gate === "migration-safety");
    expect(m.status).toBe("failed");
    expect(m.findings[0].rule).toBe("migration/drop-column");
  });

  it("scans an in-memory snippet with the repository config", () => {
    const run = runGates({
      root,
      snippets: [{ path: "src/orders.ts", text: 'prisma.order.findMany({ where: { status: "paid" } });\n' }],
    });
    expect(run.all.map((f) => f.rule)).toEqual(["scope/unscoped-query"]);
    expect(run.all[0].path).toBe("src/orders.ts");
  });

  it("names an unknown gate rather than running nothing", () => {
    expect(() => runGates({ root, only: ["scoep"] })).toThrow(RunnerError);
  });
});

describe("toText", () => {
  it("says a skipped gate did not look, next to the findings", () => {
    const run = runGates({ root, paths: ["src/new.ts"], config: {} });
    const text = toText(run);
    expect(text).toContain("x src/new.ts:1  secrets/assigned-credential");
    expect(text).toContain("fix:");
    expect(text).toContain("skip scope: no tenant-owned models configured");
  });

  it("never quotes the matched text", () => {
    const run = runGates({ root, paths: ["src/new.ts"] });
    expect(toText(run)).not.toContain("hunter2");
  });
});

describe("MCP server", () => {
  const opts = () => ({ root, base: "" });

  it("answers initialize with the client's protocol version and instructions", () => {
    const res = handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } },
      opts()
    );
    expect(res.result.protocolVersion).toBe("2024-11-05");
    expect(res.result.serverInfo.name).toBe("bouncer-gates");
    expect(res.result.instructions).toBe(INSTRUCTIONS);
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it("falls back to the newest protocol version it knows", () => {
    const res = handleMessage(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
      opts()
    );
    expect(res.result.protocolVersion).toBe("2025-06-18");
  });

  it("returns nothing for notifications", () => {
    expect(handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, opts())).toBeNull();
  });

  it("lists four tools with schemas", () => {
    const res = handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" }, opts());
    expect(res.result.tools.map((t) => t.name)).toEqual([
      "bouncer_gates_scan",
      "bouncer_gates_scan_snippet",
      "bouncer_gates_explain",
      "bouncer_gates_list_gates",
    ]);
    for (const t of res.result.tools) expect(t.inputSchema.type).toBe("object");
  });

  it("rejects an unknown method", () => {
    const res = handleMessage({ jsonrpc: "2.0", id: 3, method: "resources/list" }, opts());
    expect(res.error.code).toBe(-32601);
  });

  it("scans named paths and returns structured findings", () => {
    const r = callTool("bouncer_gates_scan", { paths: ["src/new.ts"] }, opts());
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("secrets/assigned-credential");
    expect(r.structuredContent.results.find((x) => x.gate === "secrets").findings).toHaveLength(1);
  });

  it("scans a snippet", () => {
    const r = callTool("bouncer_gates_scan_snippet", { filename: "x.ts", code: LEAK }, opts());
    expect(r.content[0].text).toContain("x x.ts:1");
  });

  it("explains a gate with the acknowledgement syntax", () => {
    const r = callTool("bouncer_gates_explain", { gate: "scope" }, opts());
    expect(r.content[0].text).toContain("bouncer-gates-ok(scope):");
  });

  it("reports a runner failure as an error, never as no findings", () => {
    const r = callTool("bouncer_gates_scan", { only: ["nope"] }, opts());
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain("nothing was checked");
  });

  it("reports a wrong tool name as an error", () => {
    expect(callTool("bouncer_gates_delete_everything", {}, opts()).isError).toBe(true);
  });
});

describe("editor hook", () => {
  it("reads Claude Code, Cursor and generic event shapes", () => {
    expect(pathsFromEvent({ tool_name: "Write", tool_input: { file_path: "a.ts" } })).toEqual(["a.ts"]);
    expect(pathsFromEvent({ file_path: "b.ts" })).toEqual(["b.ts"]);
    expect(pathsFromEvent({ files: ["c.ts", { path: "d.ts" }] })).toEqual(["c.ts", "d.ts"]);
    expect(pathsFromEvent({ paths: ["e.ts"] })).toEqual(["e.ts"]);
    expect(pathsFromEvent({ tool_input: { edits: [{ file_path: "f.ts" }] } })).toEqual(["f.ts"]);
    expect(pathsFromEvent(null)).toEqual([]);
    expect(pathsFromEvent("nope")).toEqual([]);
  });

  it("exits 2 with the findings on a blocking file", () => {
    const r = hook(JSON.stringify({ tool_input: { file_path: join(root, "src", "new.ts") } }), { root });
    expect(r.code).toBe(2);
    expect(r.message).toContain("secrets/assigned-credential");
    expect(r.message).not.toContain("hunter2");
  });

  it("stays quiet on a clean file", () => {
    expect(hook(JSON.stringify({ file_path: "src/clean.ts" }), { root })).toEqual({ code: 0, message: "" });
  });

  it("stays quiet when the event names no file", () => {
    expect(hook("{}", { root })).toEqual({ code: 0, message: "" });
    expect(hook("", { root })).toEqual({ code: 0, message: "" });
  });

  it("ignores files outside the repository", () => {
    expect(hook(JSON.stringify({ file_path: join(tmpdir(), "elsewhere.ts") }), { root }).code).toBe(0);
  });

  it("exits 2, not 0, when stdin is not JSON", () => {
    const r = hook("{not json", { root });
    expect(r.code).toBe(2);
    expect(r.message).toContain("Nothing was checked");
  });

  it("exits 2, not 0, when the runner cannot do its job", () => {
    writeFileSync(join(root, "bouncer-gates.baseline.json"), "{broken");
    const r = hook(JSON.stringify({ file_path: "src/new.ts" }), { root });
    rmSync(join(root, "bouncer-gates.baseline.json"));
    expect(r.code).toBe(2);
    expect(r.message).toContain("NOT checked");
  });
});

describe("--init-agents", () => {
  it("writes the MCP server and the hook, and merges into existing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "bouncer-gates-init-"));
    mkdirSync(join(dir, ".claude"));
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { other: { command: "x" } } }));

    const out = initAgents(dir).join("\n");
    expect(out).toContain(".mcp.json: added");
    expect(out).toContain(".claude/settings.json: bouncer-gates now runs");

    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other).toEqual({ command: "x" });
    expect(mcp.mcpServers["bouncer-gates"].args).toContain("--mcp");
    expect(existsSync(join(dir, ".cursor", "mcp.json"))).toBe(true);

    const settings = JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("--hook");

    // Second run changes nothing.
    const again = initAgents(dir).join("\n");
    expect(again).toContain("already");
    expect(JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).hooks.PostToolUse).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("does not create a .cursor directory in a repository that has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "bouncer-gates-init-"));
    const out = initAgents(dir).join("\n");
    expect(existsSync(join(dir, ".cursor"))).toBe(false);
    expect(out).toContain(".cursor/ not found");
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses to guess at a settings file it cannot parse", () => {
    const dir = mkdtempSync(join(tmpdir(), "bouncer-gates-init-"));
    writeFileSync(join(dir, ".mcp.json"), "{broken");
    expect(() => initAgents(dir)).toThrow(RunnerError);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("telemetry", () => {
  const home = () => mkdtempSync(join(tmpdir(), "bouncer-gates-home-"));

  it("is off with BOUNCER_TELEMETRY=0 or DO_NOT_TRACK=1, and sends nothing", async () => {
    expect(telemetryDisabled({ BOUNCER_TELEMETRY: "0" })).toBe(true);
    expect(telemetryDisabled({ DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({})).toBe(false);
    let calls = 0;
    const r = await recordUse("cli", "0.0.0", { env: { BOUNCER_TELEMETRY: "0" }, fetch: async () => calls++ });
    expect(r.sent).toBe(false);
    expect(calls).toBe(0);
  });

  it("sends exactly five fields and nothing about the code", async () => {
    const dir = home();
    let body;
    const r = await recordUse("mcp", "0.4.0", {
      env: { BOUNCER_HOME: dir },
      fetch: async (url, init) => {
        body = JSON.parse(init.body);
        return { ok: true };
      },
    });
    expect(r.sent).toBe(true);
    expect(r.notice).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["id", "node", "os", "runtime", "version"]);
    expect(body.runtime).toBe("mcp");
    expect(body.id).toMatch(/^[a-f0-9]{24}$/);
    expect(readFileSync(join(dir, "id"), "utf8").trim()).toBe(body.id);
    rmSync(dir, { recursive: true, force: true });
  });

  it("pings at most once a day per runtime, and shows the notice once", async () => {
    const dir = home();
    let calls = 0;
    const deps = { env: { BOUNCER_HOME: dir }, fetch: async () => calls++ };
    const first = await recordUse("cli", "0.4.0", deps);
    const second = await recordUse("cli", "0.4.0", deps);
    const other = await recordUse("hook", "0.4.0", deps);
    expect(first.notice).toBe(true);
    expect(second).toEqual({ sent: false, notice: false });
    expect(other.sent).toBe(true);
    expect(other.notice).toBe(false);
    expect(calls).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports as CI with no id when CI is set", async () => {
    const dir = home();
    let body;
    await recordUse("cli", "0.4.0", {
      env: { BOUNCER_HOME: dir, CI: "true" },
      fetch: async (url, init) => void (body = JSON.parse(init.body)),
    });
    expect(body.runtime).toBe("ci");
    expect(body.id).toBeNull();
    expect(existsSync(join(dir, "id"))).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("swallows a network failure", async () => {
    const dir = home();
    const r = await recordUse("cli", "0.4.0", {
      env: { BOUNCER_HOME: dir },
      fetch: async () => {
        throw new Error("offline");
      },
    });
    expect(r.sent).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("tells people how to turn it off", () => {
    expect(NOTICE).toContain("BOUNCER_TELEMETRY=0");
  });
});

describe("the real processes", () => {
  // The unit tests above call the functions. These start `bin/bouncer-gates.mjs`
  // the way an editor would, so the stdio plumbing, the exit codes and the
  // telemetry switch are exercised too.
  const BIN = join(process.cwd(), "bin", "bouncer-gates.mjs");
  const env = { ...process.env, BOUNCER_TELEMETRY: "0" };

  it("--mcp answers a handshake and a tool call over stdio, then exits on EOF", async () => {
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath, [BIN, "--mcp"], { cwd: root, env });
    const lines = [];
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "bouncer_gates_scan", arguments: { paths: ["src/new.ts"] } } });
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    expect(code).toBe(0);
    expect(lines.map((l) => l.id)).toEqual([1, 2]);
    expect(lines[0].result.serverInfo.name).toBe("bouncer-gates");
    expect(lines[1].result.content[0].text).toContain("secrets/assigned-credential");
  });

  it("--hook exits 2 with findings on stderr and nothing on stdout", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [BIN, "--hook"], {
      cwd: root,
      env,
      input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(root, "src", "new.ts") } }),
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("secrets/assigned-credential");
  });

  it("--hook exits 0 silently on a clean file", async () => {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync(process.execPath, [BIN, "--hook"], {
      cwd: root,
      env,
      input: JSON.stringify({ file_path: "src/clean.ts" }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe("");
  });
});
