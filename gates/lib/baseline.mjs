import { fingerprint } from "./finding.mjs";

/**
 * Grandfathering, so a gate can be switched on in a codebase that already
 * violates it.
 *
 * This is the feature that decides whether a tool like this is adoptable at all.
 * Turning on a new gate in a mature repository surfaces two hundred existing
 * findings. Nobody is going to fix two hundred things before merging anything
 * else, so without a baseline the realistic options are to not add the gate, or
 * to add it as a warning that everybody learns to scroll past. Both mean the rule
 * is not enforced.
 *
 * A baseline records what was already wrong on the day the gate was switched on.
 * Those findings stop blocking. Anything NEW blocks immediately. The debt stays
 * visible and countable, and the bleeding stops the same afternoon.
 *
 * THE FINGERPRINT IS NOT THE LINE NUMBER. That is the mistake this design exists
 * to avoid. A baseline keyed on line numbers is invalidated the first time
 * somebody adds an import at the top of a file, and then two hundred
 * grandfathered findings reappear at once, in a pull request that had nothing to
 * do with any of them. People stop trusting the tool that same day.
 *
 * Keyed instead on rule, path, and the normalised text of the offending line, a
 * finding survives moving up and down the file, and stops being suppressed the
 * moment somebody edits that line, which is exactly when it deserves a fresh
 * look.
 */

export const BASELINE_VERSION = 1;

/**
 * @param {object[]} findings
 * @param {(f: object) => string} lineTextOf  resolves the source line for a finding
 */
export function fingerprintAll(findings, lineTextOf) {
  return findings.map((f) => ({ ...f, fp: fingerprint(f, lineTextOf(f)) }));
}

export function createBaseline(fingerprinted) {
  const entries = {};
  for (const f of fingerprinted) {
    // Store enough to make the file reviewable by a human in a pull request.
    // A baseline nobody can read is a baseline nobody will ever shrink.
    entries[f.fp] = { rule: f.rule, path: f.path };
  }
  return {
    version: BASELINE_VERSION,
    created: new Date().toISOString().slice(0, 10),
    note:
      "Findings that existed when these gates were switched on. They do not block. " +
      "Anything new does. Delete an entry once the finding is genuinely fixed; " +
      "`bouncer-gates --baseline-write` will not re-add it.",
    count: Object.keys(entries).length,
    entries,
  };
}

/**
 * Split findings into what still blocks and what is grandfathered.
 *
 * Also reports entries in the baseline that no longer match anything. Those are
 * fixed findings, and saying so is what lets the file shrink over time instead of
 * accumulating forever. A baseline that only ever grows is a debt ledger nobody
 * reads.
 */
export function applyBaseline(fingerprinted, baseline) {
  if (!baseline || typeof baseline !== "object" || !baseline.entries) {
    return { blocking: fingerprinted, grandfathered: [], stale: [] };
  }

  const known = baseline.entries;
  const seen = new Set();
  const blocking = [];
  const grandfathered = [];

  for (const f of fingerprinted) {
    if (Object.prototype.hasOwnProperty.call(known, f.fp)) {
      seen.add(f.fp);
      grandfathered.push(f);
    } else {
      blocking.push(f);
    }
  }

  const stale = Object.keys(known).filter((fp) => !seen.has(fp));
  return { blocking, grandfathered, stale };
}

/** Reject a baseline written by a future version rather than misreading it. */
export function validateBaseline(baseline) {
  if (!baseline || typeof baseline !== "object") return "baseline is not an object";
  if (baseline.version !== BASELINE_VERSION) {
    return `baseline version ${baseline.version} is not supported by this build (expected ${BASELINE_VERSION})`;
  }
  if (!baseline.entries || typeof baseline.entries !== "object") {
    return "baseline has no entries object";
  }
  return null;
}
