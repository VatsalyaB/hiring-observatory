import { connectWithRetry, createChecker, pgConfig, publisherConfig } from './lib/verify.mjs';

// Q15 — proves the `public` schema defaults to publisher-INVISIBLE.
//
// Why this script exists rather than a line in verify-wall.mjs: the wall guards a schema boundary
// and is asserted behaviourally against `private`. This guards something subtler — the DEFAULT that
// applies to objects nobody has written a grant for yet. It failed silently for `ingest_runs`
// (D-013 documented a fail-closed property that `pg_class.relacl` showed was never true) precisely
// because every existing test asserted what `publisher` COULD read and none asserted the boundary.
//
// The load-bearing check is the first one, and it is behavioural on purpose. Reading
// `pg_default_acl` would only prove the catalogue says the right thing. Creating an actual table and
// finding `publisher` denied proves the rule is in force — the same distinction verify-wall.mjs
// draws between catalogue and behavioural evidence, for the same reason.

const { check, finish } = createChecker('verify-default-privileges');

const ownerConn = await connectWithRetry(pgConfig());
if (!ownerConn.ok) { check('postgres reachable', false, ownerConn.detail); process.exit(1); }
const owner = ownerConn.client;

const pubConn = await connectWithRetry(publisherConfig());
if (!pubConn.ok) { check('publisher can connect', false, pubConn.detail); process.exit(1); }
const pub = pubConn.client;

// --------------------------------------------------------------------------
// THE ONE THAT MATTERS: a brand-new table must be invisible without a grant
// --------------------------------------------------------------------------

const probe = `_grant_probe_${Date.now()}`;
try {
  await owner.query(`create table public.${probe} (id int, detail jsonb)`);

  const tableWide = (
    await owner.query(`select has_table_privilege('publisher', 'public.${probe}', 'SELECT') as p`)
  ).rows[0].p;
  check('a NEW public table is not table-readable by publisher', tableWide === false, `has_table_privilege=${tableWide}`);

  const anyColumn = (
    await owner.query(`select has_any_column_privilege('publisher', 'public.${probe}', 'SELECT') as p`)
  ).rows[0].p;
  check('a NEW public table exposes no column to publisher', anyColumn === false, `has_any_column_privilege=${anyColumn}`);

  // Behavioural, not catalogue. This is the assertion that would have caught Q15 on the day it
  // was introduced, and the one that will catch it if the default privilege is ever restored.
  let denied = false;
  let detail = '';
  try {
    await pub.query(`select * from public.${probe} limit 1`);
    detail = 'SELECT SUCCEEDED — the public schema is granting by default again';
  } catch (err) {
    denied = err.code === '42501';
    detail = `${err.code} ${err.code === '42501' ? 'insufficient_privilege' : err.message}`;
  }
  check('publisher is DENIED a new public table behaviourally', denied, detail);
} finally {
  await owner.query(`drop table if exists public.${probe}`).catch(() => {});
}

// --------------------------------------------------------------------------
// Regression guards on the objects whose scoping is deliberate
// --------------------------------------------------------------------------

// D-013 claimed this and it was false until Q15 was fixed. Asserted now so the claim and the
// database cannot drift apart again.
const runs = (
  await owner.query(`select has_table_privilege('publisher','public.ingest_runs','SELECT') as t,
                            has_any_column_privilege('publisher','public.ingest_runs','SELECT') as c`)
).rows[0];
check('ingest_runs is column-scoped, not table-wide (D-013 restored)', runs.t === false && runs.c === true, `table=${runs.t} anyColumn=${runs.c}`);

const src = (
  await owner.query(`select has_table_privilege('publisher','public.sources','SELECT') as t,
                            has_any_column_privilege('publisher','public.sources','SELECT') as c`)
).rows[0];
check('sources is still column-scoped (D-012 holds)', src.t === false && src.c === true, `table=${src.t} anyColumn=${src.c}`);

const hb = (
  await owner.query(`select has_any_column_privilege('publisher','public.heartbeats','SELECT') as c`)
).rows[0];
check('heartbeats still exposes nothing to publisher (invariant 8)', hb.c === false, `anyColumn=${hb.c}`);

const mig = (
  await owner.query(`select has_any_column_privilege('publisher','public.schema_migrations','SELECT') as c`)
).rows[0];
check('schema_migrations is not readable by publisher (least privilege)', mig.c === false, `anyColumn=${mig.c}`);

// The other half of fail-closed: proving nothing NEEDED was broken. A migration that locks the
// publishing role out of its own inputs is not a security win, it is an outage.
for (const t of ['countries', 'raw_listings', 'source_staleness']) {
  let ok = false;
  let detail = '';
  try {
    await pub.query(`select * from public.${t} limit 1`);
    ok = true;
    detail = 'select permitted';
  } catch (err) {
    detail = `${err.code}: ${err.message}`;
  }
  check(`publisher CAN still read ${t} (pipeline not broken)`, ok, detail);
}

await pub.end().catch(() => {});
await owner.end();
finish();
