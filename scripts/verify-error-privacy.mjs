import { connectWithRetry, createChecker, pgConfig, publisherConfig } from './lib/verify.mjs';

// Q10: proves error detail cannot reach the publishing role.
// The wall guards the private DATA table; this guards the public METADATA table, which is where
// the leak actually was — `sources.last_error` was free text an adapter writes on failure.

const { check, finish } = createChecker('verify-error-privacy');

const ownerConn = await connectWithRetry(pgConfig());
if (!ownerConn.ok) {
  check('postgres reachable', false, ownerConn.detail);
  console.log('\nverify-error-privacy: 1 failure(s)');
  process.exit(1);
}
const owner = ownerConn.client;

// 1. The leaking column must be gone.
const { rows: col } = await owner.query(`
  select count(*)::int as n from information_schema.columns
  where table_schema='public' and table_name='sources' and column_name='last_error'
`);
check('public.sources.last_error no longer exists', col[0].n === 0, `${col[0].n} column(s)`);

// 2. Detail lives behind the wall instead.
const { rows: tbl } = await owner.query(`select to_regclass('private.ingest_errors') is not null as p`);
check('private.ingest_errors exists', tbl[0].p);

// 3. Column grants are scoped, not table-wide — so a future column is invisible by default.
const { rows: granted } = await owner.query(`
  select array_agg(column_name::text order by column_name) as cols
  from information_schema.column_privileges
  where grantee='publisher' and table_schema='public' and table_name='sources' and privilege_type='SELECT'
`);
const cols = granted[0].cols ?? [];
check('publisher has column-scoped SELECT on sources', cols.length > 0 && cols.length < 20, `${cols.length} column(s)`);
check('none of the granted columns is a free-text error field',
  !cols.some((c) => c === 'last_error' || c === 'detail'), cols.join(','));

await owner.end();

// 4. Behavioural proof as the publisher itself.
const pubConn = await connectWithRetry(publisherConfig());
if (!pubConn.ok) {
  check('publisher can log in', false, pubConn.detail);
  console.log('\nverify-error-privacy: failures');
  process.exit(1);
}
const publisher = pubConn.client;

try {
  await publisher.query('select id, publishable, last_error_code from public.sources limit 1');
  check('publisher CAN read permitted status columns', true);
} catch (err) {
  check('publisher CAN read permitted status columns', false, `sqlstate ${err.code}: ${err.message}`);
}

// FAIL-CLOSED. The first version of this check asserted `SELECT *` must fail. That was wrong:
// every column that currently exists is granted, so `SELECT *` succeeds — correctly. The property
// that actually matters is that the grant is COLUMN-scoped rather than table-wide, because a
// table-wide grant would silently expose any column added in future the moment it appears.
//
// has_table_privilege reports the table-level grant; has_any_column_privilege reports column-level.
// Column-scoped and fail-closed means: table-level FALSE, column-level TRUE.
const { rows: priv } = await publisher.query(`
  select has_table_privilege('publisher','public.sources','SELECT')      as table_level,
         has_any_column_privilege('publisher','public.sources','SELECT') as column_level
`);
check(
  'sources grant is column-scoped, not table-wide (future columns invisible by default)',
  priv[0].table_level === false && priv[0].column_level === true,
  `table-level=${priv[0].table_level} column-level=${priv[0].column_level}`
);

try {
  await publisher.query('select 1 from private.ingest_errors limit 1');
  check('publisher DENIED on private.ingest_errors', false, 'THE WALL IS OPEN — query succeeded');
} catch (err) {
  check('publisher DENIED on private.ingest_errors', ['42501', '3F000'].includes(err.code), `sqlstate ${err.code}`);
}

await publisher.end();
finish();
