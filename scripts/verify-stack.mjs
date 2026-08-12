import { Client } from 'pg';
import { createChecker, pgConfig, poll, withWait } from './lib/verify.mjs';

const { check, finish } = createChecker('verify-stack');

const POSTGRES_DB = process.env.POSTGRES_DB;

const pg = await poll(async () => {
  const client = new Client(pgConfig());
  try {
    await client.connect();
    const { rows } = await client.query('select current_database() as db, version() as v');
    return { ok: rows[0].db === POSTGRES_DB, detail: `connected to ${rows[0].db}`, version: rows[0].v };
  } finally {
    await client.end().catch(() => {});
  }
});

check('postgres reachable', pg.ok, withWait(pg));
check(
  'postgres is v17+',
  pg.ok && /PostgreSQL 1[7-9]|PostgreSQL [2-9]\d/.test(pg.version),
  pg.ok ? pg.version.split(' ').slice(0, 2).join(' ') : 'skipped — not reachable'
);

// The n8n health check was removed on 2026-08-09 (D-011). It was verifying a component that had
// been deleted from the architecture — a green check for something that should not exist is worse
// than no check, because it reports confidence in the wrong thing.
// There is nothing else in the local stack to reach: the scheduler is GitHub Actions and the raw
// store is a git repository, neither of which runs here.

finish();
