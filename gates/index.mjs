import * as secrets from "./secrets.mjs";
import * as scope from "./scope.mjs";
import * as money from "./money.mjs";
import * as migrationSafety from "./migration-safety.mjs";
import * as docLinks from "./doc-links.mjs";

/**
 * The registry.
 *
 * `needs` declares what a gate wants, so the runner can gather it once instead of
 * every gate reaching for the filesystem itself:
 *
 *   source        every tracked source file, with lines pre-split
 *   markdown      every tracked markdown file
 *   repoFiles     the full path list, for existence checks
 *   addedSql      .sql files added relative to the base branch
 *
 * `skipWhen` returns a REASON STRING when the gate cannot or need not run, and a
 * falsy value otherwise. The runner prints that reason and marks the gate
 * skipped rather than passed. Returning a reason instead of a boolean is what
 * makes the difference between the two skips below visible, and that distinction
 * is the whole safety property:
 *
 *   "no new migrations in this change"      we looked, there was nothing to check
 *   "cannot see history"                    we could not look at all
 *
 * The second one used to render as the first. A shallow CI clone has no base ref,
 * so no migrations appear added, so the gate reported the reassuring message and
 * everybody assumed migrations were being checked. They were not, for as long as
 * nobody looked. Adding a gate is easy; the hard part is making sure a green run
 * means what people think it means.
 *
 * Adding a gate means adding an entry here and nothing else.
 */
export const GATES = [
  {
    ...secrets,
    needs: ["source"],
    run: (ctx, cfg) => secrets.scan(ctx.source, cfg.secrets),
  },
  {
    ...scope,
    needs: ["source"],
    run: (ctx, cfg) => scope.scan(ctx.source, cfg.scope),
    skipWhen: (ctx, cfg) =>
      !cfg?.scope?.models?.length && !cfg?.scope?.tables?.length
        ? "no tenant-owned models configured, see bouncer-gates.config.json"
        : null,
  },
  {
    ...money,
    needs: ["source"],
    run: (ctx) => money.scan(ctx.source),
  },
  {
    ...migrationSafety,
    needs: ["addedSql"],
    run: (ctx) => migrationSafety.scan(ctx.addedSql),
    skipWhen: (ctx) => {
      if (!ctx.baseAvailable) {
        return (
          `cannot see history: the base ref "${ctx.baseRef}" is not in this clone, ` +
          `so no migration can be identified as new. Add fetch-depth: 0 to your checkout`
        );
      }
      return ctx.addedSql.length === 0 ? "no new migrations in this change" : null;
    },
  },
  {
    ...docLinks,
    needs: ["markdown", "repoFiles"],
    run: (ctx, cfg) => docLinks.scan(ctx.markdown, ctx.repoFiles, cfg["doc-links"]),
  },
];

