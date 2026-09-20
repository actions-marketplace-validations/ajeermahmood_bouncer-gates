#!/usr/bin/env node
/**
 * How many people use bouncer-gates, from the usage pings.
 *
 * Reads the Analytics Engine dataset the Worker writes to (see worker/index.js
 * and docs/telemetry.md) through Cloudflare's SQL API and prints, per day and
 * per runtime, the number of distinct machines and the number of pings.
 *
 *   CF_ACCOUNT_ID=... CF_API_TOKEN=... node tools/stats.mjs [days]
 *
 * The token needs the "Account Analytics: Read" permission and nothing else.
 * Defaults to the last 30 days.
 */
const account = process.env.CF_ACCOUNT_ID;
const token = process.env.CF_API_TOKEN;
const days = Number(process.argv[2]) || 30;

if (!account || !token) {
  process.stderr.write(
    "stats: set CF_ACCOUNT_ID and CF_API_TOKEN (a token with Account Analytics: Read).\n"
  );
  process.exit(2);
}

// blob1 runtime, blob2 version, blob3 os, blob4 node major, blob5 id.
const sql = `
  SELECT
    toDate(timestamp) AS day,
    blob1 AS runtime,
    count(DISTINCT blob5) AS machines,
    sum(_sample_interval) AS pings
  FROM bouncer_gates_pings
  WHERE timestamp > now() - INTERVAL '${days}' DAY
  GROUP BY day, runtime
  ORDER BY day DESC, runtime
`;

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: sql,
});
if (!res.ok) {
  process.stderr.write(`stats: ${res.status} ${await res.text()}\n`);
  process.exit(2);
}
const { data } = await res.json();

const totals = new Map();
process.stdout.write(`\n${"day".padEnd(12)}${"runtime".padEnd(9)}${"machines".padStart(9)}${"pings".padStart(8)}\n`);
for (const row of data) {
  process.stdout.write(
    `${row.day.padEnd(12)}${row.runtime.padEnd(9)}${String(row.machines).padStart(9)}${String(row.pings).padStart(8)}\n`
  );
  const t = totals.get(row.runtime) ?? { pings: 0 };
  t.pings += Number(row.pings);
  totals.set(row.runtime, t);
}

// "Machines" for CI is meaningless, since a CI runner has no stable id, so the
// summary counts pings there and machines everywhere else. A machine seen on
// several days counts once here, which the per-day rows above cannot show.
const uniq = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/analytics_engine/sql`, {
  method: "POST",
  headers: { authorization: `Bearer ${token}` },
  body: `SELECT blob1 AS runtime, count(DISTINCT blob5) AS machines FROM bouncer_gates_pings
         WHERE timestamp > now() - INTERVAL '${days}' DAY AND blob5 != '' GROUP BY runtime`,
}).then((r) => (r.ok ? r.json() : { data: [] }));

process.stdout.write(`\nLast ${days} days\n`);
for (const row of uniq.data) {
  process.stdout.write(`  ${row.runtime.padEnd(8)} ${row.machines} distinct machines\n`);
}
if (totals.has("ci")) process.stdout.write(`  ci       ${totals.get("ci").pings} runs\n`);
process.stdout.write("\n");
