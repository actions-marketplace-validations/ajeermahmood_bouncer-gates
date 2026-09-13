# Deployment

Three targets, one repository. Each one exists to run the same gate modules in a
different runtime, which is the point rather than a flourish: it is what proves
there is a single implementation of every rule.

| Target | Serves | Live | Config |
|---|---|---|---|
| Cloudflare Workers | the site and `/api/scan` | [bouncer.ajeermdk001.workers.dev](https://bouncer.ajeermdk001.workers.dev) | `wrangler.toml`, `worker/index.js` |
| Railway | the hosted API on its own | [bouncer-production-9470.up.railway.app](https://bouncer-production-9470.up.railway.app/health) | `railway.json`, `server/index.mjs` |
| npm | the CLI | [`bouncer-gates`](https://www.npmjs.com/package/bouncer-gates) | `package.json` |

---

## Cloudflare

Two hosting products, two different conventions for the same route, and getting
it wrong is silent.

- **Workers** ignores the `functions/` directory. You supply one entry
  (`worker/index.js`), route what you want, and hand everything else to the assets
  binding. This is what `wrangler.toml` configures.
- **Pages** compiles `functions/api/scan.js` by convention and needs no config at
  all.

Both files are in the repository, both import the same gates, and only one of them
is used by any given deployment.

The first deployment of this site went out as a Worker with no `wrangler.toml`, so
`/api/scan` fell through to the static 404 page. Nothing appeared broken: the
playground caught the failed request and ran the gates in the browser instead,
exactly as designed, and the outage was invisible because the fallback was good.

**Verify a deployment rather than assuming it.** The page loading is not evidence
the API did:

```bash
curl -X POST https://<your-host>/api/scan \
  -H "content-type: application/json" \
  -d '{"code":"const a = db.raw.order.findMany();"}'
```

You want a `scope/raw-client` finding back. In the browser, the playground footer
should read **ran on a Cloudflare Worker**. If it says **ran in this tab**, the
endpoint is not there and the fallback is covering for it.

### The usage counter

`/api/ping` writes to an Analytics Engine dataset declared in `wrangler.toml`.
It needs no provisioning. `npm run stats` with `CF_ACCOUNT_ID` and a
`CF_API_TOKEN` that has Account Analytics: Read prints the numbers. What the
client sends is in [telemetry.md](telemetry.md).

## Railway

For teams that want the checks available over HTTP without running Node
themselves. `railway.json` is complete: connect the repository and deploy.

Two settings in it are worth understanding, because the defaults are wrong here.

**`buildCommand` is deliberately a no-op.** Nixpacks runs `npm run build` whenever
a build script exists, and in this repository that script is `astro build`. Left
alone, Railway would install Astro, React and Vitest and build the entire static
site for a service that serves none of it. The API is plain Node and the gates
have no dependencies at all, so there is genuinely nothing to build.

**`watchPatterns` limits redeploys** to `server/`, `gates/`, `railway.json` and
`package.json`. Without it, every change to the website or the documentation
redeploys an API that did not change.

The health check hits `/health`, which the server answers without touching the
gates, so a bad rule can never take down a health check and trigger a restart
loop.

Verify:

```bash
curl https://bouncer-production-9470.up.railway.app/health
# {"ok":true,"gates":["secrets","scope","money"]}

curl -X POST https://bouncer-production-9470.up.railway.app/scan \
  -H "content-type: application/json" \
  -d '{"code":"const minor = Math.round(parseFloat(input) * 100);"}'
# one money/float-to-minor finding
```

Note the path is `/scan` here and `/api/scan` on Cloudflare. Same handler shape,
different host conventions.

### What the hosted API is not

It runs three gates: `secrets`, `scope` and `money`. `migration-safety` needs git
history and `doc-links` needs the repository file list, and neither exists for a
single pasted snippet. The response says so explicitly in an `unavailable` array
rather than quietly returning findings from three gates and letting the caller
assume five ran.

Requests are capped at 64KB and nothing is stored.

## npm

```bash
npm version patch      # or minor
npm publish --access public
git push --follow-tags
```

The package is **`bouncer-gates`**. The plain `bouncer` name was already taken on
npm by an unrelated package, which is worth knowing because an earlier README told
people to run `npx bouncer` and that would have executed a stranger's code.

`files` in `package.json` ships `bin`, `gates`, the README and the licence only.
The site, the tests and the tooling are not published.

## A general note

Every one of these hosts needs a different shape of the same thing, and in each
case the failure mode is quiet rather than loud: a route that 404s into a static
page, a build that succeeds while building the wrong thing, a package name that
resolves to somebody else's code.

None of those show up as an error. All three showed up by checking the thing
itself with `curl` after deploying, which takes about ten seconds and is the only
step here worth insisting on.
