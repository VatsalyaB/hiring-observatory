import { connectWithRetry, createChecker, pgConfig, publisherConfig } from './lib/verify.mjs';

// Task 5a — `heartbeats` and the `source_staleness` view.
//
// Silent failure is this project's primary risk (CLAUDE.md). It matters MORE under GitHub Actions
// than it did under a self-hosted scheduler, because GitHub documents that scheduled jobs may be
// *dropped*, not merely delayed. Nothing notifies yet — the notifier lands with M2's first real
// source — but the computation it will read must exist and must be known to work.
//
// WHY THE NEGATIVE CASES ARE HERE AND NOT ONLY IN A ONE-OFF DEMO (CLAUDE.md rule 9):
// a view defined as `select ..., true as is_stale` would satisfy "the view flags a source that has
// never succeeded" and then alarm forever. An always-on alarm is indistinguishable from no alarm.
// So this asserts the view can return BOTH answers, across all three inputs that drive it:
// never-succeeded, succeeded-recently, succeeded-too-long-ago, plus the disabled case.
//
// WHAT IS DELIBERATELY NOT ASSERTED: canary freshness. The canary runs on GitHub Actions and has no
// route to this database — it commits a file to git. A local "was the canary recent?" check would
// read a table nothing writes, and would therefore either fail always or pass vacuously. The canary
// is proven from `git log` and the committed payload's `event_name`, not from here. See 5c.

const checker = createChecker('verify-heartbeat');
const { check, finish } = checker;

const conn = await connectWithRetry(pgConfig());
if (!conn.ok) {
  check('postgres reachable', false, conn.detail);
  process.exit(1);
}
const c = conn.client;
check(
  'postgres reachable',
  true,
  conn.waitedMs > 1000 ? `connected [waited ${(conn.waitedMs / 1000).toFixed(1)}s]` : 'connected'
);

// ---------------------------------------------------------------------------
// Existence
// ---------------------------------------------------------------------------

check(
  'heartbeats exists',
  (await c.query(`select to_regclass('public.heartbeats') is not null as p`)).rows[0].p
);
check(
  'source_staleness exists',
  (await c.query(`select to_regclass('public.source_staleness') is not null as p`)).rows[0].p
);

// Stop here if the objects are absent — every assertion below would fail for the same single
// reason, and a wall of derived failures buries the one that matters.
if (checker.failed > 0) {
  console.log(`\nverify-heartbeat: ${checker.failed} failure(s) — objects absent, skipping behavioural checks`);
  await c.end();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Behaviour — the view must be able to return both answers
// ---------------------------------------------------------------------------

// A dedicated probe row, created and removed by this script. Unlike verify-schema.mjs (which must
// seed permanent rows because raw is immutable), nothing here touches raw_listings, so `sources`
// stays clean afterwards and the live table does not accumulate fixtures.
const PROBE = 'staleness-probe';

async function staleness(setter, params = []) {
  await c.query(`update sources set ${setter} where id = $1`, [PROBE, ...params]);
  const { rows } = await c.query(`select is_stale from source_staleness where id = $1`, [PROBE]);
  return rows[0]?.is_stale;
}

try {
  await c.query(
    `insert into sources (id, class, adapter, publishable, enabled)
     values ($1, 'aggregator', 'probe', false, true)
     on conflict (id) do update set enabled = true, publishable = false`,
    [PROBE]
  );

  const neverSucceeded = await staleness('enabled = true, last_success_at = null');
  check('enabled source that has never succeeded is flagged stale', neverSucceeded === true, `is_stale=${neverSucceeded}`);

  const fresh = await staleness('enabled = true, last_success_at = now()');
  check('enabled source that succeeded just now is NOT flagged', fresh === false, `is_stale=${fresh}`);

  // The boundary that matters: 48h is the threshold, so 49h must trip it.
  const old = await staleness(`enabled = true, last_success_at = now() - interval '49 hours'`);
  check('enabled source last successful 49h ago is flagged stale', old === true, `is_stale=${old}`);

  // Without this, a view ignoring `enabled` would alarm on every source ever configured and
  // retired — the noise that makes an alarm worthless.
  const disabled = await staleness('enabled = false, last_success_at = null');
  check('disabled source is NOT flagged, however old', disabled === false, `is_stale=${disabled}`);
} finally {
  await c.query('delete from sources where id = $1', [PROBE]).catch(() => {});
}

// ---------------------------------------------------------------------------
// INVARIANT 8 — `heartbeats.detail` is a jsonb sink and must stay behind the wall
// ---------------------------------------------------------------------------
//
// The Task 5a brief said to grant `publisher` SELECT on BOTH objects. That reopens the exact leak
// shape D-012 closed one table over: `detail jsonb` is free text an M2 adapter will reach for the
// moment a fetch fails, and invariant 8 makes anything that can carry source-derived content
// private by default. verify-correlation.mjs already asserts `ingest_runs` has no jsonb sink for
// the same reason (D-013). So `publisher` gets the VIEW, which exposes only controlled status
// columns, and is denied the table. Corrected in the plan; recorded here so it is not "fixed" back.

const pubConn = await connectWithRetry(publisherConfig());
if (!pubConn.ok) {
  check('publisher can connect', false, pubConn.detail);
} else {
  const pub = pubConn.client;

  let viewOk = false;
  let viewDetail = '';
  try {
    await pub.query('select id, is_stale from source_staleness limit 1');
    viewOk = true;
    viewDetail = 'select permitted';
  } catch (err) {
    viewDetail = `${err.code}: ${err.message}`;
  }
  check('publisher CAN read source_staleness (status is not payload)', viewOk, viewDetail);

  let denied = false;
  let deniedDetail = '';
  try {
    await pub.query('select detail from heartbeats limit 1');
    deniedDetail = 'SELECT SUCCEEDED — invariant 8 breach';
  } catch (err) {
    denied = err.code === '42501'; // insufficient_privilege
    deniedDetail = `${err.code} ${err.code === '42501' ? 'insufficient_privilege' : err.message}`;
  }
  check('publisher is DENIED heartbeats.detail (invariant 8)', denied, deniedDetail);

  await pub.end().catch(() => {});
}

await c.end();
finish();
