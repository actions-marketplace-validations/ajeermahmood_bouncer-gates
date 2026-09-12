import { finding, lines, acknowledged, isCommentLine, isTestFile, ERROR, WARN } from "./lib/finding.mjs";

/**
 * Two bugs hiding in one innocent-looking expression.
 *
 *     Math.round(parseFloat(input) * 100)
 *
 * This is how most codebases turn "12.34" into minor units. It is wrong twice.
 *
 * 1. BINARY FLOATS. 10.005 is not representable, so it is stored slightly below
 *    10.005, and Math.round gives 1000 rather than 1001. The customer is charged
 *    a cent less, the ledger disagrees with the payment provider, and it happens
 *    rarely enough that nobody reproduces it for months.
 *
 * 2. THE HARDCODED 100. It assumes every currency has two decimal places.
 *    Japanese yen has zero, so a JPY amount comes out 100x too large. Bahraini
 *    dinar has three, so it comes out 10x too small. The first time this matters
 *    is the day you sell to a new country, which is also the day nobody is
 *    looking for a currency bug.
 *
 * The fix is not "round more carefully". It is to stop letting float touch money
 * at all: parse the decimal string to an integer directly, and get the exponent
 * from the currency.
 */
export const name = "money";
export const title = "Money arithmetic";
export const summary =
  "Float maths on currency, and the hardcoded x100 that breaks every zero- and three-decimal currency.";

const MONEYISH =
  "(?:amount|price|total|subtotal|cost|fee|balance|paise|cents|minor|gross|net|charge|refund|discount|tax|shipping|payable|payout)";

/**
 * The percentage problem, which is what this gate got wrong first.
 *
 * `Math.round(x * 100)` is the canonical money bug AND the canonical way to
 * render a percentage. Run against a real 1,209 file repository, every single
 * false positive this gate produced was a percentage:
 *
 *     `${Math.round((num / den) * 100)}%`
 *     `showing at ${Math.round(scale * 100)}%`
 *
 * Both carry a decisive signal: a literal `%` immediately after the closing
 * brace or bracket. Percent-shaped identifiers are checked too, because a
 * value can be computed on one line and formatted on another.
 *
 * This narrowing loses a real bug only in the case of money multiplied by 100 on
 * a line that also renders a percentage, which is not a thing anybody writes.
 */
const PERCENT_RENDER = /[)}\]]\s*%|%\s*["'`)]|\btoFixed\(\d\)\s*\+\s*["'`]%/;
const PERCENT_IDENT =
  /\b(?:pct|percent|percentage|ratio|scale|zoom|opacity|progress|completion|rate|share|weight|score|confidence|aspect|bin|trim)\w*\b/i;

/**
 * A division inside the rounded expression is the percentage signature.
 *
 * Every false positive this gate produced on a real 1,209 file repository was
 * one of these, and the two the naming heuristic still missed both had it:
 *
 *     Math.round((1 - canvasAspect / targetAspect) * 100)
 *     bins.map(count => Math.round((count / maxBin) * 100))
 *
 * A percentage is a part divided by a whole and then scaled. A currency
 * conversion to minor units is a single value scaled, with nothing divided first,
 * because dividing money before multiplying it by 100 is not a thing anybody
 * writes on purpose.
 *
 * A money-shaped identifier on the line overrides this, so a genuine
 * `Math.round((amount / quantity) * 100)` unit price is still reported.
 */
const DIVIDES_FIRST = /Math\.round\s*\([^)]*\/[^)]*(?:\)[^)]*)?\*\s*(?:100|1000)\b/i;

const RULES = [
  {
    rule: "money/float-to-minor",
    re: new RegExp(
      "Math\\.round\\s*\\(\\s*(?:parseFloat|Number|parseInt)?\\s*\\(?[^)]*\\)?\\s*\\*\\s*(?:100|1000)\\b",
      "i"
    ),
    notPercent: true,
    message:
      "This converts a decimal amount to minor units through a float, which rounds the wrong way on values like 10.005.",
    fix: "Parse the decimal string to an integer without going through a float, and take the exponent from the currency rather than assuming 2.",
  },
  {
    rule: "money/hardcoded-exponent",
    re: new RegExp("\\b(" + MONEYISH + "\\w*)\\s*[*/]\\s*100\\b", "i"),
    ident: true,
    message:
      "A currency amount is multiplied or divided by a hardcoded 100, which assumes every currency has two decimal places. JPY has none; BHD has three.",
    fix: "Look the exponent up from the currency code.",
  },
  {
    rule: "money/float-parse",
    re: new RegExp("(?:parseFloat|Number)\\s*\\(\\s*(\\w*" + MONEYISH + "\\w*)\\s*\\)", "i"),
    ident: true,
    message:
      "A currency value is parsed into a float. Every later operation on it inherits binary rounding error.",
    fix: "Keep money as an integer in minor units, or as a decimal string, all the way through.",
  },
  {
    rule: "money/float-accumulate",
    re: new RegExp("\\b" + MONEYISH + "\\w*\\s*\\+=\\s*(?!\\s*\\d+\\s*;)", "i"),
    message:
      "A currency value is accumulated in place. If it is a float, the error compounds once per line item.",
    fix: "Sum integer minor units. If this is already an integer total, acknowledge it.",
    // Noisy alone. Only reported once the file has already shown float money
    // handling, so it adds context to a real problem instead of standing on its own.
    softOnly: true,
  },
];

/**
 * Money words that cannot plausibly mean anything else.
 *
 * Deliberately a shorter list than MONEYISH. "total", "net", "gross", "balance",
 * "rate" and "share" all appear constantly in code that has nothing to do with
 * currency, so they are fine for spotting a candidate line and useless for
 * overruling a percentage.
 */
const STRONG_MONEY =
  /\b(?:amount|price|paise|cents|minor|subtotal|payable|payout|charge|refund|invoice|currency)\w*\b/i;

/**
 * A money word with a percentage suffix is a percentage.
 *
 * `taxRate / 100`, `discountPercent / 100` and `Number(discountPct)` all contain
 * a money word and are all about a rate, not an amount. They were the next
 * false-positive family after the `Math.round` percentages, and just as common:
 * nearly every checkout has a line like `price * (1 - discountPercent / 100)`.
 * The identifier itself says what it is, so the identifier is what gets checked.
 */
const PERCENT_SUFFIX = /(?:rate|rates|pct|percent|percentage|ratio|bps|factor|multiplier|fraction)$/i;

const UNION = new RegExp(RULES.map((r) => "(?:" + r.re.source + ")").join("|"), "i");
const SOURCE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP_PATH = /(?:^|\/)(?:node_modules|dist|build|coverage)\//;

export function scan(files) {
  const out = [];

  for (const file of files) {
    const norm = file.path.replace(/\\/g, "/");
    if (!SOURCE.test(norm) || SKIP_PATH.test(norm)) continue;
    if (norm.endsWith("gates/money.mjs")) continue;
    if (!UNION.test(file.text)) continue;

    const inTest = isTestFile(norm);
    const all = lines(file);
    // Was `out.some(f => f.path === file.path)` on every line, which made the
    // gate quadratic in findings-per-file. A flag is the same logic in O(1).
    let fileHasHardFinding = false;

    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      if (isCommentLine(line)) continue; // a comment about the bug is not the bug
      if (!UNION.test(line)) continue;
      if (acknowledged(all, i, "money")) continue;

      for (const r of RULES) {
        if (r.softOnly && !fileHasHardFinding) continue;
        const m = r.re.exec(line);
        if (!m) continue;

        // The rule names a specific identifier. If that identifier is a rate or
        // a percentage by its own name, or the line renders a percent sign, this
        // is not money arithmetic.
        if (r.ident && (PERCENT_SUFFIX.test(m[1]) || PERCENT_RENDER.test(line))) continue;

        if (r.notPercent) {
          // An explicit percent signal is decisive and cannot be overridden.
          //
          // The override used to accept ANY money-shaped word, which let this
          // through on a real repository:
          //
          //     const pct = total ? Math.round((done / total) * 100) : 0;
          //
          // a progress pill, reported as a currency bug because "total" is in the
          // money vocabulary. "total", "net", "gross" and "balance" are all
          // perfectly ordinary counting words. Only unambiguous money words get
          // to overrule the weaker division heuristic, and nothing overrules a
          // literal percent sign or a variable actually named for a percentage.
          if (PERCENT_RENDER.test(line) || PERCENT_IDENT.test(line)) continue;
          if (DIVIDES_FIRST.test(line) && !STRONG_MONEY.test(line)) continue;
        }

        out.push(
          finding({
            path: file.path,
            line: i + 1,
            rule: r.rule,
            // A money bug inside a test is arithmetic in an assertion, not a
            // charge to a customer. Same reasoning as the secrets gate: report
            // it, do not block on it.
            message: inTest ? r.message + " This is a test file, so it is reported as a warning." : r.message,
            fix: r.fix,
            severity: inTest ? WARN : ERROR,
          })
        );
        if (!r.softOnly) fileHasHardFinding = true;
        break; // one finding per line; the first rule is the most specific
      }
    }
  }
  return out;
}
