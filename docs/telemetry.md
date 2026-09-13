# Telemetry

Bouncer sends one anonymous ping a day so the project can tell whether anyone
uses it. This page is the complete description. If anything the tool sends is
not listed here, that is a bug, and a serious one for a tool whose job is not
leaking things.

## What is sent

One JSON document, at most once per day per runtime, after the scan has
finished:

```json
{ "id": "3f9a1c...", "version": "0.4.0", "runtime": "cli", "os": "linux", "node": 22 }
```

| Field | What it is |
|---|---|
| `id` | A random string generated once and stored in `~/.bouncer/id`. It is not derived from your machine, user, or anything else. Delete the file and you are a new id. |
| `version` | The Bouncer version. |
| `runtime` | `cli`, `mcp` (an agentic editor), `hook` (a post-edit hook), or `ci`. |
| `os` | `process.platform`, such as `linux` or `win32`. |
| `node` | The major Node version. |

In CI (`CI`, `GITHUB_ACTIONS` or similar set) there is no stored id, `id` is
null, and the daily limit does not apply, because there is no persistent home
directory and the useful number there is runs rather than machines.

## What is never sent

File names. File contents. Findings. Rule ids. Which gates ran or what they
returned. The repository name or remote. The working directory. The config. The
baseline. Environment variables. Timings. Anything a gate looked at.

The client code is [bin/lib/telemetry.mjs](../bin/lib/telemetry.mjs), about
a hundred lines, and the receiving end is `handlePing` in
[worker/index.js](../worker/index.js), which reads exactly those five fields and
discards the rest of the body.

## Turning it off

Either of these, in the environment:

```bash
BOUNCER_TELEMETRY=0
DO_NOT_TRACK=1
```

The first run prints a notice to stderr saying this. It is printed once, when
the id file is created, and never to stdout, so `--json` and `--sarif` output
is unaffected.

## How it cannot affect a run

- It runs after the result has been printed and the exit code chosen.
- Every failure is swallowed. No network, no DNS, a 500: the exit code is the
  same.
- The request times out after 1.5 seconds.
- The gates never see it. They import nothing from `bin/`.

## Reading the numbers

Pings land in a Cloudflare Analytics Engine dataset. Analytics Engine has to be
enabled once for the account in the dashboard. With an API token that has
"Account Analytics: Read":

```bash
CF_ACCOUNT_ID=... CF_API_TOKEN=... npm run stats
```

prints distinct machines and pings per day and per runtime for the last thirty
days. The dataset keeps ninety days.
