/**
 * The one shape every gate speaks.
 *
 * Gates are PURE. A gate is handed an array of { path, text, lines } and returns
 * findings. It does not read the filesystem, shell out to git, or print
 * anything. That constraint is the whole architecture:
 *
 *   - `bin/bouncer-gates.mjs` reads files from disk and runs the same functions in CI
 *   - `functions/api/scan.js` runs them inside a Cloudflare Worker, where there
 *     IS no filesystem, so the playground on the site executes the real gates
 *     rather than a reimplementation that can drift from them
 *   - `server/index.mjs` runs them as a long-lived Node service on Railway
 *   - the tests run them on string literals, with no fixtures on disk
 *
 * One consequence worth naming: a gate that needs git history (see
 * `migration-safety`) takes that history as an INPUT rather than fetching it.
 * The caller decides where history comes from, so the gate stays testable.
 */

export const ERROR = "error";
export const WARN = "warn";

/**
 * @param {object} f
 * @param {string} f.path      file the finding is in
 * @param {number} f.line      1-indexed line
 * @param {string} f.rule      stable id, e.g. "secrets/private-key"
 * @param {string} f.message   what is wrong, in plain words
 * @param {string} [f.fix]     what to do instead
 * @param {string} [f.severity]
 */
export function finding({ path, line, rule, message, fix, severity = ERROR }) {
  return { path, line, rule, message, fix, severity };
}

/** 1-indexed line number for a character offset. */
export function lineAt(text, index) {
  let line = 1;
  const stop = Math.min(index, text.length);
  for (let i = 0; i < stop; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Split once, reuse everywhere.
 *
 * The runner attaches `lines` to each file before handing it to any gate, so a
 * repository with three line-based gates splits each file once rather than three
 * times. On a 1,200 file repository that removed about a third of total runtime,
 * which is the sort of thing that only shows up if you measure rather than
 * assume.
 */
export function lines(file) {
  if (typeof file === "string") return file.split(/\r\n|\r|\n/);
  return file.lines ?? (file.lines = file.text.split(/\r\n|\r|\n/));
}

/**
 * An escape hatch every gate honours, so the gates stay usable.
 *
 * A gate with no way to say "I know, and it is fine here" gets deleted the first
 * week it blocks something legitimate. The rule is that the acknowledgement must
 * carry a REASON, on the offending line or the line above it:
 *
 *     const rows = await db.raw(sql); // bouncer-gates-ok(scope): admin report, all tenants
 *
 * A bare `bouncer-gates-ok` with no reason does not count. That is what keeps this from
 * decaying into a blanket ignore comment.
 *
 * The regex is cached per gate name. It used to be rebuilt on every line of every
 * file, which meant one RegExp compilation per line per gate: the single hottest
 * allocation in the whole program, and invisible until profiled.
 */
const ACK_CACHE = new Map();

export function acknowledged(allLines, lineIndex, gateName) {
  // Cheap reject first. Most lines contain no acknowledgement at all, and
  // indexOf on a short string is far cheaper than running a regex.
  const here = allLines[lineIndex];
  const above = lineIndex > 0 ? allLines[lineIndex - 1] : "";
  const hasHere = here !== undefined && here.indexOf("bouncer-gates-ok") !== -1;
  const hasAbove = above !== undefined && above.indexOf("bouncer-gates-ok") !== -1;
  if (!hasHere && !hasAbove) return false;

  let re = ACK_CACHE.get(gateName);
  if (!re) {
    re = new RegExp("bouncer-gates-ok\\(" + escapeRe(gateName) + "\\)\\s*:\\s*\\S+");
    ACK_CACHE.set(gateName, re);
  }
  return (hasHere && re.test(here)) || (hasAbove && re.test(above));
}

export function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-line comments in the common languages. A comment showing the bad
 *  pattern is not the bad pattern, including a gate's own documentation. */
export function isCommentLine(line) {
  return /^\s*(?:\/\/|\*\/|\*|\/\*|#(?!!)|--)/.test(line);
}

/**
 * Test and fixture files.
 *
 * These matter because a test suite legitimately contains the exact strings the
 * gates hunt for. Running against a real 1,200 file repository, hardcoded
 * credentials inside `.spec.ts` files were 35% of all findings, and every one of
 * them was intentional test data.
 *
 * Excluding these files outright would be wrong: a real key does sometimes get
 * pasted into a test. So `secrets` downgrades most rules to a warning here
 * instead, and keeps rules for provably live credentials at error. Noise falls
 * away, the signal that actually matters does not.
 */
export function isTestFile(path) {
  const p = path.replace(/\\/g, "/");
  return (
    /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(p) ||
    /(?:^|\/)(?:__tests__|__mocks__|__fixtures__|tests?|fixtures|e2e)\//.test(p)
  );
}

/**
 * A stable identity for a finding, used by the baseline.
 *
 * Deliberately NOT the line number. A baseline keyed on line numbers is
 * invalidated by inserting an import at the top of the file, which means the
 * first reformat re-reports every grandfathered finding at once and everyone
 * stops trusting it.
 *
 * Instead: rule, path, and the normalised content of the offending line. Whitespace
 * is collapsed and digits inside string literals are left alone, so the
 * fingerprint survives moving code around but changes the moment the line itself
 * is edited, which is exactly when it should be looked at again.
 */
export function fingerprint(finding, lineText = "") {
  const normalised = lineText.trim().replace(/\s+/g, " ");
  return hash(finding.rule + "\u0000" + finding.path + "\u0000" + normalised);
}

/** FNV-1a. Not cryptographic, does not need to be, and works identically in
 *  Node, a Worker and a browser without importing anything. */
function hash(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, "0");
}
