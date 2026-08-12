import { connectWithRetry, createChecker, pgConfig } from './lib/verify.mjs';

// Q13: proves the correlation chain exists and behaves — specifically that stamping a run id does
// NOT weaken idempotency, which is the one way this change could have caused harm.

const { check, finish } = createChecker('verify-correlation');

const conn = await connectWithRetry(pgConfig());
if (!conn.ok) { check('postgres reachable', false, conn.detail); process.exit(1); }
const c = conn.client;

check('ingest_runs exists', (await c.query(`select to_regclass('public.ingest_runs') is not null as p`)).rows[0].p);

for (const [tbl, reg] of [['public.raw_listings', 'public.raw_listings'], ['private.raw_listings', 'private.raw_listings']]) {
  const { rows } = await c.query(
    `select count(*)::int as n from information_schema.columns
     where table_schema = split_part($1,'.',1) and table_name = split_part($1,'.',2)
       and column_name = 'ingest_run_id'`, [reg]);
  check(`${tbl} carries ingest_run_id`, rows[0].n === 1);
}

// INVARIANT 8 by construction: this table must stay incapable of holding payload text.
const { rows: freetext } = await c.query(`
  select coalesce(string_agg(column_name::text, ','), '') as cols
  from information_schema.columns
  where table_schema='public' and table_name='ingest_runs'
    and data_type in ('jsonb','json') or (table_name='ingest_runs' and column_name='notes')
`);
check('ingest_runs has no jsonb/free-text sink', freetext[0].cols === '', freetext[0].cols || 'none');

// THE IMPORTANT ONE: stamping a run id must not weaken idempotency.
const RUN = `verify-${Date.now()}`;
await c.query(`insert into ingest_runs (run_id, workflow, outcome) values ($1,'verify','running')`, [RUN]);
await c.query(`
  insert into raw_listings (source_id, source_ref, country_code, payload, ingest_run_id)
  values ('selftest','correlation-probe','nz','{"probe":"corr"}'::jsonb,$1)
  on conflict do nothing`, [RUN]);

// Read the state BEFORE re-observing. Comparing against this run's own id would only be correct on
// the very first execution ever — afterwards the row rightly keeps the ORIGINAL run's id, which is
// the property being tested. A check that passes once and fails forever after is not a check.
const q = `select count(*)::int as n, min(ingest_run_id) as rid
           from raw_listings where source_ref='correlation-probe'`;
const pre = (await c.query(q)).rows[0];

// Same payload, DIFFERENT run: must still be a no-op, and must not overwrite the existing id.
await c.query(`
  insert into raw_listings (source_id, source_ref, country_code, payload, ingest_run_id)
  values ('selftest','correlation-probe','nz','{"probe":"corr"}'::jsonb,$1)
  on conflict do nothing`, [`${RUN}-second`]);

const post = (await c.query(q)).rows[0];
check('re-observation by a different run is still a no-op', pre.n === 1 && post.n === 1, `${pre.n} -> ${post.n}`);
check('run id is not overwritten by re-observation', post.rid === pre.rid, `${pre.rid} -> ${post.rid}`);

// The chain resolves: a raw row can be traced to the run that produced it.
const { rows: join } = await c.query(`
  select count(*)::int as n from raw_listings r join ingest_runs i on i.run_id = r.ingest_run_id
  where r.source_ref = 'correlation-probe'`);
check('raw row joins back to its run (chain resolves)', join[0].n === 1);

await c.query(`update ingest_runs set outcome='success', finished_at=now() where run_id=$1`, [RUN]);
await c.end();
finish();
