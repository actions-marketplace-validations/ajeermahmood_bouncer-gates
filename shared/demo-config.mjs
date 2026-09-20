/**
 * The configuration the hosted demos run with.
 *
 * This file exists because the same five lines of config had been copy-pasted
 * into the Cloudflare Worker, the Pages Function, the Railway service, the
 * browser playground and the benchmark. The gate *logic* was correctly shared;
 * the gate *configuration* was duplicated five times, so adding a tenant-owned
 * model would have updated one caller and silently left four answering
 * differently.
 *
 * That is precisely the drift this project argues against, sitting in the
 * project itself. Worth writing down, because it is the failure mode of "we
 * share the important part" everywhere: the important part is whatever is
 * actually different between two runs, and configuration usually is.
 *
 * Deliberately dependency-free and side-effect-free, like `gates/`, so it can be
 * imported by a Worker, a Node service and a browser bundle without ceremony.
 *
 * Note this is DEMO config, not a default. `gates/scope.mjs` still ships with an
 * empty model list, and a repository that configures nothing gets a gate that
 * reports skipped rather than one that quietly checks somebody else's model
 * names.
 */

/** Plausible tenant-owned models, for the public demos only. */
export const DEMO_SCOPE_CONFIG = Object.freeze({
  models: ["order", "customer", "invoice", "subscription", "payment"],
  tables: ["orders", "customers", "invoices", "subscriptions", "payments"],
  column: "tenantId",
  rawAccessor: "raw",
  // Direct-client mode, so the playground demonstrates the check that applies to
  // most codebases rather than only the one that applies to codebases which
  // already have a tenant-scoped wrapper.
  //
  // This was added to the gate in 0.3.0 and not here, so for two releases the
  // public demo quietly answered "nothing wrong" to the single most likely thing
  // a visitor would paste:
  //
  //     prisma.order.findMany({ where: { status: "paid" } })
  //
  // The gate was right and the demo was misconfigured, which is the worse of the
  // two: a visitor concludes the tool does not catch much and leaves.
  clients: ["prisma", "db"],
});

/**
 * The gates that cannot answer for a single pasted snippet, and why.
 *
 * Every hosted endpoint returns this alongside its findings. Handing back three
 * gates' results while letting the caller believe five ran is the same failure
 * the CLI avoids by printing "skipped" with a reason instead of passing quietly.
 */
export const UNAVAILABLE = Object.freeze([
  Object.freeze({
    gate: "migration-safety",
    reason: "needs git history to know which migrations are new",
  }),
  Object.freeze({
    gate: "doc-links",
    reason: "needs the repository file list to check a link resolves",
  }),
]);

/** Largest snippet any hosted endpoint will accept. */
export const MAX_SNIPPET_BYTES = 64 * 1024;
