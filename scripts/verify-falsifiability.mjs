import { createChecker } from './lib/verify.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { Client } from 'pg';

const run = promisify(execFile);

// THE GUARD ON THE GUARDS.
//
// This project's most persistent defect is not a bug in the system, it is a test that cannot fail.
// Eight have shipped: a .env check that could never match, a schema assertion that could never pass,
// a scanner that missed a whole file format, a correlation test that passed exactly once, a wall
// proof whose method could not work across sessions, a fail-closed grant that was never closed.
// Every one passed its own tests. CLAUDE.md rule 9 exists because of them, and until now it was a
// discipline someone had to remember while tired.
//
// So: break the thing on purpose, and assert the guard NOTICES.
//
// SAFETY. Everything happens in a scratch database that is created, mutated, and dropped here. The
// live database is never touched. The scratch database is recreated from migrations before EVERY
// mutation rather than reversing each break — reversing is where this kind of harness goes wrong,
// because a failed reversal silently leaves the next case testing a database that is already broken,
// and it would still report PASS.
//
// It also relies on a documented behaviour rather than a hope: `node --env-file` loses to an
// already-exported variable, so exporting POSTGRES_DB genuinely redirects every child script. That
// cost this project a silent negative-control failure once (Task 2) and is now load-bearing.

const cfgBase = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
};

const LIVE = process.env.POSTGRES_DB;
const SCRATCH = `guardprobe_${Date.now()}`;

// Mirrors the discipline in restore.mjs: refuse to operate on anything that is not obviously a
// throwaway. A harness that can point at the live database is a worse risk than the bugs it finds.
if (!SCRATCH.startsWith('guardprobe_') || SCRATCH === LIVE || ['postgres', 'template1'].includes(SCRATCH)) {
  console.error(`refusing to run: scratch name ${SCRATCH} is not safe`);
  process.exit(1);
}

const checker = createChecker('verify-falsifiability');
const { check, finish } = checker;

const admin = () => new Client({ ...cfgBase, database: 'postgres' });
const scratch = () => new Client({ ...cfgBase, database: SCRATCH });

async function withClient(make, fn) {
  const c = make();
  await c.connect();
  try { return await fn(c); } finally { await c.end().catch(() => {}); }
}

async function recreateScratch() {
  await withClient(admin, async (c) => {
    await c.query(`drop database if exists ${SCRATCH} with (force)`);
    await c.query(`create database ${SCRATCH}`);
  });
  await run('node', ['--env-file=.env', 'scripts/migrate.mjs'], {
    env: { ...process.env, POSTGRES_DB: SCRATCH },
  });
}

// Returns the exit code of a verify script pointed at the scratch database.
async function verifyExit(script) {
  try {
    await run('node', ['--env-file=.env', `scripts/${script}`], {
      env: { ...process.env, POSTGRES_DB: SCRATCH },
    });
    return 0;
  } catch (err) {
    return err.code ?? 1;
  }
}

// Each case: break something real, name the guard that must notice, and say what shipping this
// break would actually cost. The cost line is not decoration — it is why the case is worth a
// database rebuild.
const CASES = [
  {
    guard: 'verify-heartbeat.mjs',
    breaks: 'source_staleness hardcoded to is_stale = true',
    cost: 'alarms forever, which is indistinguishable from never alarming',
    sql: `create or replace view public.source_staleness with (security_invoker = true) as
          select s.id, s.enabled, s.last_success_at, true as is_stale from public.sources s`,
  },
  {
    guard: 'verify-heartbeat.mjs',
    breaks: 'publisher granted SELECT on heartbeats',
    cost: 'invariant 8 breach — a jsonb sink of source-derived content becomes publishable',
    sql: `grant select on public.heartbeats to publisher`,
  },
  {
    guard: 'verify-default-privileges.mjs',
    breaks: 'the public-schema default privilege restored (Q15 reopened)',
    cost: 'every future table silently publisher-readable, exactly as ingest_runs already was',
    sql: `alter default privileges in schema public grant select on tables to publisher`,
  },
  {
    guard: 'verify-wall.mjs',
    breaks: 'publisher granted USAGE and SELECT across the private schema',
    cost: 'the wall falls — Seek-sourced data reachable by the publishing role (invariant 2)',
    sql: `grant usage on schema private to publisher;
          grant select on all tables in schema private to publisher`,
  },
];

console.log(`scratch database: ${SCRATCH}  (live database ${LIVE} is never touched)\n`);

try {
  // Baseline first. If an unbroken scratch database does not pass, every "it failed when broken"
  // result below is meaningless — the failure would prove nothing about the break.
  await recreateScratch();
  for (const script of [...new Set(CASES.map((c) => c.guard))]) {
    const code = await verifyExit(script);
    check(`baseline: ${script} passes on an unbroken scratch database`, code === 0, `exit ${code}`);
  }

  if (checker.failed > 0) {
    console.log('\nbaseline failed — aborting, since no mutation result would mean anything');
  } else {
    console.log('');
    for (const c of CASES) {
      await recreateScratch();
      await withClient(scratch, (cl) => cl.query(c.sql));
      const code = await verifyExit(c.guard);
      check(
        `${c.guard} FAILS when ${c.breaks}`,
        code !== 0,
        code !== 0 ? `exit ${code} — would otherwise mean: ${c.cost}` : 'exit 0 — THE GUARD IS BLIND'
      );
    }
  }
} finally {
  await withClient(admin, (c) => c.query(`drop database if exists ${SCRATCH} with (force)`)).catch(() => {});
  console.log(`\nscratch database dropped`);
}

// Prove the live database is still intact and still passing — a harness that damages what it
// measures is worse than no harness.
const liveStillGreen = await (async () => {
  try { await run('node', ['--env-file=.env', 'scripts/verify-default-privileges.mjs']); return true; }
  catch { return false; }
})();
check('live database untouched and still green', liveStillGreen);

finish();
