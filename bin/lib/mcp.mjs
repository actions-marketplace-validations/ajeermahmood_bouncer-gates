/**
 * Bouncer as an MCP server, over stdio.
 *
 * This is where the gates meet the agent that is writing the code. CI runs
 * after the pull request exists; this runs while the file is still open. Claude
 * Code, Cursor, Windsurf, Copilot and the rest all speak the Model Context
 * Protocol, so one small server puts every gate inside the loop where mistakes
 * are made rather than after it.
 *
 * Written against the protocol directly rather than through an SDK, on purpose:
 * this package has no runtime dependencies and `npx bouncer-gates --mcp` has to
 * start in the time it takes to read the gates. The protocol needed here is
 * four methods and a JSON schema per tool.
 *
 * Findings are already the shape an agent needs. Each one carries a location, a
 * stable rule id, a message, and a fix written for somebody who has never seen
 * the gate. That last part was designed for a human contributor and turns out to
 * be exactly what a model needs to correct itself in one step.
 *
 * Everything the server writes to stdout is protocol. Diagnostics go to stderr.
 */
import { createInterface } from "node:readline";
import { GATES } from "../../gates/index.mjs";
import { runGates, toJson, toText, RunnerError, VERSION } from "./run.mjs";

const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export const INSTRUCTIONS = [
  "Bouncer checks code for the mistakes that are expensive to find later: committed",
  "secrets, multi-tenant queries with no tenant filter, float maths on money, SQL",
  "migrations that break the running app, and dead links in markdown.",
  "",
  "Before you finish a task, call bouncer_scan with the files you changed. Fix every",
  "blocking finding. If a finding is wrong for a reason you can state, put that",
  "reason on the line above it:",
  "",
  "  // bouncer-ok(<gate>): <why this is fine here>",
  "",
  "The reason is required and is read by humans; never write a vague one. Do not",
  "edit bouncer.config.json or bouncer.baseline.json to make a finding go away.",
  "A gate reported as skipped did not look; it is not a pass.",
].join("\n");

const TOOLS = [
  {
    name: "bouncer_scan",
    description:
      "Run the Bouncer gates on files in the repository. With `paths`, scans only those files, " +
      "whether or not git tracks them yet. Without `paths`, scans the whole repository, or only " +
      "changed files when `changed` is true. Returns findings with a file, line, rule, message and fix, " +
      "plus any gate that could not run and why.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Files to scan, relative to the repository root or absolute.",
        },
        changed: {
          type: "boolean",
          description: "Only files that differ from the base branch. Ignored when paths is given.",
        },
        only: {
          type: "array",
          items: { type: "string", enum: GATES.map((g) => g.name) },
          description: "Gate names to run. Default: all.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "bouncer_scan_snippet",
    description:
      "Run the Bouncer gates on code that is not on disk yet, using this repository's configuration. " +
      "Give the filename it will have, because the extension decides which gates apply.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The source text." },
        filename: {
          type: "string",
          description: "Path the code will live at, e.g. src/orders.ts or migrations/002.sql.",
        },
      },
      required: ["code", "filename"],
      additionalProperties: false,
    },
  },
  {
    name: "bouncer_explain",
    description: "What one gate checks, what it deliberately does not catch, and how to excuse one line.",
    inputSchema: {
      type: "object",
      properties: {
        gate: { type: "string", enum: GATES.map((g) => g.name) },
      },
      required: ["gate"],
      additionalProperties: false,
    },
  },
  {
    name: "bouncer_list_gates",
    description: "The gates this server runs, with one line each.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function explain(name) {
  const gate = GATES.find((g) => g.name === name);
  if (!gate) throw new RunnerError(`no gate named "${name}". Known: ${GATES.map((g) => g.name).join(", ")}`);
  return [
    `${gate.title} (${gate.name})`,
    "",
    gate.summary,
    "",
    "To excuse one line, put a comment on it or the line above it:",
    `  // bouncer-ok(${gate.name}): <why this is fine here>`,
    "The reason is required. A bare marker suppresses nothing.",
    "",
    `Full reference, including what it misses: https://github.com/ajeermahmood/bouncer/blob/main/docs/gates.md#${gate.name}`,
  ].join("\n");
}

/**
 * Handle one tool call. Exported so the tests can call it without a process.
 * Returns an MCP tool result.
 */
export function callTool(name, args = {}, { root, base }) {
  const text = (t, extra = {}) => ({ content: [{ type: "text", text: t }], ...extra });
  try {
    switch (name) {
      case "bouncer_list_gates":
        return text(GATES.map((g) => `${g.name}: ${g.summary}`).join("\n"));
      case "bouncer_explain":
        return text(explain(String(args.gate ?? "")));
      case "bouncer_scan": {
        const paths = Array.isArray(args.paths) && args.paths.length ? args.paths.map(String) : undefined;
        const run = runGates({
          root,
          base,
          baseGiven: Boolean(base),
          paths,
          changed: !paths && Boolean(args.changed),
          only: Array.isArray(args.only) ? args.only.map(String) : undefined,
        });
        return text(toText(run), { structuredContent: toJson(run), isError: run.crashed });
      }
      case "bouncer_scan_snippet": {
        const run = runGates({
          root,
          base,
          baseGiven: Boolean(base),
          snippets: [{ path: String(args.filename), text: String(args.code ?? "") }],
        });
        return text(toText(run), { structuredContent: toJson(run), isError: run.crashed });
      }
      default:
        return text(`unknown tool "${name}"`, { isError: true });
    }
  } catch (e) {
    // A runner that cannot do its job says so in the result, as an error. It must
    // never come back as "no findings". That is the same rule as exit code 2.
    const msg = e instanceof RunnerError ? e.message : `bouncer crashed: ${e.stack ?? e.message}`;
    return text(`Bouncer could not run, so nothing was checked. ${msg}`, { isError: true });
  }
}

/** JSON-RPC dispatch for one request. Returns a response object, or null for notifications. */
export function handleMessage(msg, opts) {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") {
    return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
  }
  const { id, method, params = {} } = msg;
  const isNotification = id === undefined;
  const reply = (result) => (isNotification ? null : { jsonrpc: "2.0", id, result });
  const error = (code, message) => (isNotification ? null : { jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return reply({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "bouncer", version: VERSION },
        instructions: INSTRUCTIONS,
      });
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS });
    case "tools/call":
      return reply(callTool(String(params.name ?? ""), params.arguments ?? {}, opts));
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

/** Serve stdin/stdout until the client hangs up. */
export function serve(opts) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const write = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    const batch = Array.isArray(msg) ? msg : [msg];
    for (const m of batch) {
      const res = handleMessage(m, opts);
      if (res) write(res);
    }
  });
  rl.on("close", () => process.exit(0));
  process.stderr.write(`bouncer mcp ${VERSION} ready (root: ${opts.root})\n`);
}
