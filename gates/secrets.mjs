import { finding, lines, acknowledged, isTestFile, ERROR, WARN } from "./lib/finding.mjs";

/**
 * Two problems, one gate.
 *
 * 1. SECRETS. A credential or private key committed to the repo. Obvious harm,
 *    well-trodden ground.
 *
 * 2. DANGEROUS SHAPE. Code that merely READS like offensive tooling: a remote
 *    script piped into a shell, TLS verification switched off, host-key checking
 *    auto-accepted, a payload decoded into a root path.
 *
 * The second one is the unusual half, and it is here for a reason that is not
 * primarily about security.
 *
 * A repository that deploys to a VPS legitimately needs some of these shapes.
 * What happened in practice is that AI coding agents working in that repo were
 * repeatedly refused, or escalated to a human, on files that were completely
 * benign, because the surrounding code pattern-matched to an attack. Sessions
 * died halfway. Nobody could tell which refusals were real.
 *
 * Keeping the shape clean fixed it. So this is a working-conditions gate as much
 * as a security one: the team stopped fighting their own tools.
 */
export const name = "secrets";
export const title = "Secrets and dangerous shape";
export const summary =
  "Credentials, private keys, and code that reads like an attack even when it is not.";

const SECRET_RULES = [
  {
    rule: "secrets/private-key",
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----/,
    message: "A private key is committed in this file.",
    fix: "Remove it, rotate the key, and load it from an environment variable or your host's secret store.",
  },
  {
    rule: "secrets/aws-access-key",
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
    message: "An AWS access key id is hardcoded here.",
    fix: "Rotate it now, then read it from the environment.",
  },
  {
    rule: "secrets/github-token",
    re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
    message: "A GitHub token is hardcoded here.",
    fix: "Revoke it, then use an Actions secret or the GITHUB_TOKEN the workflow already provides.",
  },
  {
    rule: "secrets/slack-token",
    re: /\bxox[abprs]-[0-9A-Za-z-]{10,}\b/,
    message: "A Slack token is hardcoded here.",
    fix: "Revoke it and move it to your secret store.",
  },
  {
    rule: "secrets/stripe-key",
    re: /\b[sr]k_live_[0-9A-Za-z]{20,}\b/,
    message: "A live Stripe key is hardcoded here.",
    fix: "Roll the key immediately. Live keys never belong in a repo, even a private one.",
    // Stripe itself separates live from test credentials by prefix, so an
    // `sk_live_` in a spec file is not plausible fixture data the way a made-up
    // password is. This is the one rule that stays blocking inside tests.
    liveByConstruction: true,
  },
  {
    rule: "secrets/openai-key",
    re: /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}\b/,
    message: "What looks like an API key is hardcoded here.",
    fix: "Move it to an environment variable.",
  },
  {
    rule: "secrets/google-api-key",
    re: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: "A Google API key is hardcoded here.",
    fix: "Restrict the key in the Google Cloud console, then read it from the environment.",
  },
  {
    rule: "secrets/npm-token",
    re: /\bnpm_[A-Za-z0-9]{36}\b/,
    message: "An npm access token is hardcoded here.",
    fix: "Revoke it on npmjs.com and use NPM_TOKEN from your CI secrets instead.",
  },
  {
    rule: "secrets/gitlab-token",
    re: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
    message: "A GitLab personal access token is hardcoded here.",
    fix: "Revoke it and move it to a CI variable.",
  },
  {
    rule: "secrets/sendgrid-key",
    re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/,
    message: "A SendGrid API key is hardcoded here.",
    fix: "Delete the key in SendGrid and read a new one from the environment.",
  },
  {
    rule: "secrets/connection-string",
    re: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqp):\/\/[^\s:@/]+:[^\s:@/]+@[^\s"'`/?<]+/i,
    message: "A database URL with an inline password is hardcoded here.",
    fix: "Read the whole URL from the environment. Do not split it into parts and rebuild it.",
  },
  {
    rule: "secrets/env-file-credential",
    // Only in a committed .env file, where values are not quoted, so the rule
    // above never fires. `.env.example` and friends are excused below because
    // they exist precisely to hold placeholders.
    re: /^\s*(?:export\s+)?[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*["']?[^\s"']{8,}/,
    envOnly: true,
    message: "A committed .env file sets a credential to a real-looking value.",
    fix: "Delete the file from git, add it to .gitignore, and keep a .env.example with placeholders instead.",
  },
  {
    rule: "secrets/assigned-credential",
    re: /\b(?:password|passwd|secret|api_?key|access_?token|client_?secret)\s*[:=]\s*["'][^"'\s]{8,}["']/i,
    message: "A credential is assigned a literal value here.",
    fix: "Read it from the environment. If this is test data, make it obviously fake.",
  },
];

const SHAPE_RULES = [
  {
    rule: "shape/pipe-to-shell",
    re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|k|)sh\b/,
    message: "This pipes something downloaded off the network straight into a shell.",
    fix: "Download to a file, check it in or verify a checksum, then run it. Reviewers and agents both stop trusting a repo that does this.",
  },
  {
    rule: "shape/tls-disabled",
    re: /\b(?:rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true|curl\b[^\n]*\s-(?:k|-insecure)\b)/,
    message: "TLS certificate verification is switched off here.",
    fix: "Trust the real certificate. If a self-signed cert is genuinely required, pin that specific CA instead of disabling the check.",
  },
  {
    rule: "shape/host-key-bypass",
    re: /StrictHostKeyChecking[=\s]+no|UserKnownHostsFile[=\s]+\/dev\/null/,
    message: "SSH host-key checking is disabled here.",
    fix: "Put the host key in known_hosts as part of provisioning, and check against it.",
  },
  {
    rule: "shape/decoded-payload",
    re: /\b(?:base64\s+(?:-d|--decode)|atob\s*\()[^\n]{0,80}(?:eval|exec|\/etc\/|\/root\/|Function\s*\()/,
    message: "A decoded blob is executed or written somewhere privileged.",
    fix: "Store the content in a readable file. Nobody can review a base64 string, and tools will flag it forever.",
    severity: WARN,
  },
  {
    rule: "shape/chmod-777",
    re: /\bchmod\s+(?:-R\s+)?0?777\b/,
    message: "This makes a path world-writable.",
    fix: "Grant the narrowest mode that works, usually 755 for directories and 644 for files.",
    severity: WARN,
  },
];

/**
 * A credential pointing at a local host is not a secret.
 *
 *     postgresql://postgres:postgres@localhost:5432/app
 *
 * That is a development default, it is in every getting-started guide, and it
 * grants nothing to anyone who reads it. Found in a setup script's help text on a
 * real repository, where flagging it would have taught the team that this gate
 * reports things that do not matter.
 */
// The terminator is a negative lookahead rather than a list of allowed
// characters. Two earlier attempts got this wrong by enumerating: the first
// required "/" or "?" and so missed `redis://user:pass@127.0.0.1:6379`, which has
// no trailing path at all; the second added quotes and whitespace and still missed
// `...@localhost</code>` inside an HTML snippet. Asserting only that the hostname
// does not CONTINUE is the version that has no list to be incomplete.
const LOCAL_HOST =
  /@(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal|db|postgres|redis|mysql|mongo)(?::\d+)?(?![\w.-])/i;

/** Obvious non-secrets. Without these the gate cries wolf and gets switched off. */
// Applied to the matched text, plus a check for the word EXAMPLE anywhere in it
// without a word boundary, because the canonical AWS documentation key is
// `AKIAIOSFODNN7EXAMPLE` and the 7 glues the word to the rest of the token.
function looksLikePlaceholder(matched) {
  return PLACEHOLDER.test(matched) || /[A-Z0-9]EXAMPLE(?:KEY)?\b/.test(matched);
}

// `examples?(?![-\w])` rather than a plain word match, so that
// `example.com` (an RFC 2606 documentation domain, genuinely a placeholder)
// suppresses a finding while `example-corp.com` (somebody's real company) does
// not. A word boundary alone treats the hyphen as a break and quietly excuses
// the real host.
// The word list needs word boundaries; the punctuation shapes must not have
// them. `"${DB_PASSWORD}"` and `<fill-me-in>` were never excused while they sat
// inside the \b group, because there is no word boundary between a quote and a
// dollar sign, and the tests happened not to cover either.
const PLACEHOLDER =
  /\b(?:examples?(?![-\w])|sample|placeholder|dummy|fake|redacted|changeme|change_me|your[-_]?\w+|my[-_]?\w+|xxx+|test|TODO|FIXME|process\.env|import\.meta\.env|os\.environ|None|null|undefined)\b|\.{3,}|<[^>]+>|\$\{[^}]+\}/i;

/**
 * Files that exist to hold placeholders.
 *
 * `.env.example`, `.env.sample` and `.env.template` are the documented way to
 * tell a new developer which variables exist. Their values are fake by
 * definition, and the committed-.env rule must not fire on them.
 */
const ENV_FILE = /(?:^|\/)\.env(?:\.[\w.-]+)?$/i;
const ENV_TEMPLATE = /(?:^|\/)\.env\.(?:example|sample|template|dist|defaults?)$/i;

const ALL = [
  ...SECRET_RULES.map((r) => ({ ...r, family: "secret" })),
  ...SHAPE_RULES.map((r) => ({ ...r, family: "shape" })),
];
const SECRETS_ONLY = ALL.filter((r) => r.family === "secret");

/**
 * One union regex per rule set, tested before the per-rule loop.
 *
 * The overwhelming majority of lines in a codebase contain nothing interesting.
 * Testing one alternation and bailing out is far cheaper than running thirteen
 * separate regexes over every line of every file. Measured on a 1,209 file
 * repository this was the difference between roughly 600ms and roughly 190ms of
 * scan time.
 */
const UNION = new RegExp(ALL.map((r) => "(?:" + r.re.source + ")").join("|"), "i");
const UNION_SECRETS = new RegExp(
  SECRETS_ONLY.map((r) => "(?:" + r.re.source + ")").join("|"),
  "i"
);

const SKIP_PATH =
  /(?:^|\/)(?:node_modules|dist|build|\.astro|\.git|coverage)\/|(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock)$|\.min\.(?:js|css)$/;

/**
 * @param {{path: string, text: string, lines?: string[]}[]} files
 * @param {{secretsOnly?: boolean}} [opts]
 */
export function scan(files, opts = {}) {
  const rules = opts.secretsOnly ? SECRETS_ONLY : ALL;
  const union = opts.secretsOnly ? UNION_SECRETS : UNION;
  const out = [];

  for (const file of files) {
    const norm = file.path.replace(/\\/g, "/");
    if (SKIP_PATH.test(norm)) continue;
    // A gate that flags its own rule table is useless.
    if (norm.endsWith("gates/secrets.mjs")) continue;

    // Whole-file reject. If nothing in the file can match, skip the line split
    // entirely, which is the expensive part on large files.
    if (!union.test(file.text)) continue;

    const inTest = isTestFile(norm);
    const isEnv = ENV_FILE.test(norm);
    const isEnvTemplate = ENV_TEMPLATE.test(norm);
    const all = lines(file);

    for (let i = 0; i < all.length; i++) {
      const line = all[i];
      if (line.length > 2000) continue; // minified bundle, not review material
      if (!union.test(line)) continue;

      for (const r of rules) {
        if (r.envOnly && (!isEnv || isEnvTemplate)) continue;
        const m = r.re.exec(line);
        if (!m) continue;

        // The placeholder allowance applies to SECRET rules only, and only to
        // the text that matched, not the whole line.
        //
        // Both halves of that were learned the hard way. Applying it to every
        // rule let `curl https://get.example.com/install.sh | sh` through,
        // because the line contains "example": for a secret a fake key is
        // harmless, but a pipe-to-shell is dangerous because of its form, and
        // the host it points at is irrelevant. Applying it to the whole line let
        // `password: "Hunter2Hunter2!", other: null` through, because `null`
        // appeared somewhere on the line. The credential is the thing being
        // judged, so the credential is the thing the placeholder test reads.
        if (r.family === "secret" && looksLikePlaceholder(m[0])) continue;
        if (r.rule === "secrets/connection-string" && LOCAL_HOST.test(line)) continue;
        if (acknowledged(all, i, "secrets")) continue;

        // Test fixtures legitimately contain credential-shaped strings. On a real
        // 1,209 file repository these were 35% of every finding the gate produced,
        // and all of them were deliberate. Downgrading rather than excluding keeps
        // a genuinely leaked key visible instead of silently unscanned.
        // A .env.example exists to show the shape of a credential, so the same
        // downgrade applies there. Scanning it at all is new in 0.3, and the
        // first real run reported a sample DATABASE_URL as a leak.
        const downgrade = (inTest || isEnvTemplate) && !r.liveByConstruction;
        out.push(
          finding({
            path: file.path,
            line: i + 1,
            rule: r.rule,
            message: downgrade
              ? r.message +
                (inTest ? " This is a test file," : " This is an example env file,") +
                " so it is reported as a warning."
              : r.message,
            fix: r.fix,
            severity: downgrade ? WARN : r.severity ?? ERROR,
          })
        );
      }
    }
  }
  return out;
}
