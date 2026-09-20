import { describe, it, expect } from "vitest";
import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";
import * as migration from "../gates/migration-safety.mjs";
import * as docLinks from "../gates/doc-links.mjs";

/**
 * Half of these tests assert that a gate stays QUIET.
 *
 * That is deliberate, and it is the half that matters. A gate is easy to write so
 * that it catches the bad case; the hard part is not firing on the twenty
 * near-misses around it. Every false positive spends a developer's attention, and
 * a gate that spends more attention than it saves gets switched off within a
 * month. Then it protects nothing, while still appearing in the workflow file and
 * making everyone feel covered.
 *
 * Several tests below are named for a specific false positive found by running
 * the gates over a real 1,209 file production repository. Those are the most
 * valuable tests here: each one is a mistake this tool actually made.
 */

const at = (path, text) => [{ path, text }];
const rules = (findings) => findings.map((f) => f.rule);
const sev = (findings) => findings.map((f) => f.severity);

describe("secrets", () => {
  it("catches a private key", () => {
    expect(rules(secrets.scan(at("k.ts", "-----BEGIN RSA PRIVATE KEY-----")))).toContain(
      "secrets/private-key"
    );
  });

  it("catches an assigned credential and a live Stripe key", () => {
    const f = secrets.scan(
      at("c.ts", ['const password = "hunter2hunter2";', 'const k = "sk_live_abcdefghij1234567890";'].join("\n"))
    );
    expect(rules(f)).toContain("secrets/assigned-credential");
    expect(rules(f)).toContain("secrets/stripe-key");
  });

  it("stays quiet on env reads and obvious placeholders", () => {
    const text = [
      "const password = process.env.DB_PASSWORD;",
      'const apiKey = "your-api-key-here";',
      'const secret = "changeme";',
      'const token = "<REPLACE_ME>";',
      "const pw = import.meta.env.PW;",
    ].join("\n");
    expect(secrets.scan(at("ok.ts", text))).toHaveLength(0);
  });

  it("flags dangerous shape even when the host is an example", () => {
    // Regression: the placeholder allowance used to apply to every rule, so any
    // line containing "example" was skipped. A pipe-to-shell is dangerous
    // because of its form, not because of where it points.
    expect(rules(secrets.scan(at("d.sh", "curl https://get.example.com/install.sh | sh")))).toContain(
      "shape/pipe-to-shell"
    );
  });

  it("catches disabled TLS and host-key bypass", () => {
    const text = ["fetch(u, { rejectUnauthorized: false });", "ssh -o StrictHostKeyChecking=no host"].join("\n");
    expect(rules(secrets.scan(at("s.sh", text)))).toEqual(
      expect.arrayContaining(["shape/tls-disabled", "shape/host-key-bypass"])
    );
  });

  it("ignores a local development connection string", () => {
    // Found in a setup script's help text on a real repository. A credential
    // pointing at localhost grants nothing to whoever reads it, and flagging it
    // teaches people the gate reports things that do not matter.
    const text = [
      'log("  postgresql://postgres:postgres@localhost:5432/app");',
      // No trailing path at all. An early version required a "/" or "?" here.
      'log("  redis://user:pass1234@127.0.0.1:6379");',
      // Inside markup. A later version enumerated quotes and whitespace and
      // still missed this, which is why the check is now a negative lookahead.
      "const html = `<code>postgres://postgres:postgres@localhost</code>`;",
    ].join("\n");
    expect(secrets.scan(at("tools/dev-setup.mjs", text))).toHaveLength(0);
  });

  it("still catches a remote connection string", () => {
    const f = secrets.scan(at("cfg.ts", 'const db = "postgres://u:realpass123@db.prod.acme-corp.io/app";'));
    expect(rules(f)).toContain("secrets/connection-string");
  });

  it("treats an RFC 2606 documentation domain as a placeholder", () => {
    // example.com, .net, .org and .test are reserved for documentation, so a
    // credential pointing at one is a sample by definition. A hostname that
    // merely contains the word is not, which is why the check cannot be a plain
    // word match.
    expect(secrets.scan(at("d.md", 'db = "postgres://u:realpass123@db.example.net/app"'))).toHaveLength(0);
    expect(
      rules(secrets.scan(at("d.ts", 'db = "postgres://u:realpass123@db.example-corp.io/app"')))
    ).toContain("secrets/connection-string");
  });

  it("downgrades fixture credentials in test files to warnings", () => {
    // On a real repository, credential-shaped strings inside .spec.ts files were
    // 35% of every finding and all of them were intentional test data.
    const f = secrets.scan(at("src/auth/login.spec.ts", 'const password = "Str0ngPassw0rd";'));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("warn");
  });

  it("keeps a live Stripe key blocking even inside a test file", () => {
    // Stripe separates live from test credentials by prefix, so sk_live_ in a
    // spec file is not plausible fixture data the way a made-up password is.
    const f = secrets.scan(at("src/pay.spec.ts", 'const k = "sk_live_abcdefghij1234567890";'));
    expect(f).toHaveLength(1);
    expect(f[0].severity).toBe("error");
  });

  it("honours an acknowledgement that carries a reason", () => {
    const text =
      'const db = "postgres://u:realpw12345@h.acme-corp.io/d"; // bouncer-gates-ok(secrets): documented sample';
    expect(secrets.scan(at("t.ts", text))).toHaveLength(0);
  });

  it("ignores a bare acknowledgement with no reason", () => {
    const text = 'const db = "postgres://u:realpw12345@h.acme-corp.io/d"; // bouncer-gates-ok(secrets):';
    expect(secrets.scan(at("t.ts", text))).toHaveLength(1);
  });

  it("never puts the matched text into the finding", () => {
    const leak = "sk_live_abcdefghij1234567890";
    const f = secrets.scan(at("k.ts", `const k = "${leak}";`));
    expect(f).toHaveLength(1);
    expect(JSON.stringify(f)).not.toContain(leak);
  });
});

describe("scope", () => {
  const cfg = { models: ["order", "customer"], tables: ["orders"], column: "tenantId", rawAccessor: "raw" };

  it("catches the raw client, an alias of it, and unscoped raw SQL", () => {
    const text = [
      "const a = await db.raw.order.findMany();",
      "const c = db.raw;",
      "const d = await c.customer.findMany();",
      "await db.$queryRaw(`SELECT * FROM orders`);",
    ].join("\n");
    expect(rules(scope.scan(at("s.ts", text), cfg))).toEqual([
      "scope/raw-client",
      "scope/raw-alias",
      "scope/raw-sql",
    ]);
  });

  it("stays quiet on the scoped client and on scoped SQL", () => {
    const text = [
      "const a = await db.forTenant(id).order.findMany();",
      "await db.$queryRaw(`SELECT * FROM orders WHERE tenantId = $1`, id);",
      "const x = await db.raw.auditLog.findMany();",
    ].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("does not let the next statement launder the previous one", () => {
    // The window used to run a fixed number of lines forward, so the scoped
    // query below cleared the unscoped one above it. That failed open, which is
    // the only direction that actually hurts.
    const text = [
      "await db.$queryRaw(`SELECT * FROM orders WHERE id = 1`);",
      "await db.$queryRaw(`SELECT * FROM orders WHERE tenantId = $1`, id);",
    ].join("\n");
    const f = scope.scan(at("s.ts", text), cfg);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(1);
  });

  it("does not flag its own documentation", () => {
    const text = [" * Example of the bad pattern:", " *     db.raw.order.findMany()", "const ok = 1;"].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("does nothing at all when no models are configured", () => {
    expect(scope.scan(at("s.ts", "const a = await db.raw.order.findMany();"), {})).toHaveLength(0);
  });

  it("returns identical results when called twice with an equivalent config object", () => {
    // The compiled-config cache is keyed on values, not object identity. If that
    // were wrong the hosted API would answer the second request from a stale
    // compilation, which is the kind of bug that only shows up in production.
    const text = "const a = await db.raw.order.findMany();";
    const first = scope.scan(at("s.ts", text), { ...cfg });
    const second = scope.scan(at("s.ts", text), { ...cfg });
    expect(second).toEqual(first);
  });
});

describe("money", () => {
  it("catches float conversion to minor units", () => {
    expect(rules(money.scan(at("m.ts", "const minor = Math.round(parseFloat(input) * 100);")))).toContain(
      "money/float-to-minor"
    );
  });

  it("catches a hardcoded exponent on a currency value", () => {
    expect(rules(money.scan(at("m.ts", "const display = totalAmount / 100;")))).toContain(
      "money/hardcoded-exponent"
    );
  });

  it("stays quiet on integer minor units and non-money maths", () => {
    const text = [
      "const minor = decimalToMinor(input, currency);",
      "const total = lineItems.reduce((a, b) => a + b.amountMinor, 0);",
    ].join("\n");
    expect(money.scan(at("m.ts", text))).toHaveLength(0);
  });

  it("does not flag a comment that describes the bug", () => {
    expect(
      money.scan(at("m.ts", "// never write Math.round(parseFloat(x) * 100), it rounds 10.005 down"))
    ).toHaveLength(0);
  });

  it("does not flag percentages rendered with a percent sign", () => {
    // Real false positives from a production repository.
    const text = [
      "const label = den > 0 ? `${Math.round((num / den) * 100)}%` : '-';",
      "const title = `showing at ${Math.round(scale * 100)}%`;",
    ].join("\n");
    expect(money.scan(at("ui.tsx", text))).toHaveLength(0);
  });

  it("does not flag a ratio scaled to 100 even with no percent sign", () => {
    // Also real. These two escaped the naming heuristic; what they share is a
    // division inside the rounded expression, which money conversion never has.
    const text = [
      "const trim = Math.round((1 - canvasAspect / targetAspect) * 100);",
      "const bars = bins.map((count) => Math.round((count / maxBin) * 100));",
    ].join("\n");
    expect(money.scan(at("img.ts", text))).toHaveLength(0);
  });

  it("does not let a money-ish word overrule an explicit percentage", () => {
    // `total` is in the money vocabulary and is also an ordinary counting word.
    // This exact line was reported as a currency bug on a progress indicator.
    const text = "const pct = total ? Math.round((done / total) * 100) : 0;";
    expect(money.scan(at("pill.tsx", text))).toHaveLength(0);
  });

  it("still reports a genuine per-unit money calculation that divides", () => {
    const text = "const unitMinor = Math.round((priceMajor / quantity) * 100);";
    expect(rules(money.scan(at("m.ts", text)))).toContain("money/float-to-minor");
  });

  it("downgrades money findings inside test files", () => {
    const f = money.scan(at("src/x.spec.ts", "const minor = Math.round(parseFloat(input) * 100);"));
    expect(sev(f)).toEqual(["warn"]);
  });
});

describe("migration-safety", () => {
  it("catches the statements that break the previous app version", () => {
    const f = migration.scan(
      at(
        "001.sql",
        [
          "ALTER TABLE orders DROP COLUMN legacy_ref;",
          "ALTER TABLE orders RENAME COLUMN total TO total_minor;",
          "ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL;",
          "DROP TABLE old_carts;",
        ].join("\n")
      )
    );
    expect(rules(f)).toEqual(
      expect.arrayContaining([
        "migration/drop-column",
        "migration/rename",
        "migration/add-not-null",
        "migration/drop-table",
      ])
    );
  });

  it("catches a NOT NULL that wraps across lines", () => {
    // The line-based version missed this entirely: ADD COLUMN and NOT NULL were
    // on different lines, so no single line matched and the migration passed.
    // Prisma emits single-line DDL, which is why it looked fine in testing.
    const sql = ["ALTER TABLE orders", "  ADD COLUMN currency VARCHAR(3)", "  NOT NULL;"].join("\n");
    const f = migration.scan(at("002.sql", sql));
    expect(rules(f)).toEqual(["migration/add-not-null"]);
    expect(f[0].line).toBe(1);
  });

  it("allows an added column that is nullable, or has a default", () => {
    const text = [
      "ALTER TABLE orders ADD COLUMN note TEXT;",
      "ALTER TABLE orders ADD COLUMN currency VARCHAR(3) NOT NULL DEFAULT 'EUR';",
    ].join("\n");
    expect(migration.scan(at("003.sql", text))).toHaveLength(0);
  });

  it("catches tightening an existing column to NOT NULL", () => {
    const f = migration.scan(at("004.sql", "ALTER TABLE orders ALTER COLUMN note SET NOT NULL;"));
    expect(rules(f)).toEqual(["migration/set-not-null"]);
  });

  it("warns about a non-concurrent index but does not block on it", () => {
    const f = migration.scan(at("005.sql", "CREATE INDEX idx_orders_tenant ON orders (tenant_id);"));
    expect(f[0].rule).toBe("migration/blocking-index");
    expect(f[0].severity).toBe("warn");
  });

  it("accepts a concurrent index", () => {
    expect(
      migration.scan(at("006.sql", "CREATE INDEX CONCURRENTLY idx_x ON orders (tenant_id);"))
    ).toHaveLength(0);
  });

  it("warns about a validated foreign key and accepts NOT VALID", () => {
    const bad = migration.scan(
      at("007.sql", "ALTER TABLE orders ADD CONSTRAINT fk_c FOREIGN KEY (c_id) REFERENCES customers(id);")
    );
    expect(rules(bad)).toEqual(["migration/validated-fk"]);
    const good = migration.scan(
      at(
        "008.sql",
        "ALTER TABLE orders ADD CONSTRAINT fk_c FOREIGN KEY (c_id) REFERENCES customers(id) NOT VALID;"
      )
    );
    expect(good).toHaveLength(0);
  });

  it("respects a file-level acknowledgement", () => {
    const text = [
      "-- bouncer-gates-ok(migration): add_referrals never reached production",
      "DROP TABLE referrals;",
    ].join("\n");
    expect(migration.scan(at("009.sql", text))).toHaveLength(0);
  });

  it("does not split a statement on a semicolon inside a string literal", () => {
    const sql = "INSERT INTO settings (k, v) VALUES ('greeting', 'hi; bye');";
    expect(migration.statements(sql)).toHaveLength(1);
  });

  it("ignores semicolons inside comments and dollar-quoted bodies", () => {
    const sql = [
      "-- a comment; with a semicolon",
      "CREATE FUNCTION f() RETURNS void AS $$",
      "BEGIN; PERFORM 1; END;",
      "$$ LANGUAGE plpgsql;",
    ].join("\n");
    expect(migration.statements(sql)).toHaveLength(1);
  });

  it("reports the line the statement started on", () => {
    const sql = ["-- header", "", "DROP TABLE a;", "", "DROP TABLE b;"].join("\n");
    expect(migration.scan(at("010.sql", sql)).map((f) => f.line)).toEqual([3, 5]);
  });
});

describe("doc-links", () => {
  const repo = ["README.md", "docs/guide.md", "docs/img/x.png", "gates/scope.mjs"];

  it("catches a relative link to a file that does not exist", () => {
    expect(rules(docLinks.scan(at("README.md", "See [the guide](docs/missing.md)."), repo))).toEqual([
      "doc-links/broken",
    ]);
  });

  it("resolves links relative to the file, including parent traversal", () => {
    const text = "[up](../README.md) and [sibling](guide.md) and [dir](img/)";
    expect(docLinks.scan(at("docs/other.md", text), repo)).toHaveLength(0);
  });

  it("ignores external links, anchors, and images", () => {
    const text = [
      "[site](https://example.com)",
      "[mail](mailto:a@b.c)",
      "[anchor](#section)",
      "![pic](docs/img/x.png)",
      "[with anchor](docs/guide.md#setup)",
    ].join("\n");
    expect(docLinks.scan(at("README.md", text), repo)).toHaveLength(0);
  });

  it("decodes percent-escaped paths before checking them", () => {
    expect(docLinks.scan(at("README.md", "[g](docs/guide.md)"), repo)).toHaveLength(0);
    expect(docLinks.scan(at("README.md", "[g](docs%2Fguide.md)"), ["docs/guide.md"])).toHaveLength(0);
  });

  it("does not report a root-absolute link with no extension as broken", () => {
    // Found by running this gate over a Next.js site, where `/work/estate` is a
    // route the renderer resolves against the deployment, not a file. The same
    // syntax means repo-root on GitHub, so only the extension separates the two
    // readings, and guessing wrong here fires on every content-driven website.
    expect(docLinks.scan(at("blog/post.md", "[estate](/work/estate)"), repo)).toHaveLength(0);
  });

  it("still reports a root-absolute link to a missing document", () => {
    expect(rules(docLinks.scan(at("blog/post.md", "[g](/docs/gone.md)"), repo))).toEqual([
      "doc-links/broken",
    ]);
    expect(docLinks.scan(at("blog/post.md", "[g](/docs/guide.md)"), repo)).toHaveLength(0);
  });

  it("does not report a link that climbs above the repository root", () => {
    // A monorepo doc legitimately pointing at a sibling package outside the git
    // root is not something this gate can judge, so it says nothing.
    expect(docLinks.scan(at("docs/a.md", "[x](../../other/pkg/README.md)"), repo)).toHaveLength(0);
  });

  it("does not carry regex state between files", () => {
    const files = [
      { path: "a.md", text: "[x](docs/missing.md)" },
      { path: "b.md", text: "[y](docs/missing.md)" },
    ];
    expect(docLinks.scan(files, repo)).toHaveLength(2);
  });
});
