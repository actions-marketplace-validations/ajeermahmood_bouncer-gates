/**
 * Cloudflare Worker entry: the API, with static assets behind it.
 *
 * There are two ways to put this site on Cloudflare and they need different
 * plumbing, which is worth writing down because getting it wrong is silent.
 *
 *   Pages   picks up `functions/api/scan.js` by convention and compiles it for
 *           you. Nothing else to configure.
 *   Workers ignores `functions/` entirely. You provide one entry, route what you
 *           want yourself, and hand everything else to the assets binding.
 *
 * The first deployment of this site went out as a Worker, so `/api/scan` was
 * never wired up and returned the static 404 page. Nothing looked broken: the
 * playground caught the failure and ran the gates in the browser instead, exactly
 * as designed. The fallback did its job so well that it hid the outage, which is
 * the honest hazard of building a good fallback. The footer saying which runtime
 * answered is what makes that visible rather than invisible.
 *
 * `functions/api/scan.js` is kept for anyone deploying this to Pages. Both paths
 * import the same gate modules, so there is still exactly one implementation of
 * every rule.
 */
import { MAX_SNIPPET_BYTES } from "../shared/demo-config.mjs";
import { runDemoGates } from "../shared/demo-scan.mjs";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/scan") return handleScan(request);
    if (url.pathname === "/api/ping") return handlePing(request, env);

    // Everything else is the static site.
    return env.ASSETS.fetch(request);
  },
};

async function handleScan(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
      },
    });
  }

  if (request.method !== "POST") {
    return json({ error: "POST { code, filename } here." }, 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON: { code, filename }" }, 400);
  }

  const code = typeof body.code === "string" ? body.code : "";
  const filename =
    typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";

  if (!code.trim()) return json(runDemoGates(""));
  if (new TextEncoder().encode(code).length > MAX_SNIPPET_BYTES) {
    return json({ error: "Snippet is too large. 64KB is plenty for a demonstration." }, 413);
  }

  const { findings, crashed, unavailable } = runDemoGates(code, filename);
  return json({ findings, crashed, unavailable }, crashed.length ? 500 : 200);
}

/**
 * The usage counter. See docs/telemetry.md for what the CLI sends and why.
 *
 * Each ping becomes one row in an Analytics Engine dataset: a random id, the
 * version, the runtime, the OS and the Node major. That is the whole schema.
 * Nothing in the request body beyond those five fields is read, so even a
 * misbehaving client cannot get anything else stored here.
 *
 * If the dataset binding is missing (a Pages deployment, or a fork that has
 * not set it up) the ping is accepted and dropped. Telemetry must never make
 * the client wait or fail, and it must never make the site fail either.
 */
const RUNTIMES = new Set(["cli", "mcp", "hook", "ci"]);

async function handlePing(request, env) {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const runtime = RUNTIMES.has(body?.runtime) ? body.runtime : "unknown";
  const id = typeof body?.id === "string" && /^[a-z0-9]{16,64}$/.test(body.id) ? body.id : "";
  const version = typeof body?.version === "string" ? body.version.slice(0, 20) : "";
  const os = typeof body?.os === "string" ? body.os.slice(0, 16) : "";
  const node = Number.isInteger(body?.node) ? String(body.node) : "";
  try {
    env.PINGS?.writeDataPoint({
      blobs: [runtime, version, os, node, id],
      doubles: [1],
      indexes: [id || runtime],
    });
  } catch {}
  return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    },
  });
}
