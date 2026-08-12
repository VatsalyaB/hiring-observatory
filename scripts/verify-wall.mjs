import { Client } from 'pg';
import { createChecker, pgConfig, poll, publisherConfig, withWait } from './lib/verify.mjs';

// INVARIANT 2 — the wall. This is the single most important guard in the project: it is the only
// thing standing between Seek-sourced data and anything publishable. It is enforced by database
// permissions, not by convention, and this script is what proves the enforcement is real.
//
// Two layers are asserted deliberately:
//   * BEHAVIOURAL — connect as `publisher` and try the query. This is ground truth.
//   * CATALOGUE   — sweep every object in `private` for any privilege held by `publisher`. This is
//                   defence in depth and catches a grant that today happens to be masked by the
//                   missing schema USAGE, but would become live the moment USAGE were granted.
// Neither subsumes the other. has_table_privilege() ignores schema USAGE, so it can report a
// privilege that is currently unreachable; and the behavioural probe only covers the tables it
// names. Both are cheap.

const { check, finish } = createChecker('verify-wall');

// Poll only the CONNECTION. Every assertion below must fail immediately — retrying them would hide
// a missing grant behind a 45-second wait.
const connection = await poll(async () => {
  const candidate = new Client(pgConfig());
  try {
    await candidate.connect();
    return { ok: true, detail: `connected to ${process.env.POSTGRES_DB}`, client: candidate };
  } catch (err) {
    await candidate.end().catch(() => {});
    throw err;
  }
});

if (!connection.ok) {
  check('postgres reachable as owner', false, withWait(connection));
  console.log('\nverify-wall: 1 failure(s)');
  process.exit(1);
}
if (connection.waitedMs > 1000) {
  console.log(`note  postgres accepted connections after ${(connection.waitedMs / 1000).toFixed(1)}s`);
}
const owner = connection.client;

// ---------------------------------------------------------------------------
// The private tier exists and carries the same immutability guarantee as public
// ---------------------------------------------------------------------------

const { rows: schema } = await owner.query(
  `select count(*)::int as n from information_schema.schemata where schema_name = 'private'`
);
check('private schema exists', schema[0].n === 1);

const { rows: tbl } = await owner.query(`select to_regclass('private.raw_listings') is not null as present`);
check('private.raw_listings exists', tbl[0].present);

if (tbl[0].present) {
  // `tgname` is of type `name`, so array_agg(tgname) returns name[] (OID 1003) — an OID
  // node-postgres has no array parser for, so it arrives as a raw literal string and the comparison
  // is false forever. Task 2 shipped exactly that bug. The ::text cast makes it text[] (OID 1009),
  // which node-postgres parses into a real JS array.
  const { rows: trg } = await owner.query(`
    select coalesce(array_agg(tgname::text order by tgname::text), '{}') as names
    from pg_trigger
    where tgrelid = 'private.raw_listings'::regclass and not tgisinternal
  `);
  const expected = [
    'private_raw_listings_no_delete',
    'private_raw_listings_no_truncate',
    'private_raw_listings_no_update',
  ];
  check(
    'private.raw_listings carries all three immutability triggers',
    JSON.stringify(trg[0].names) === JSON.stringify(expected),
    String(trg[0].names)
  );

  // Catalogue presence is not behaviour. Prove each operation is actually refused.
  // TRUNCATE fires neither the UPDATE nor the DELETE trigger and empties the table outright — the
  // hole found in the public table and closed by 001b_truncate_guard.sql. The private tier gets the
  // same guarantee or the wall is protecting data that can still be wiped.
  // Each probe runs in its own transaction that is rolled back regardless, so a guard that is NOT
  // working destroys nothing while proving it is broken.
  for (const [op, sql] of [
    ['UPDATE', `update private.raw_listings set source_ref = 'mutated'`],
    ['DELETE', `delete from private.raw_listings`],
    ['TRUNCATE', `truncate private.raw_listings`],
  ]) {
    try {
      await owner.query('begin');
      await owner.query(sql);
      check(`private.raw_listings rejects ${op}`, false, 'statement succeeded — immutability is NOT enforced');
    } catch (err) {
      check(`private.raw_listings rejects ${op}`, true, err.message.split('\n')[0]);
    } finally {
      await owner.query('rollback').catch(() => {});
    }
  }
}

// ---------------------------------------------------------------------------
// Catalogue sweep: publisher must hold nothing at all inside `private`
// ---------------------------------------------------------------------------

const { rows: role } = await owner.query(
  `select count(*)::int as n from pg_roles where rolname = 'publisher'`
);
check('publisher role exists', role[0].n === 1);

if (role[0].n === 1) {
  const { rows: sp } = await owner.query(`
    select has_schema_privilege('publisher', 'private', 'usage')  as usage_priv,
           has_schema_privilege('publisher', 'private', 'create') as create_priv
  `);
  check('publisher has no USAGE on schema private', sp[0].usage_priv === false, `usage=${sp[0].usage_priv}`);
  check('publisher has no CREATE on schema private', sp[0].create_priv === false, `create=${sp[0].create_priv}`);

  // Every relation and sequence in `private`, crossed with every privilege. Any hit is a leak.
  // ::text throughout for the same OID-1003 reason as above.
  const { rows: leaks } = await owner.query(`
    with rels as (
      select c.oid, c.relname::text as name, c.relkind
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'private' and c.relkind in ('r','p','v','m','f','S')
    ),
    hits as (
      select (r.name || ':' || p.priv)::text as hit
      from rels r
      cross join unnest(array['select','insert','update','delete','truncate','references','trigger']) as p(priv)
      where r.relkind <> 'S' and has_table_privilege('publisher', r.oid, p.priv)
      union all
      select (r.name || ':' || p.priv)::text
      from rels r
      cross join unnest(array['select','usage','update']) as p(priv)
      where r.relkind = 'S' and has_sequence_privilege('publisher', r.oid, p.priv)
    )
    select coalesce(array_agg(hit::text order by hit::text), '{}') as leaks,
           (select count(*)::int from rels) as objects
    from hits
  `);
  check(
    'publisher holds zero privileges on any object in private',
    Array.isArray(leaks[0].leaks) && leaks[0].leaks.length === 0,
    `${leaks[0].objects} object(s) swept, found ${JSON.stringify(leaks[0].leaks)}`
  );
}

await owner.end();

// ---------------------------------------------------------------------------
// Behavioural: connect AS publisher and try
// ---------------------------------------------------------------------------

// No poll here on purpose. The owner connection above already proved the server is warm, so a
// failure at this point is a real failure and must surface immediately rather than after 45s.
const publisher = new Client(publisherConfig());
try {
  await publisher.connect();
  check('publisher can log in', true);
} catch (err) {
  check('publisher can log in', false, err.message);
  console.log(`\nverify-wall: cannot continue without a publisher login — ${failed} failure(s)`);
  process.exit(1);
}

try {
  await publisher.query('select 1 from private.raw_listings limit 1');
  check('publisher DENIED on private.raw_listings', false, 'THE WALL IS OPEN — query succeeded');
} catch (err) {
  // 42501 insufficient_privilege, 3F000 invalid_schema_name (no USAGE => schema invisible)
  const denied = ['42501', '3F000'].includes(err.code);
  check('publisher DENIED on private.raw_listings', denied, `sqlstate ${err.code}: ${err.message.split('\n')[0]}`);
}

try {
  await publisher.query('select 1 from public.raw_listings limit 1');
  check('publisher permitted on public.raw_listings', true);
} catch (err) {
  check('publisher permitted on public.raw_listings', false, `sqlstate ${err.code}: ${err.message}`);
}

// Wrapped in a rolled-back transaction. The plan ran this bare, which would have written a permanent
// 'zz' probe country into the live database on the very failure it is testing for.
try {
  await publisher.query('begin');
  await publisher.query(
    `insert into public.countries (code, name, currency, timezone, region) values ('zz','Probe','ZZZ','UTC','probe')`
  );
  check('publisher cannot INSERT on public', false, 'INSERT succeeded — publisher has write access');
} catch (err) {
  check('publisher cannot INSERT on public', err.code === '42501', `sqlstate ${err.code}`);
} finally {
  await publisher.query('rollback').catch(() => {});
}

// Read-only means read-only. PG15+ already removes CREATE on schema public from PUBLIC, but this
// asserts it rather than assuming the default was never loosened.
try {
  await publisher.query('begin');
  await publisher.query('create table public.wall_probe (x int)');
  check('publisher cannot CREATE in public', false, 'CREATE TABLE succeeded — publisher can write DDL');
} catch (err) {
  check('publisher cannot CREATE in public', err.code === '42501', `sqlstate ${err.code}`);
} finally {
  await publisher.query('rollback').catch(() => {});
}

await publisher.end();
finish();
