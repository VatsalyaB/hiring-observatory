import { createChecker, poll, withWait } from './lib/verify.mjs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { Client } from 'pg';
import {
  createScratchConnector,
  dockerComposeArgs,
  latestCompleteBackupGeneration,
  resolveCanonicalRepository,
  runRestoreProbeLifecycle,
  streamFileToCommand,
} from './lib/backup-restore.mjs';

// A backup nobody has restored is a rumour. This script proves the newest dump in backups/
// actually reconstructs the database, by restoring it into a throwaway database and comparing
// every base table's row count against the live one.
//
// ---------------------------------------------------------------------------------------------
// SAFETY — read before editing. THIS SCRIPT DROPS A DATABASE.
//
// The name it drops is the hardcoded literal below. It is never read from the environment, from
// .env, or from a command-line argument, because `node --env-file` does NOT override a variable
// already exported in the shell — the exported value wins (measured on Node v24.19.0, recorded in
// Task 2's corrections). A scratch name taken from a file could therefore silently resolve to the
// LIVE database, and the first thing this script does to that database is DROP it.
//
// Two consequences, both load-bearing:
//   1. SCRATCH is a const literal. Nothing assigns to it.
//   2. Every DROP goes through assertDroppable(), which refuses any name that is not SCRATCH and
//      refuses SCRATCH itself if it collides with POSTGRES_DB / N8N_DB / a template database.
// ---------------------------------------------------------------------------------------------
const SCRATCH = 'restore_probe';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(ROOT, 'backups');
const SQL_DIR = join(ROOT, 'sql');
const REPOSITORY = resolveCanonicalRepository({ cwd: ROOT });

const checker = createChecker('verify-restore');
const { check, finish } = checker;

function fatal(msg) {
  console.log(`ABORT  ${msg}`);
  process.exit(1);
}

const LIVE_DB = process.env.POSTGRES_DB;
const USER = process.env.POSTGRES_USER;

if (!LIVE_DB) fatal('POSTGRES_DB is not set — refusing to run');
if (!USER) fatal('POSTGRES_USER is not set — refusing to run');

function assertDroppable(name) {
  if (name !== SCRATCH) {
    fatal(`refusing to drop "${name}" — only the hardcoded scratch database may be dropped`);
  }
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    fatal(`refusing to drop "${name}" — not a plain lowercase identifier`);
  }
  const protectedDbs = new Set(
    [LIVE_DB, process.env.N8N_DB, 'postgres', 'template0', 'template1'].filter(Boolean)
  );
  if (protectedDbs.has(name)) {
    fatal(
      `refusing to drop "${name}" — it is a live or protected database ` +
        `(POSTGRES_DB=${LIVE_DB}, N8N_DB=${process.env.N8N_DB ?? 'unset'})`
    );
  }
}

// `docker compose exec` runs as root in the postgres image and the image's pg_hba grants `trust`
// on the local socket, so a password is not strictly needed. PGPASSWORD is forwarded anyway (with
// `-e NAME`, which docker inherits from this process's environment) so this keeps working if
// pg_hba is ever tightened. Note the plan set PGPASSWORD on the HOST `docker` process, which never
// reaches the container at all.
function dockerPg(args) {
  return execFileSync(
    'docker',
    dockerComposeArgs(
      REPOSITORY,
      'exec', '-T', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', 'postgres', ...args
    ),
    {
      cwd: REPOSITORY.root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '',
        // `drop database if exists` emits a NOTICE on stderr, which interleaves with npm's own
        // output and makes a clean run look broken. Warnings and errors still come through.
        PGOPTIONS: '-c client_min_messages=warning',
      },
    }
  );
}

function firstLine(err) {
  return String(err?.stderr || err?.message || err)
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 2)
    .join(' | ');
}

const base = {
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: USER,
  password: process.env.POSTGRES_PASSWORD,
};

// Only the CONNECTION is polled; every assertion below must fail immediately. `poll` and `withWait`
// come from ./lib/verify.mjs, where the WSL cold-start reasoning now lives once.

// --- 1. A complete backup generation must exist -----------------------------------------------

// TAKE THE BACKUP HERE, rather than testing whatever happens to be on disk.
//
// Two failures on 2026-08-09 forced this, and both came from comparing against a moving target.
// (1) Three migrations landed after the newest dump, so the comparison reported "relation
// private.ingest_errors does not exist" and "live 7 vs restored 3" — indistinguishable from a broken
// restore or lost data, when the dump had simply never contained those tables. (2) Even with a fresh
// dump it went red again: `verify-correlation.mjs` inserts an `ingest_runs` row every time it runs,
// so the live count drifts upward the moment anyone runs `npm run verify`.
//
// A stale input and a broken restore are different incidents with different fixes, and a check that
// cannot tell them apart sends you debugging the wrong one. The noise is also self-silencing —
// alarming failures that turn out to be nothing teach you to skip the command.
//
// Backing up inside the check removes the drift instead of detecting it: dump and comparison happen
// seconds apart, so any mismatch is a real restore defect. It also tests the property actually worth
// proving — that a backup taken NOW round-trips — rather than that some older file still parses.
// An earlier version of this fix added a dump-freshness assertion; taking the dump here deletes the
// need for it.
execFileSync('node', [join(ROOT, 'scripts', 'backup.mjs')], { stdio: 'pipe', cwd: ROOT });

let latestGeneration;
try {
  latestGeneration = await latestCompleteBackupGeneration(BACKUP_DIR);
} catch (error) {
  check('newest complete backup generation is valid', false, firstLine(error));
}
check(
  'at least one complete backup generation exists in backups/',
  Boolean(latestGeneration),
  latestGeneration ? basename(latestGeneration.markerPath) : 'none found'
);
if (!latestGeneration) {
  console.log('\nverify-restore: run `npm run backup` to create a dump, globals file and completion marker');
  process.exit(1);
}
// Filenames embed an ISO-8601 timestamp with ':' and '.' replaced by '-', so they are
// fixed-width and lexicographic order is chronological order. Selection starts from completion
// markers, not dumps: a process killed between payload links leaves an orphan that must be ignored.
const latest = basename(latestGeneration.dumpPath);
const dumpBytes = latestGeneration.dumpBytes;
const dumpPath = latestGeneration.dumpPath;
check('newest dump is non-empty', dumpBytes > 0, `${latest} — ${dumpBytes} bytes`);


// --- 2. Live inventory ------------------------------------------------------------------------

// The Client is constructed INSIDE the attempt, not outside it. node-postgres refuses to reconnect
// a client that has already been connected ("Client has already been connected. You cannot reuse a
// client."), so hoisting it out makes every retry after the first fail with that library error
// instead of retrying — which silently disables the cold-start tolerance this poll exists to
// provide, and buries the real cause. Caught by pointing the script at a dead port.
let live = null;
const connected = await poll(async () => {
  const client = new Client({ ...base, database: LIVE_DB });
  try {
    await client.connect();
    live = client;
    return { ok: true, detail: `connected to ${LIVE_DB}` };
  } catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
});
check('live database reachable', connected.ok, withWait(connected));
if (!connected.ok) {
  console.log(`\nverify-restore: ${checker.failed} failure(s)`);
  process.exit(1);
}

// Enumerate every base table rather than hardcoding a list. The plan named three tables, all of
// them public — which omitted private.raw_listings, and since D-011 that table holds the only copy
// of Seek data anywhere. A hardcoded list also stops covering whatever the next migration adds,
// silently. Identifiers are cast to ::text on principle: node-postgres cannot parse `name[]`
// (OID 1003), and that bug has already shipped once in this repo.
const TABLES_SQL = `
  select n.nspname::text as schema_name, c.relname::text as table_name
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  where c.relkind = 'r'
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_%'
  order by 1, 2
`;

const qual = (r) => `"${r.schema_name}"."${r.table_name}"`;
const label = (r) => `${r.schema_name}.${r.table_name}`;

let tables;
const liveCounts = {};
let liveInventoryError;
try {
  tables = (await live.query(TABLES_SQL)).rows;
  check('live database has base tables to compare', tables.length > 0, `${tables.length} tables`);

  // Invariant 2 lives in the `private` schema, and it is the tier with no other copy. Assert it is
  // present in the live inventory so a silent disappearance upstream cannot make this test vacuous.
  const livePrivate = tables.filter((t) => t.schema_name === 'private').map(label);
  check('live database has private-schema tables', livePrivate.length > 0, livePrivate.join(', ') || 'none');

  for (const t of tables) {
    liveCounts[label(t)] = (await live.query(`select count(*)::int as n from ${qual(t)}`)).rows[0].n;
  }
} catch (error) {
  liveInventoryError = error;
} finally {
  try {
    await live.end();
  } catch (error) {
    console.error(`verify-restore: live client close failed — ${firstLine(error)}`);
    if (!liveInventoryError) liveInventoryError = error;
  }
}
if (liveInventoryError) throw liveInventoryError;

// --- 3. Does the dump's own manifest carry the private tier? ----------------------------------

let manifest = '';
try {
  const result = await streamFileToCommand({
    command: 'docker',
    args: dockerComposeArgs(
      REPOSITORY,
      'exec', '-T', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', 'postgres',
      'pg_restore', '--list'
    ),
    source: dumpPath,
    cwd: REPOSITORY.root,
    env: {
      ...process.env,
      PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '',
      PGOPTIONS: '-c client_min_messages=warning',
    },
    stdout: 'pipe',
    stderr: 'pipe',
    encoding: 'utf8',
  });
  manifest = result.stdout;
} catch (err) {
  check('dump manifest readable', false, firstLine(err));
}
if (manifest) {
  const privateEntries = manifest
    .split('\n')
    .filter((l) => /\bprivate\b/.test(l) && !l.trimStart().startsWith(';'));
  check(
    'dump manifest contains the private schema',
    privateEntries.some((l) => /TABLE DATA private /.test(l)),
    privateEntries.length ? `${privateEntries.length} private entries` : 'no private entries in manifest'
  );
}

// --- 4. Restore into the scratch database -----------------------------------------------------

let lifecycleFailureReported = false;
try {
  await runRestoreProbeLifecycle({
    assertDroppable,
    createScratch: async (name) => {
      try {
        assertDroppable(name);
        dockerPg(['psql', '-U', USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
          `drop database if exists ${name} with (force)`]);
        dockerPg(['psql', '-U', USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
          `create database ${name}`]);
      } catch (error) {
        lifecycleFailureReported = true;
        check('scratch database created', false, firstLine(error));
        throw error;
      }
    },
    restoreScratch: async (name) => {
      try {
        await streamFileToCommand({
          command: 'docker',
          args: dockerComposeArgs(
            REPOSITORY,
            'exec', '-T', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', 'postgres',
            'pg_restore', '-U', USER, '-d', name, '--no-owner', '--exit-on-error'
          ),
          source: dumpPath,
          cwd: REPOSITORY.root,
          env: {
            ...process.env,
            PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '',
            PGOPTIONS: '-c client_min_messages=warning',
          },
          stdout: 'pipe',
          stderr: 'pipe',
          encoding: 'utf8',
        });
        check('pg_restore completed', true, latest);
      } catch (error) {
        lifecycleFailureReported = true;
        check('pg_restore completed', false, firstLine(error));
        throw error;
      }
    },
    connectScratch: createScratchConnector({
      createClient: (name) => new Client({ ...base, database: name }),
      onCloseError: (closeError) => {
        console.error(`verify-restore: failed scratch client close — ${firstLine(closeError)}`);
      },
    }),
    inspectScratch: async (restored) => {
      for (const t of tables) {
        const key = label(t);
        let n = null;
        let err = null;
        try {
          n = (await restored.query(`select count(*)::int as n from ${qual(t)}`)).rows[0].n;
        } catch (error) {
          err = error;
        }
        check(
          `${key} row count matches`,
          err === null && n === liveCounts[key],
          err ? `not restorable: ${firstLine(err)}` : `live ${liveCounts[key]} vs restored ${n}`
        );
      }
    },
    closeScratch: (client) => client.end(),
    dropScratch: async (name) => {
      dockerPg(['psql', '-U', USER, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-c',
        `drop database if exists ${name} with (force)`]);
    },
    onCleanupError: (label, error) => {
      console.error(`verify-restore: ${label} failed — ${firstLine(error)}`);
    },
  });
} catch (error) {
  if (!lifecycleFailureReported) {
    check('restore probe lifecycle completed', false, firstLine(error));
  }
}

finish();
