import { describe, it, expect } from "vitest";
import * as secrets from "../gates/secrets.mjs";
import * as scope from "../gates/scope.mjs";
import * as money from "../gates/money.mjs";
import * as migration from "../gates/migration-safety.mjs";
import * as docLinks from "../gates/doc-links.mjs";
import { prismaTenantModels, detectTenantColumn, repoUrlFromRemote } from "../gates/lib/prisma.mjs";

/**
 * The second round of false positives and misses, found by reading each gate
 * against inputs it had never been shown. Same rule as gates.test.mjs: every
 * quiet case here is a mistake the tool made, and the test is what stops it
 * being made twice.
 */

const at = (path, text) => [{ path, text }];
const rules = (findings) => findings.map((f) => f.rule);

describe("secrets, second pass", () => {
  it("judges the credential, not the whole line", () => {
    // The placeholder allowance used to read the entire line, so any line that
    // also contained "null", "test" or "undefined" excused a real password.
    expect(rules(secrets.scan(at("a.ts", 'const cfg = { password: "Hunter2Hunter2!", other: null };')))).toEqual([
      "secrets/assigned-credential",
    ]);
    expect(rules(secrets.scan(at("a.ts", 'const password = "Hunter2Hunter2!"; // test')))).toEqual([
      "secrets/assigned-credential",
    ]);
  });

  it("still excuses a placeholder inside the credential itself", () => {
    const text = ['const password = "${DB_PASSWORD}";', 'const apiKey = "your-api-key-here";'].join("\n");
    expect(secrets.scan(at("a.ts", text))).toHaveLength(0);
  });

  it("stays quiet on the AWS documentation key", () => {
    // AKIAIOSFODNN7EXAMPLE appears in every AWS guide. The 7 glues EXAMPLE to
    // the token, so a word-boundary placeholder check never saw it.
    expect(secrets.scan(at("a.ts", 'const k = "AKIAIOSFODNN7EXAMPLE";'))).toHaveLength(0);
  });

  it("does not let EXAMPLE in a hostname excuse a real connection string", () => {
    expect(rules(secrets.scan(at("a.ts", 'db = "postgres://u:realpass123@db.example-corp.io/app"')))).toEqual([
      "secrets/connection-string",
    ]);
  });

  it("catches unquoted credentials in a committed .env file", () => {
    const text = ["DB_PASSWORD=Hunter2Hunter2!", "PORT=3000", "STRIPE_SECRET_KEY=sk_test_abcdefghijklmnopqrstuvwxyz"].join("\n");
    const f = secrets.scan(at(".env", text));
    expect(rules(f)).toEqual(["secrets/env-file-credential", "secrets/env-file-credential"]);
    expect(f.map((x) => x.line)).toEqual([1, 3]);
  });

  it("leaves .env.example alone, and leaves an ordinary file alone", () => {
    expect(secrets.scan(at(".env.example", "DB_PASSWORD=Hunter2Hunter2!"))).toHaveLength(0);
    expect(secrets.scan(at("config/.env.sample", "API_TOKEN=abcdefghijkl"))).toHaveLength(0);
    // Same line in a .ts file is not the env rule's business.
    expect(secrets.scan(at("a.ts", "DB_PASSWORD=Hunter2Hunter2!"))).toHaveLength(0);
  });

  it("still excuses placeholders in a committed .env", () => {
    expect(secrets.scan(at(".env", "DB_PASSWORD=changeme\nAPI_KEY=your-key-here\nSECRET=<fill-me-in>"))).toHaveLength(0);
  });

  it("recognises the common key prefixes added in 0.3", () => {
    const text = [
      'const g = "AIzaSyA1234567890abcdefghijklmnopqrstuv";',
      "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789",
      'const gl = "glpat-abcdefghijklmnopqrstuvwx";',
      'const a = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";',
    ].join("\n");
    expect(rules(secrets.scan(at("k.ts", text)))).toEqual([
      "secrets/google-api-key",
      "secrets/npm-token",
      "secrets/gitlab-token",
      "secrets/openai-key",
    ]);
  });
});

describe("money, second pass", () => {
  it("does not flag a rate or a percentage divided by 100", () => {
    // Every checkout has one of these. "tax" and "discount" are money words, but
    // taxRate and discountPercent are rates, and the identifier says so.
    const text = [
      "const tax = subtotal * taxRate / 100;",
      "const off = price * (discountPercent / 100);",
      "const d = Number(discountPct);",
      "const fee = amount * feeRate / 100;",
    ].join("\n");
    expect(money.scan(at("checkout.ts", text))).toHaveLength(0);
  });

  it("still flags an amount scaled by a hardcoded 100", () => {
    expect(rules(money.scan(at("m.ts", "const minor = amount * 100;")))).toEqual(["money/hardcoded-exponent"]);
    expect(rules(money.scan(at("m.ts", "const n = parseFloat(priceInput);")))).toEqual(["money/float-parse"]);
  });
});

describe("migration-safety, second pass", () => {
  it("sees a DEFAULT on the next line", () => {
    // The old lookahead stopped at end of line, so this safe column was reported.
    const sql = ["ALTER TABLE orders", "  ADD COLUMN currency VARCHAR(3)", "  NOT NULL DEFAULT 'USD';"].join("\n");
    expect(migration.scan(at("1.sql", sql))).toHaveLength(0);
  });

  it("checks each ADD clause on its own", () => {
    // The first clause's DEFAULT used to excuse the second, which has none.
    const sql = "ALTER TABLE t ADD COLUMN a INT DEFAULT 1, ADD COLUMN b INT NOT NULL;";
    expect(rules(migration.scan(at("2.sql", sql)))).toEqual(["migration/add-not-null"]);
    const safe = "ALTER TABLE t ADD COLUMN a DECIMAL(10, 2) NOT NULL DEFAULT 0, ADD COLUMN b TEXT;";
    expect(migration.scan(at("3.sql", safe))).toHaveLength(0);
  });

  it("allows a NOT NULL identity or serial column", () => {
    const sql = "ALTER TABLE t ADD COLUMN seq BIGINT GENERATED ALWAYS AS IDENTITY NOT NULL;";
    expect(migration.scan(at("4.sql", sql))).toHaveLength(0);
  });

  it("does not call DROP DEFAULT or DROP NOT NULL a dropped column", () => {
    const sql = ["ALTER TABLE orders ALTER COLUMN currency DROP DEFAULT;", "ALTER TABLE orders ALTER COLUMN note DROP NOT NULL;"].join("\n");
    expect(migration.scan(at("5.sql", sql))).toHaveLength(0);
    expect(rules(migration.scan(at("6.sql", "ALTER TABLE orders DROP legacy_ref;")))).toEqual(["migration/drop-column"]);
  });

  it("ignores renaming an index or a constraint", () => {
    const sql = ["ALTER INDEX idx_a RENAME TO idx_b;", "ALTER TABLE t RENAME CONSTRAINT c1 TO c2;"].join("\n");
    expect(migration.scan(at("7.sql", sql))).toHaveLength(0);
    expect(rules(migration.scan(at("8.sql", "ALTER TABLE t RENAME COLUMN a TO b;")))).toEqual(["migration/rename"]);
  });

  it("does not warn about locks on a table this migration creates", () => {
    // Every Prisma migration that creates a table then indexes it looked like
    // this, and produced two warnings about a table with no rows and no readers.
    const sql = [
      'CREATE TABLE "Order" ("id" TEXT PRIMARY KEY, "tenantId" TEXT NOT NULL);',
      'CREATE INDEX "Order_tenantId_idx" ON "Order"("tenantId");',
      'ALTER TABLE "Order" ADD CONSTRAINT "Order_tenant_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id");',
      'ALTER TABLE "Order" ADD COLUMN "status" TEXT NOT NULL;',
    ].join("\n");
    expect(migration.scan(at("9.sql", sql))).toHaveLength(0);
  });

  it("still warns about the same statements on an existing table", () => {
    const sql = [
      'CREATE INDEX "Order_status_idx" ON "Order"("status");',
      'ALTER TABLE public."Order" ADD CONSTRAINT fk FOREIGN KEY ("customerId") REFERENCES "Customer"("id");',
    ].join("\n");
    expect(rules(migration.scan(at("10.sql", sql)))).toEqual(["migration/blocking-index", "migration/validated-fk"]);
  });
});

describe("scope, direct client mode", () => {
  const cfg = { models: ["order", "customer"], tables: ["orders"], column: "tenantId", clients: ["prisma", "db"] };

  it("flags a list query on a tenant-owned model with no tenant column", () => {
    const text = [
      'const rows = await prisma.order.findMany({ where: { status: "paid" } });',
      "const n = await this.prisma.customer.count();",
    ].join("\n");
    const f = scope.scan(at("s.ts", text), cfg);
    expect(rules(f)).toEqual(["scope/unscoped-query", "scope/unscoped-query"]);
    expect(f[0].message).toContain('"order"');
  });

  it("accepts the column anywhere in the call, including across lines", () => {
    const text = [
      "const rows = await prisma.order.findMany({",
      "  where: { tenantId, status: 'paid' },",
      "});",
      "const c = await db.customer.count({ where: tenantWhere(req) });",
    ].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("leaves single-row lookups and non-tenant models alone", () => {
    const text = [
      "const one = await prisma.order.findUnique({ where: { id } });",
      "const logs = await prisma.auditLog.findMany();",
      "const ok = await prisma.$queryRaw`SELECT 1`;",
    ].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });

  it("does not run at all when no clients are listed", () => {
    const text = 'const rows = await prisma.order.findMany({ where: { status: "paid" } });';
    expect(scope.scan(at("s.ts", text), { ...cfg, clients: [] })).toHaveLength(0);
  });

  it("honours an acknowledgement", () => {
    const text = ["// bouncer-gates-ok(scope): nightly revenue report spans every tenant by design", "const all = await prisma.order.findMany();"].join("\n");
    expect(scope.scan(at("s.ts", text), cfg)).toHaveLength(0);
  });
});

describe("doc-links, second pass", () => {
  const repo = ["README.md", "docs/guide.md"];

  it("does not read a link inside a code fence or an inline span as a link", () => {
    // The gate reference shows "[setup](docs/setup.md)" as its example of a
    // broken link, and the gate reported its own example.
    const text = [
      "Real link: [guide](docs/guide.md)",
      "",
      "```markdown",
      "See [the setup guide](docs/setup.md).",
      "```",
      "",
      "Inline: `[x](docs/nope.md)` and ``code with a ` inside [y](docs/nope2.md)``.",
      "~~~",
      "[z](docs/nope3.md)",
      "~~~",
    ].join("\n");
    expect(docLinks.scan(at("README.md", text), repo)).toHaveLength(0);
  });

  it("still reports a broken link after a code block, on the right line", () => {
    const text = ["```", "[a](docs/nope.md)", "```", "", "[b](docs/missing.md)"].join("\n");
    const f = docLinks.scan(at("README.md", text), repo);
    expect(f).toHaveLength(1);
    expect(f[0].line).toBe(5);
  });

  it("treats an unclosed backtick as ordinary text", () => {
    const text = "A stray ` and then [b](docs/missing.md)";
    expect(docLinks.scan(at("README.md", text), repo)).toHaveLength(1);
  });
});

describe("--init helpers", () => {
  it("reads tenant-owned models out of a Prisma schema", () => {
    const schema = [
      "model Tenant { id String @id }",
      "model Order {",
      "  id       String @id",
      "  tenantId String",
      "  tenant   Tenant @relation(fields: [tenantId], references: [id])",
      '  @@map("orders")',
      "}",
      "model AuditLog { id String @id }",
      "model CustomerProfile {",
      "  id String @id",
      "  tenantId String",
      "}",
    ].join("\n");
    expect(prismaTenantModels(schema, "tenantId")).toEqual([
      { model: "order", table: "orders" },
      { model: "customerProfile", table: "CustomerProfile" },
    ]);
  });

  it("does not mistake a relation field for the tenant column", () => {
    const schema = "model Order {\n  id String @id\n  tenant Tenant @relation(fields: [tenantId], references: [id])\n}";
    expect(prismaTenantModels(schema, "tenantId")).toEqual([]);
  });

  it("guesses the tenant column from the schema", () => {
    // A real schema used storeId on 52 models and had no tenantId at all.
    const store = "model A {\n  storeId String\n  productId String\n}\nmodel B {\n  storeId String\n}\nmodel C {\n  productId String\n}";
    expect(detectTenantColumn(store)).toBe("storeId");
    expect(detectTenantColumn("model A {\n  orgId String\n}\nmodel B {\n  tenantId String\n}")).toBe("tenantId");
    expect(detectTenantColumn("model A {\n  id String @id\n}")).toBe("tenantId");
  });

  it("turns a git remote into a browsable URL", () => {
    expect(repoUrlFromRemote("git@github.com:ajeermahmood/bouncer-gates.git")).toBe("https://github.com/ajeermahmood/bouncer-gates");
    expect(repoUrlFromRemote("https://github.com/ajeermahmood/bouncer-gates.git\n")).toBe("https://github.com/ajeermahmood/bouncer-gates");
    expect(repoUrlFromRemote("")).toBe("");
  });
});
