import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import s from "./Playground.module.scss";

import { UNAVAILABLE } from "../../shared/demo-config.mjs";
import { runDemoGates } from "../../shared/demo-scan.mjs";

/**
 * The playground runs the gates two ways, and which one answered is shown in the
 * footer rather than hidden.
 *
 * PRIMARY: POST to /api/scan, which runs on a Cloudflare Worker. That is the honest
 * demonstration, because it is the same path a CI run takes: server side, on the
 * real modules, with no browser involved.
 *
 * FALLBACK: run them right here in the component. This works because gates are
 * pure functions with no Node built-ins, so the identical module that runs in CI
 * and in the Worker also runs in a browser tab. It keeps `astro dev` useful
 * without wrangler, and keeps the page working if the endpoint is down.
 *
 * What that actually proves is not that the demo is clever. It is that there is
 * exactly ONE implementation of every rule. A playground with its own copy of
 * the regexes would drift from the real gates within a month and start teaching
 * visitors something false.
 */

type Finding = {
  path: string;
  line: number;
  rule: string;
  message: string;
  fix?: string;
  severity: "error" | "warn";
};

const PRESETS: { label: string; code: string }[] = [
  {
    label: "A leak",
    code: [
      "// Reads orders through the unscoped client, so it returns every",
      "// tenant's orders rather than only this one's.",
      "export async function recentOrders(tenantId: string) {",
      "  return db.raw.order.findMany({ take: 20 });",
      "}",
      "",
      "export async function search(term: string) {",
      "  return db.$queryRaw(sql(SELECT * FROM orders WHERE note LIKE term));",
      "}",
    ].join("\n"),
  },
  {
    label: "Money",
    code: [
      "// Both of these are wrong, and both look completely normal.",
      "export function toMinor(input: string) {",
      "  return Math.round(parseFloat(input) * 100);",
      "}",
      "",
      "export function display(totalAmount: number) {",
      "  return (totalAmount / 100).toFixed(2);",
      "}",
    ].join("\n"),
  },
  {
    label: "Secrets",
    code: [
      'const password = "prod-db-9f2a41cc";',
      'const stripe = "sk_live_51QxaBcDeFgHiJkLmNoPq";',
      "",
      "// Fine: read from the environment.",
      "const good = process.env.DB_PASSWORD;",
      "",
      "// Fine: obviously a placeholder.",
      'const sample = "your-api-key-here";',
    ].join("\n"),
  },
  {
    label: "Shape",
    code: [
      "# Pipes something off the network straight into a shell.",
      "curl https://get.example.com/install.sh | sh",
      "",
      "# Turns off host key checking.",
      "ssh -o StrictHostKeyChecking=no deploy@host",
    ].join("\n"),
  },
  {
    label: "Clean",
    code: [
      "// Nothing here trips a gate.",
      "export async function recentOrders(tenantId: string) {",
      "  return db.forTenant(tenantId).order.findMany({ take: 20 });",
      "}",
      "",
      "export function toMinor(input: string, currency: string) {",
      "  return decimalToMinor(input, currency);",
      "}",
    ].join("\n"),
  },
  {
    label: "Excused",
    code: [
      "// The escape hatch. A reason is required, and it stays in the file",
      "// where the next reader will find it.",
      "export async function adminRevenueReport() {",
      "  // bouncer-gates-ok(scope): finance dashboard, deliberately spans all tenants",
      "  return db.raw.order.aggregate({ _sum: { totalMinor: true } });",
      "}",
    ].join("\n"),
  },
];

function runLocally(code: string, filename: string): Finding[] {
  // The same function the Worker calls, so the fallback cannot answer differently
  // from the server it is standing in for.
  return runDemoGates(code, filename).findings as Finding[];
}

export default function Playground() {
  const [code, setCode] = useState(PRESETS[0].code);
  const [active, setActive] = useState(0);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [ranOn, setRanOn] = useState<"worker" | "browser" | null>(null);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  const filename = useMemo(
    () => (code.trimStart().startsWith("#") ? "deploy.sh" : "service.ts"),
    [code]
  );

  const run = useCallback(async (source: string, name: string) => {
    const mine = ++seq.current;
    setBusy(true);
    try {
      const res = await fetch("/api/scan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: source, filename: name }),
      });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      if (mine !== seq.current) return;
      setFindings(data.findings ?? []);
      setRanOn("worker");
    } catch {
      // No endpoint (astro dev, or an outage). Same modules, different runtime.
      if (mine !== seq.current) return;
      setFindings(runLocally(source, name));
      setRanOn("browser");
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, []);

  // Debounced so typing does not fire one request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void run(code, filename), 250);
    return () => clearTimeout(t);
  }, [code, filename, run]);

  const errors = findings.filter((f) => f.severity === "error").length;

  return (
    <div className={s.root}>
      <div className={s.panel}>
        <div className={s.panelHead}>
          <span>{filename}</span>
          <div className={s.presets}>
            {PRESETS.map((p, i) => (
              <button
                key={p.label}
                type="button"
                className={i === active ? s.preset + " " + s.presetOn : s.preset}
                onClick={() => {
                  setActive(i);
                  setCode(p.code);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
        <textarea
          className={s.editor}
          value={code}
          spellCheck={false}
          aria-label="Code to check"
          onChange={(e) => {
            setActive(-1);
            setCode(e.target.value);
          }}
        />
      </div>

      <div className={s.panel}>
        <div className={s.panelHead}>
          <span>{busy ? "checking" : errors ? errors + " blocking" : "result"}</span>
          <span>{findings.length ? findings.length + " total" : ""}</span>
        </div>

        <div className={s.results}>
          {findings.length === 0 ? (
            code.trim() ? (
              <div className={s.pass}>No gate objects. This would merge.</div>
            ) : (
              <div className={s.empty}>Paste something, or pick an example above.</div>
            )
          ) : (
            findings.map((f, i) => (
              <div
                key={f.rule + "-" + f.line + "-" + i}
                className={f.severity === "warn" ? s.finding + " " + s.findingWarn : s.finding}
              >
                <div className={s.findingHead}>
                  <span className={s.loc}>line {f.line}</span>
                  <span className={f.severity === "warn" ? s.rule + " " + s.ruleWarn : s.rule}>
                    {f.rule}
                  </span>
                </div>
                <p className={s.msg}>{f.message}</p>
                {f.fix ? <p className={s.fix}>{f.fix}</p> : null}
              </div>
            ))
          )}
          {/*
            Name the gates that did not run.

            Three of the five can answer for a pasted snippet; migration-safety
            needs git history and doc-links needs the repository file list. The
            API has always returned that in an `unavailable` array, and this
            component quietly dropped it, so the page showed three gates' results
            while implying five ran. That is exactly what the CLI refuses to do
            when it prints "skipped" with a reason rather than passing, and it
            should not be different here just because it is a demo.
          */}
          {ranOn ? (
            <span className={s.footNote}>
              {" \u00b7 "}
              {UNAVAILABLE.map((u) => u.gate).join(" and ")} need a repository, so they
              cannot run here
            </span>
          ) : null}
        </div>

        <div className={s.foot}>
          {ranOn === "worker" ? (
            <>
              ran on <span className={s.where}>a Cloudflare Worker</span>, same modules as CI
            </>
          ) : ranOn === "browser" ? (
            <>
              ran <span className={s.where}>in this tab</span>, same modules as CI
            </>
          ) : (
            " "
          )}
        </div>
      </div>
    </div>
  );
}
