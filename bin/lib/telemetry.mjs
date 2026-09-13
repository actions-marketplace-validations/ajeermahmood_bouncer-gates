/**
 * One anonymous ping per day, so the project can know whether anybody uses it.
 *
 * What is sent, in full:
 *
 *   { id, version, runtime, os, node }
 *
 *   id        a random string generated once and stored in ~/.bouncer/id. It is
 *             not derived from anything about the machine or the person.
 *   version   this package's version
 *   runtime   "cli", "mcp", "hook" or "ci"
 *   os        process.platform, like "linux"
 *   node      the major Node version
 *
 * What is never sent: file names, file contents, findings, rule ids, the
 * repository name, the config, the working directory, environment variables, or
 * anything a gate looked at. A tool whose whole reason to exist is not leaking
 * things does not get to leak things.
 *
 * Off with BOUNCER_TELEMETRY=0 or DO_NOT_TRACK=1. The first run prints a notice
 * saying this. The full description is in docs/telemetry.md.
 *
 * It never affects the result: every failure is swallowed, the request has a
 * short timeout, and nothing here runs before the scan has finished.
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

export const ENDPOINT = "https://bouncer.ajeermdk001.workers.dev/api/ping";
const DAY = 24 * 60 * 60 * 1000;

export function telemetryDisabled(env = process.env) {
  if (env.BOUNCER_TELEMETRY === "0" || env.BOUNCER_TELEMETRY === "false") return true;
  if (env.DO_NOT_TRACK === "1" || env.DO_NOT_TRACK === "true") return true;
  return false;
}

export function isCi(env = process.env) {
  return Boolean(env.CI || env.GITHUB_ACTIONS || env.GITLAB_CI || env.BUILDKITE || env.CIRCLECI);
}

function stateDir(env = process.env) {
  return env.BOUNCER_HOME || join(homedir(), ".bouncer");
}

/**
 * The stored id, creating it on first use. Returns { id, created } so the caller
 * can print the first-run notice exactly once.
 */
function identity(dir) {
  const path = join(dir, "id");
  try {
    const id = readFileSync(path, "utf8").trim();
    if (/^[a-z0-9]{16,}$/.test(id)) return { id, created: false };
  } catch {}
  const id = randomBytes(12).toString("hex");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, id + "\n");
  } catch {}
  return { id, created: true };
}

function pingedRecently(dir, runtime) {
  try {
    return Date.now() - statSync(join(dir, `last-${runtime}`)).mtimeMs < DAY;
  } catch {
    return false;
  }
}

function markPinged(dir, runtime) {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `last-${runtime}`), String(Date.now()));
  } catch {}
}

export const NOTICE =
  "bouncer sends one anonymous ping a day (a random id, version, runtime, OS, Node major) " +
  "so the project knows it is used. Nothing about your code is ever sent. " +
  "Set BOUNCER_TELEMETRY=0 to turn it off. Details: https://github.com/ajeermahmood/bouncer/blob/main/docs/telemetry.md\n";

/**
 * Record a use. Fire and forget.
 *
 * @param {"cli"|"mcp"|"hook"} runtime
 * @param {object} [deps]   injected for tests
 * @returns {Promise<{sent: boolean, notice: boolean, payload?: object}>}
 */
export async function recordUse(runtime, version, deps = {}) {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? globalThis.fetch;
  if (telemetryDisabled(env) || typeof doFetch !== "function") return { sent: false, notice: false };

  const dir = stateDir(env);
  // A CI runner has no persistent home, so every job would look like a new
  // machine. Count it as CI, without an id, and without the daily throttle,
  // because the interesting number there is runs rather than machines.
  const ci = isCi(env);
  const { id, created } = ci ? { id: "", created: false } : identity(dir);
  if (!ci && pingedRecently(dir, runtime)) return { sent: false, notice: false };

  const payload = {
    id: ci ? null : id,
    version,
    runtime: ci ? "ci" : runtime,
    os: process.platform,
    node: Number(process.versions.node.split(".")[0]),
  };

  // The attempt is recorded before it is made, not after it succeeds. A machine
  // that is offline, or behind a proxy that eats the request, would otherwise
  // retry on every run and pay the timeout each time, which turns a ping nobody
  // notices into a second of delay everybody notices.
  if (!ci) markPinged(dir, runtime);

  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), deps.timeoutMs ?? 1000);
    await doFetch(deps.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    });
    clearTimeout(t);
  } catch {
    return { sent: false, notice: created, payload };
  }
  return { sent: true, notice: created, payload };
}
