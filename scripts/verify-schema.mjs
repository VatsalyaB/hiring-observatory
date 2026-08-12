import { Client } from 'pg';
import { createChecker, pgConfig, poll, withWait } from './lib/verify.mjs';

const { check, finish } = createChecker('verify-schema');

const POSTGRES_DB = process.env.POSTGRES_DB;

// Poll only the CONNECTION. Schema assertions below must fail immediately —
// retrying them would just hide a missing table behind a 45-second wait.
const connection = await poll(async () => {
  const candidate = new Client(pgConfig());
  try {
    await candidate.connect();
    return { ok: true, detail: `connected to ${POSTGRES_DB}`, client: candidate };
  } catch (err) {
    await candidate.end().catch(() => {});
    throw err;
  }
});

if (!connection.ok) {
  check('postgres reachable', false, withWait(connection));
  console.log('\nverify-schema: 1 failure(s)');
  process.exit(1);
}
if (connection.waitedMs > 1000) {
  console.log(`note  postgres accepted connections after ${(connection.waitedMs / 1000).toFixed(1)}s`);
}
const client = connection.client;

// Core tables exist
for (const table of ['countries', 'sources', 'raw_listings', 'schema_migrations']) {
  const { rows } = await client.query(
    `select to_regclass($1) is not null as present`, [`public.${table}`]
  );
  check(`table ${table} exists`, rows[0].present);
}

// Region-agnostic: country_code must be a foreign key, not a free-text field
const { rows: fk } = await client.query(`
  select count(*)::int as n
  from information_schema.table_constraints tc
  join information_schema.constraint_column_usage ccu using (constraint_name)
  where tc.table_name = 'raw_listings'
    and tc.constraint_type = 'FOREIGN KEY'
    and ccu.table_name = 'countries'
`);
check('raw_listings.country_code references countries', fk[0].n > 0);

// Idempotency key includes payload_hash so a re-fetch is a no-op but an edit is a new row.
// `a.attname` is of type `name`, so array_agg(a.attname) returns name[] (OID 1003) — an OID
// node-postgres has no array parser for, so it arrives as the raw literal string
// '{payload_hash,source_id,source_ref}' and never equals the expected array. The ::text cast
// makes it text[] (OID 1009), which node-postgres parses into a real JS array. Without it this
// check FAILS against a perfectly correct schema. See the corrections block for Task 2.
const { rows: uniq } = await client.query(`
  select array_agg(a.attname::text order by a.attname) as cols
  from pg_constraint c
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
  where c.conrelid = 'public.raw_listings'::regclass and c.contype = 'u'
`);
check(
  'raw_listings unique key is (source_id, source_ref, payload_hash)',
  JSON.stringify(uniq[0].cols) === JSON.stringify(['payload_hash', 'source_id', 'source_ref']),
  String(uniq[0].cols)
);

// Seed a row so immutability can be exercised
await client.query(`
  insert into countries (code, name, currency, timezone, region, occupation_taxonomy, enabled)
  values ('nz', 'New Zealand', 'NZD', 'Pacific/Auckland', 'oceania', 'anzsco', true)
  on conflict (code) do nothing
`);
// publishable = FALSE deliberately. Invariant 3 governs what crosses to the public database, and a
// synthetic test fixture must never be eligible. This was seeded `true` originally — harmless while
// nothing publishes, a landmine from M6 onward.
await client.query(`
  insert into sources (id, class, adapter, country_codes, publishable, enabled)
  values ('selftest', 'aggregator', 'none', array['nz'], false, false)
  on conflict (id) do nothing
`);
await client.query(`
  insert into raw_listings (source_id, source_ref, country_code, payload)
  values ('selftest', 'immutability-probe', 'nz', '{"probe":true}'::jsonb)
  on conflict do nothing
`);

// INVARIANT 1: raw_listings must reject UPDATE, DELETE and TRUNCATE.
// TRUNCATE was missed originally — it fires neither the UPDATE nor the DELETE trigger and destroys
// the table's contents outright. Guarded by 001b_truncate_guard.sql.
// Each runs inside its own transaction that is rolled back regardless, so a guard that is NOT
// working destroys nothing while proving it is broken.
for (const [op, sql] of [
  ['UPDATE', `update raw_listings set source_ref = 'mutated' where source_ref = 'immutability-probe'`],
  ['DELETE', `delete from raw_listings where source_ref = 'immutability-probe'`],
  ['TRUNCATE', `truncate raw_listings`],
]) {
  try {
    await client.query('begin');
    await client.query(sql);
    check(`raw_listings rejects ${op}`, false, 'statement succeeded — immutability is NOT enforced');
  } catch (err) {
    check(`raw_listings rejects ${op}`, true, err.message.split('\n')[0]);
  } finally {
    await client.query('rollback').catch(() => {});
  }
}

// The seeded probe row must still be intact and unmutated after all of the above.
const { rows: probe } = await client.query(
  `select count(*)::int as n from raw_listings where source_ref = 'immutability-probe'`
);
check('probe row survived the immutability tests', probe[0].n === 1, `${probe[0].n} row(s)`);

// Re-inserting identical payload must be a silent no-op, not a duplicate
const before = (await client.query(`select count(*)::int as n from raw_listings`)).rows[0].n;
await client.query(`
  insert into raw_listings (source_id, source_ref, country_code, payload)
  values ('selftest', 'immutability-probe', 'nz', '{"probe":true}'::jsonb)
  on conflict do nothing
`);
const after = (await client.query(`select count(*)::int as n from raw_listings`)).rows[0].n;
check('identical re-insert is a no-op', before === after, `${before} -> ${after}`);

await client.end();
finish();
