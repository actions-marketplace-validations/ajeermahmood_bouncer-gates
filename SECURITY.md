# Security

## Reporting a vulnerability

Email **ajeermahmood@outlook.com** with "bouncer-gates" in the subject. Please do not
open a public issue for anything exploitable.

Expect an acknowledgement within a few days. This is a small project maintained by
one person, so there is no formal SLA, and saying so is more useful than promising
one that will not be met.

## Threat model, and what this tool is not

bouncer-gates is a **static mechanical check**, not a security product. It matches
shapes in text. It is one layer, and a thin one.

It does **not** replace secret scanning at the provider level, dependency
auditing, SAST, code review, or a scoped database client. In particular the
`scope` gate is explicitly the backstop for a scoped client, not a substitute for
one. See [docs/gates.md](docs/gates.md), where each gate states what it misses.

Assume a determined author can get anything past it. It is built to catch mistakes,
not to stop an attacker who knows it is running.

## Two design decisions that are security relevant

**Findings never contain the matched text.** A secret scanner that quotes what it
found writes the secret into the CI log, which is usually more public and longer
lived than the file it came from. bouncer-gates reports a file, a line and a rule id,
and a human opens the file.

**A gate never fails open.** If a gate cannot do its job it reports *skipped* and
says why; it never returns no findings and lets the build pass. If you see
`skip` in the output with a reason, that check did not run, and the run is not
evidence of anything about it.

## If a secret is found

Reporting it is not the fix. Rotate the credential first, then remove it from the
file, then deal with git history. A secret that has been pushed should be treated
as public regardless of what the history looks like afterwards.

## Scope

The gates read files and return findings. The runner shells out to `git` with
fixed argument arrays, never a shell string. The hosted callers
(`functions/api/scan.js`, `server/index.mjs`) accept a code snippet, cap it at
64 KB, run the pure gates on it, and store nothing.
