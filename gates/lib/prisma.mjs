/**
 * Read tenant-owned models out of a Prisma schema.
 *
 * The scope gate needs a list of models, and the docs have always said that
 * list should come from the schema rather than be typed by hand, because a
 * model nobody added to the config is a model nobody is checking. This is the
 * function that makes that true. `bouncer --init` calls it; it is here rather
 * than in the runner so it can be tested on a string.
 *
 * A model is tenant-owned when it has a field with the configured column name.
 * The Prisma client property is the model name with its first letter lowered,
 * and the table is the `@@map` if there is one, else the model name.
 *
 * @param {string} schema   the text of a .prisma file
 * @param {string} column   the tenant column, e.g. "tenantId"
 * @returns {{model: string, table: string}[]}
 */
export function prismaTenantModels(schema, column) {
  const out = [];
  const model = /\bmodel\s+(\w+)\s*\{([^}]*)\}/g;
  const field = new RegExp("^\\s*" + column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s+\\w", "m");
  for (const m of schema.matchAll(model)) {
    const [, name, body] = m;
    if (!field.test(body)) continue;
    const map = body.match(/@@map\(\s*"([^"]+)"\s*\)/);
    out.push({
      model: name.charAt(0).toLowerCase() + name.slice(1),
      table: map ? map[1] : name,
    });
  }
  return out;
}

/**
 * Guess the tenant column from the schema.
 *
 * Not every codebase calls it tenantId. The first real schema this was pointed
 * at used storeId on 52 models and had no tenantId anywhere, so --init with a
 * fixed name found nothing. The tenant column is the owner-shaped field that
 * appears on the most models; the tie-break prefers the conventional names.
 *
 * @returns {string} the column name, or "tenantId" when nothing owner-shaped exists
 */
export function detectTenantColumn(schema) {
  const OWNER = /^\s*((?:tenant|org|organization|organisation|workspace|store|merchant|shop|account|company|team|customer)Id)\s+\w/gim;
  const counts = new Map();
  for (const m of schema.matchAll(OWNER)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  if (!counts.size) return "tenantId";
  const rank = (name) => (/^tenant/i.test(name) ? 2 : /^(?:org|organi[sz]ation|workspace)Id$/i.test(name) ? 1 : 0);
  return [...counts].sort((a, b) => b[1] - a[1] || rank(b[0]) - rank(a[0]))[0][0];
}

/** `git@github.com:a/b.git` or `https://github.com/a/b.git` to `https://github.com/a/b`. */
export function repoUrlFromRemote(remote) {
  const s = String(remote ?? "").trim();
  if (!s) return "";
  const ssh = s.match(/^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  const http = s.match(/^https?:\/\/(?:[^@/]+@)?([\w.-]+)\/(.+?)(?:\.git)?\/?$/);
  if (http) return `https://${http[1]}/${http[2]}`;
  return "";
}
