import { finding, lineAt, ERROR } from "./lib/finding.mjs";

/**
 * Every relative link in the docs points at a file that exists.
 *
 * This is the cheapest gate here and it earns its place for a reason that only
 * became obvious once agents started reading the repo.
 *
 * A stale doc link used to cost a human thirty seconds: they notice the 404,
 * shrug, and grep for the file. An agent does not shrug. It follows the link,
 * finds nothing, and then either invents what the document probably said or
 * spends a long time hunting. Both outcomes are worse than the broken link, and
 * neither is visible in the diff it eventually produces.
 *
 * So: docs that lie are a correctness problem now, not a tidiness one.
 *
 * A note on how this is scoped, because the first version was quietly broken.
 * It listed files with `git ls-files "*.md" "**\/*.md"`. On Linux the shell
 * expanded those patterns before git ever saw them, and `**` is not recursive in
 * sh, so only top-level markdown was checked while the gate cheerfully reported
 * OK. On Windows the patterns reached git intact and it worked. A gate that
 * passes for the wrong reason is worse than no gate. This version takes the file
 * list as an argument and filters in JavaScript, which behaves the same
 * everywhere.
 */
export const name = "doc-links";
export const title = "Documentation links";
export const summary =
  "Links in markdown that point at files which no longer exist, relative or back into this repository.";

// [text](target), but not ![image](target).
//
// Used with matchAll, which iterates over an internal clone, so this module-level
// regex never carries lastIndex state between files. A plain /g regex driven by
// exec() would, and a throw mid-loop would leave the next file starting halfway
// through its own text.
const LINK = /(?<!!)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

const MD = /\.mdx?$/i;

/**
 * Blank out code so a link inside it is not a link.
 *
 * A fenced block or an inline span is where documentation SHOWS a link, for
 * instance "[setup](docs/setup.md) after the file moved" as the example of what
 * this very gate catches. Reading those as links reported the gate reference's
 * own examples as broken, which is a funny thing for a tool to do to its own
 * docs once and a false positive on every README with a code sample after that.
 *
 * Characters are replaced with spaces rather than removed, and newlines are
 * kept, so every offset in the masked text is the same offset in the original
 * and line numbers still come out right.
 */
export function maskCode(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    // Fence: three or more backticks or tildes at the start of a line, closed
    // by the same character at the start of a later line.
    const atLineStart = i === 0 || text[i - 1] === "\n";
    if (atLineStart && (text.startsWith("\`\`\`", i) || text.startsWith("~~~", i))) {
      const ch = text[i];
      let n = 0;
      while (text[i + n] === ch) n++;
      const fence = ch.repeat(n);
      let end = text.indexOf("\n" + fence, i + n);
      if (end === -1) end = text.length;
      else {
        end = end + 1 + fence.length;
        while (end < text.length && text[end] === ch) end++; // longer closing fence
      }
      out += blank(text.slice(i, end));
      i = end;
      continue;
    }
    // Inline span: one or more backticks, closed by the same count on the same
    // line. An unclosed one is literal text.
    if (text[i] === "\`") {
      let n = 0;
      while (text[i + n] === "\`") n++;
      const ticks = "\`".repeat(n);
      const nl = text.indexOf("\n", i + n);
      const lineEnd = nl === -1 ? text.length : nl;
      const close = text.indexOf(ticks, i + n);
      if (close !== -1 && close < lineEnd) {
        out += blank(text.slice(i, close + n));
        i = close + n;
        continue;
      }
    }
    out += text[i];
    i++;
  }
  return out;
}

function blank(chunk) {
  return chunk.replace(/[^\n]/g, " ");
}

/**
 * Directory set derived from the repo file list, cached.
 *
 * Deriving it walks every path segment of every tracked file. The CLI calls scan
 * once so it does not matter there, but the hosted API calls it per request with
 * the same file list, and recomputing this for a 1,200 file repository on every
 * call is exactly the kind of quiet waste that makes a service feel slow for no
 * reason. Keyed by the Set instance, held weakly so a caller passing fresh sets
 * cannot leak memory.
 */
const DIR_CACHE = new WeakMap();

function directoriesOf(known) {
  const hit = DIR_CACHE.get(known);
  if (hit) return hit;
  const dirs = new Set();
  for (const p of known) {
    let idx = p.indexOf("/");
    while (idx !== -1) {
      dirs.add(p.slice(0, idx));
      idx = p.indexOf("/", idx + 1);
    }
  }
  DIR_CACHE.set(known, dirs);
  return dirs;
}

/**
 * @param {{path: string, text: string}[]} files  markdown files
 * @param {Set<string>|string[]} repoFiles  every path in the repo, forward-slashed
 * @param {{repoUrl?: string}} [config]  set repoUrl to also check absolute links
 *   that point back into this repository
 */
export function scan(files, repoFiles, config = {}) {
  const known = repoFiles instanceof Set ? repoFiles : new Set(repoFiles);
  const dirs = directoriesOf(known);
  const selfLink = config.repoUrl ? selfLinkMatcher(config.repoUrl) : null;
  const out = [];

  for (const file of files) {
    if (!MD.test(file.path)) continue;
    // Cheap reject: a document with no "](" has no links to resolve.
    if (file.text.indexOf("](") === -1) continue;
    const prose = maskCode(file.text);

    const from = file.path.replace(/\\/g, "/");
    const slash = from.lastIndexOf("/");
    const baseDir = slash === -1 ? "" : from.slice(0, slash);

    for (const m of prose.matchAll(LINK)) {
      let raw = m[1];

      // An absolute link back into this same repository is still a link to a file
      // we can check, so unwrap it and treat it as a repo path.
      //
      // This exists because of npm. A README published to the registry keeps its
      // relative links verbatim, and they resolve against npmjs.com, where they
      // all 404. This repository's own package page had nineteen broken links for
      // exactly that reason, which is a funny way to learn it when the tool
      // shipping them has a gate for documentation that lies.
      //
      // Rewriting them as absolute GitHub URLs fixes npm and would normally cost
      // the coverage, since absolute links are skipped as external. Recognising
      // our own repository is what keeps both.
      if (selfLink) {
        const unwrapped = raw.match(selfLink);
        if (unwrapped) raw = unwrapped[1];
      }

      if (isExternal(raw)) continue;

      // Strip the anchor. Whether the heading exists is a different gate, and a
      // noisier one, so it is deliberately not checked here.
      const hashAt = raw.indexOf("#");
      const target = hashAt === -1 ? raw : raw.slice(0, hashAt);
      if (!target) continue; // a bare "#anchor" link, same page

      // A root-absolute link with no file extension is a site route, not a path.
      //
      // Found by running this gate over a Next.js portfolio, where `[estate](/work/estate)`
      // was reported as broken. It is not: the renderer resolves it against the
      // deployed site, and there is no file at `work/estate` by design. On GitHub
      // the same syntax means repo-root, so the notation is genuinely ambiguous
      // and only the extension separates the two readings.
      //
      // Requiring an extension keeps the real coverage, since a repo-root link to
      // a document is written `/docs/guide.md`, while dropping a false positive
      // class that would otherwise fire on every content-driven website.
      if (target.startsWith("/") && !/\.[a-z0-9]{1,8}$/i.test(target)) continue;

      const resolved = resolvePath(baseDir, decodeTarget(target));
      if (resolved === null) continue; // escaped above the repo root; not ours to judge
      if (known.has(resolved) || dirs.has(resolved)) continue;

      out.push(
        finding({
          path: file.path,
          line: lineAt(file.text, m.index),
          rule: "doc-links/broken",
          message: 'This link points at "' + target + '", which does not exist in the repository.',
          fix:
            "Update it to the file's new location, or delete the link. A doc that points " +
            "nowhere sends the next reader, human or agent, somewhere wrong.",
          severity: ERROR,
        })
      );
    }
  }
  return out;
}

/**
 * Matches this repository's own blob and tree URLs, capturing the path inside.
 *
 * Accepts any ref, so a link pinned to a tag or a commit still resolves against
 * the working tree. That is a deliberate approximation: checking a path as it
 * existed at some other commit would need history the gate does not have, and
 * reporting nothing at all would be worse than checking against today.
 */
function selfLinkMatcher(repoUrl) {
  const base = repoUrl.replace(/\/+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("^" + base + "/(?:blob|tree)/[^/]+/(.+)$");
}

function isExternal(href) {
  return (
    /^[a-z][a-z0-9+.-]*:/i.test(href) || // http:, mailto:, tel:, ...
    href.startsWith("//") ||
    href.startsWith("#") ||
    href.startsWith("{") // template placeholder
  );
}

/** `%20` and friends. A link written with an escaped space still points at a
 *  real file, and reporting it as broken would be wrong. */
function decodeTarget(t) {
  try {
    return decodeURIComponent(t);
  } catch {
    return t; // malformed escape; judge it as written
  }
}

/**
 * Resolve a relative link against the linking file's directory.
 *
 * Returns null when the path climbs above the repository root. That is not a
 * broken link in any sense this gate can judge, and reporting it would be a
 * false positive on a monorepo doc that legitimately points at a sibling
 * package outside the git root.
 */
function resolvePath(baseDir, target) {
  const parts = target.startsWith("/") ? [] : baseDir ? baseDir.split("/") : [];
  const result = parts.slice();
  for (const seg of target.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (result.length === 0) return null;
      result.pop();
    } else result.push(seg);
  }
  return result.join("/");
}
