/**
 * The two ways an agentic editor gets Bouncer: a hook and a config writer.
 *
 * The hook is the cheapest integration there is. Claude Code, Cursor and the
 * other agentic editors can run a command after every file write and hand the
 * model whatever it prints on a non-zero exit. So `bouncer --hook` reads the
 * event on stdin, scans the one file that changed, and if anything blocks it
 * prints the findings and exits 2. The model sees the finding and the fix in
 * the same turn it wrote the bug, which is the earliest anything can catch it.
 *
 * Only exit 2 carries a message back to the model in Claude Code, so both "the
 * file has a blocking finding" and "bouncer could not run" use it. Those are
 * different messages, and both are worth interrupting for. What must never
 * happen is exit 0 because the runner broke.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runGates, toText, RunnerError, repoPath } from "./run.mjs";

/**
 * Pull file paths out of a hook event. The shapes differ per editor:
 *
 *   Claude Code   { tool_name, tool_input: { file_path } }
 *   Cursor        { file_path } or { files: [...] }
 *   anything      { paths: [...] }
 *
 * Unknown shapes yield no paths, and no paths means nothing to check, which is
 * reported rather than silently passed.
 */
export function pathsFromEvent(event) {
  const out = new Set();
  const add = (v) => {
    if (typeof v === "string" && v.trim()) out.add(v.trim());
  };
  if (!event || typeof event !== "object") return [];
  add(event.file_path);
  add(event.tool_input?.file_path);
  add(event.tool_input?.notebook_path);
  for (const k of ["paths", "files", "file_paths"]) {
    if (Array.isArray(event[k])) for (const p of event[k]) add(typeof p === "string" ? p : p?.path);
  }
  if (Array.isArray(event.tool_input?.edits)) {
    for (const e of event.tool_input.edits) add(e?.file_path);
  }
  return [...out];
}

/**
 * Run the hook against one stdin document.
 *
 * @returns {{ code: number, message: string }}   what to print to stderr and how to exit
 */
export function hook(stdinText, { root, base }) {
  let event;
  try {
    event = stdinText.trim() ? JSON.parse(stdinText) : {};
  } catch (e) {
    return { code: 2, message: `bouncer hook: stdin was not JSON (${e.message}). Nothing was checked.\n` };
  }
  const paths = pathsFromEvent(event);
  if (!paths.length) return { code: 0, message: "" };

  // Files outside the repository are not ours to judge.
  const inside = paths.filter((p) => Boolean(repoPath(root, p)));
  if (!inside.length) return { code: 0, message: "" };

  let run;
  try {
    run = runGates({ root, base, baseGiven: Boolean(base), paths: inside });
  } catch (e) {
    const msg = e instanceof RunnerError ? e.message : e.stack ?? String(e);
    return { code: 2, message: `bouncer could not run, so ${inside.join(", ")} was NOT checked: ${msg}\n` };
  }
  if (run.errorCount || run.crashed) return { code: 2, message: toText(run) };
  return { code: 0, message: "" };
}

const MCP_SERVER = { command: "npx", args: ["-y", "bouncer-gates", "--mcp"] };
const HOOK_COMMAND = "npx -y bouncer-gates --hook";

function readJsonOr(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new RunnerError(`${path} is not valid JSON: ${e.message}`);
  }
}

function writeJson(path, obj) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

/**
 * Write the editor config that wires Bouncer in, merging into what exists.
 *
 * Two files, both in the repository so every contributor and every agent on
 * the project gets the same guardrails without doing anything:
 *
 *   .mcp.json                 the MCP server. Claude Code reads this by name;
 *                             Cursor reads the same shape from .cursor/mcp.json.
 *   .claude/settings.json     a PostToolUse hook on Edit and Write.
 *
 * Nothing already in those files is touched. If Bouncer is already there,
 * nothing is written and the output says so.
 *
 * @returns {string[]} lines to print
 */
export function initAgents(root, { cursor = true } = {}) {
  const out = [];

  const mcpPath = join(root, ".mcp.json");
  const mcp = readJsonOr(mcpPath, {});
  mcp.mcpServers ??= {};
  if (mcp.mcpServers.bouncer) out.push("  .mcp.json already has a bouncer server, left as is");
  else {
    mcp.mcpServers.bouncer = MCP_SERVER;
    writeJson(mcpPath, mcp);
    out.push("  .mcp.json: added the bouncer MCP server (Claude Code picks this up on next start)");
  }

  // Cursor's config only goes where Cursor is already in use. Creating a
  // .cursor directory in a repository that never had one is clutter, and
  // clutter is how a setup command gets a reputation.
  const cursorDir = join(root, ".cursor");
  if (cursor && existsSync(cursorDir)) {
    const cursorPath = join(cursorDir, "mcp.json");
    const c = readJsonOr(cursorPath, {});
    c.mcpServers ??= {};
    if (c.mcpServers.bouncer) out.push("  .cursor/mcp.json already has a bouncer server, left as is");
    else {
      c.mcpServers.bouncer = MCP_SERVER;
      writeJson(cursorPath, c);
      out.push("  .cursor/mcp.json: added the bouncer MCP server");
    }
  } else if (cursor) {
    out.push("  .cursor/ not found, so no Cursor config was written. Create the directory and rerun to add it.");
  }

  const settingsPath = join(root, ".claude", "settings.json");
  const settings = readJsonOr(settingsPath, {});
  settings.hooks ??= {};
  settings.hooks.PostToolUse ??= [];
  const has = settings.hooks.PostToolUse.some((h) =>
    (h.hooks ?? []).some((x) => typeof x.command === "string" && x.command.includes("bouncer"))
  );
  if (has) out.push("  .claude/settings.json already runs bouncer after edits, left as is");
  else {
    settings.hooks.PostToolUse.push({
      matcher: "Edit|Write|MultiEdit|NotebookEdit",
      hooks: [{ type: "command", command: HOOK_COMMAND, timeout: 30 }],
    });
    writeJson(settingsPath, settings);
    out.push("  .claude/settings.json: bouncer now runs after every Edit and Write, and blocking findings go back to the model");
  }

  out.push(
    "",
    "Commit these files. Everyone who opens the repository in Claude Code or Cursor",
    "gets the same gates, and an agent that writes a secret hears about it in the",
    "same turn.",
    "",
    "Other editors: any MCP client can run",
    `  ${MCP_SERVER.command} ${MCP_SERVER.args.join(" ")}`,
    "and any post-edit hook can pipe its event to",
    `  ${HOOK_COMMAND}`,
    "which reads file_path (or paths[]) from stdin JSON and exits 2 with the findings.",
    ""
  );
  return out;
}
