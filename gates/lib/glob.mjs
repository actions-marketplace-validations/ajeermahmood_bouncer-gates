/**
 * The glob dialect used by `exclude` in bouncer-gates.config.json.
 *
 * Deliberately tiny and deliberately single-pass: a double star spans
 * directories, a single star stops at a slash, everything else is literal. No
 * dependency, and no ambiguity about which flavour of glob this is.
 *
 * Written as a character walk rather than a chain of replaces because that chain
 * has an ordering hazard: expanding the single star first corrupts any double
 * star not yet handled, and the usual fix is placeholder tokens that then have to
 * be impossible to collide with. An earlier version used NUL bytes as those
 * tokens, which worked and quietly made the runner read as a binary file to grep
 * and to bouncer-gates's own file reader. One pass has no ordering to get wrong and no
 * tokens to choose badly.
 *
 * It lives here rather than in the runner because the runner executes the whole
 * CLI at import time, so anything exported from it is untestable in practice.
 */
export function globToRe(pattern) {
  const SPECIAL = ".+^${}()|[]\\";
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?"; // `docs/**/x` also matches `docs/x`
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else if (SPECIAL.includes(c)) out += "\\" + c;
    else out += c;
  }
  return new RegExp("^" + out + "$");
}
