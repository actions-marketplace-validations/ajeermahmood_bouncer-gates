/**
 * The same gates, as a plain Node service. Deployed on Railway.
 *
 * This exists to make one point precisely. `functions/api/scan.js` is a
 * Cloudflare Worker, `bin/bouncer-gates.mjs` is a CLI, `Playground.tsx` runs them in a
 * browser tab, and this is a long-lived Node process. Four runtimes, four
 * deployment models, and not one line of duplicated rule logic between them.
 *
 * That is the entire return on making gates pure functions. It is not an
 * aesthetic preference about side effects; it is the reason a rule can be
 * written once and then enforced in CI, in an editor, in a pre-commit hook, in a
 * hosted API for a team that does not run Node, and on a marketing site.
 */
import { createServer } from "node:http";
import { MAX_SNIPPET_BYTES } from "../shared/demo-config.mjs";
import { runDemoGates } from "../shared/demo-scan.mjs";

const PORT = Number(process.env.PORT) || 8080;

const server = createServer((req, res) => {
  const send = (status, data) => {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(body),
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
    });
    res.end(body);
  };

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  // Railway health checks hit the root. Answer it cheaply and without touching
  // the gates, so a health check cannot be affected by a bad rule.
  if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
    return send(200, { ok: true, gates: ["secrets", "scope", "money"] });
  }

  if (req.method !== "POST" || !req.url.startsWith("/scan")) {
    return send(404, { error: "POST /scan with { code, filename }" });
  }

  let size = 0;
  const chunks = [];
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_SNIPPET_BYTES) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("aborted", () => {
    if (!res.headersSent) send(413, { error: "Snippet too large. 64KB is plenty." });
  });

  req.on("end", () => {
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      return send(400, { error: "Body must be JSON: { code, filename }" });
    }

    const code = typeof body.code === "string" ? body.code : "";
    const filename =
      typeof body.filename === "string" && body.filename ? body.filename : "snippet.ts";
    if (!code.trim()) return send(200, runDemoGates(""));

    const { findings, crashed, unavailable } = runDemoGates(code, filename);
    // Say which gates did not run, rather than returning three gates' findings
    // and letting the caller believe all five were applied. Same reason the CLI
    // prints "skipped" with a reason instead of quietly passing: a response that
    // looks complete but is not is the failure this whole project is about.
    send(crashed.length ? 500 : 200, { findings, crashed, unavailable });
  });
});

server.listen(PORT, () => {
  process.stdout.write(`bouncer-gates api listening on ${PORT}\n`);
});
