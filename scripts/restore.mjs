// Guarded restore. Closes Q12.
//
// The runbook text this replaces was:
//     pg_restore --clean --if-exists -d "$POSTGRES_DB" <file>
// which targets the LIVE database by default. Immutability triggers do not stop `DROP TABLE`, so
// running it with the wrong file destroys data — including the private tier, which after D-011 has
// no second copy anywhere. A warning beside a dangerous command does not make it safe; the command
// itself has to refuse.
//
//   node scripts/restore.mjs --from backups/<file>.dump --into <database>
//
// `--into` is mandatory and has no default. Targeting a protected database aborts unless
// RESTORE_ALLOW_LIVE is set to the exact confirmation string, which is deliberately awkward to type
// by accident.

import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  dockerComposeArgs,
  readCompleteBackupGeneration,
  resolveCanonicalRepository,
  streamFileToCommand,
} from './lib/backup-restore.mjs';

const CONFIRM = 'yes-overwrite-the-live-database';
const DATABASE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const from = arg('from');
const into = arg('into');
const LIVE = process.env.POSTGRES_DB;
const USER = process.env.POSTGRES_USER;
const N8N = process.env.N8N_DB;

function die(msg) {
  console.error(`ABORT  ${msg}`);
  process.exit(1);
}

if (!from || !into) {
  console.error('usage: node scripts/restore.mjs --from <dump> --into <database>');
  console.error('       --into is mandatory. There is no default, on purpose.');
  process.exit(2);
}
if (!DATABASE_IDENTIFIER.test(into)) {
  die('--into must be a plain lowercase PostgreSQL identifier (1-63 characters)');
}
if (!LIVE) die('POSTGRES_DB is not set — refusing to run');
if (!USER) die('POSTGRES_USER is not set — refusing to run');
if (!DATABASE_IDENTIFIER.test(LIVE)) {
  die('POSTGRES_DB must be a plain lowercase PostgreSQL identifier');
}
if (N8N && !DATABASE_IDENTIFIER.test(N8N)) {
  die('N8N_DB must be a plain lowercase PostgreSQL identifier when set');
}
const target = into;

// Protected names. `postgres` and the templates are included because clobbering them breaks the
// cluster, not merely a database.
const protectedDbs = [LIVE, N8N, 'postgres', 'template0', 'template1'].filter(Boolean);

if (protectedDbs.includes(target)) {
  if (process.env.RESTORE_ALLOW_LIVE !== CONFIRM) {
    die(
      `refusing to restore into "${target}" — it is a live or protected database.\n` +
      `       Protected: ${protectedDbs.join(', ')}\n` +
      `       This would DROP AND REPLACE its contents. The private tier has no second copy.\n` +
      `       If you genuinely mean it, set RESTORE_ALLOW_LIVE=${CONFIRM}`
    );
  }
  console.log(`WARNING  restoring into the live database "${target}" — confirmation was supplied.`);
}

let generation;
try {
  generation = await readCompleteBackupGeneration(resolve(from));
} catch (error) {
  die(`complete backup generation required — ${error?.message ?? error}`);
}

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = resolveCanonicalRepository({ cwd: ROOT });
const dockerEnv = {
  ...process.env,
  PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '',
};

function psql(db, sql) {
  return execFileSync('docker', dockerComposeArgs(
    REPOSITORY,
    'exec', '-T', '-e', 'PGPASSWORD', 'postgres',
    'psql', '-U', USER, '-d', db, '-tA', '-c', sql
  ), { cwd: REPOSITORY.root, encoding: 'utf8', env: dockerEnv });
}

const exists = psql('postgres', `select count(*) from pg_database where datname='${target}'`).trim() === '1';
if (!exists) {
  console.log(`creating database "${target}" (did not exist)`);
  psql('postgres', `create database "${target}"`);
}

console.log(`restoring ${basename(generation.dumpPath)} -> ${target}`);
try {
  await streamFileToCommand({
    command: 'docker',
    args: dockerComposeArgs(
      REPOSITORY,
      'exec', '-T', '-e', 'PGPASSWORD', 'postgres',
      'pg_restore', '-U', USER, '-d', target, '--no-owner', '--clean', '--if-exists',
      '--exit-on-error'
    ),
    source: generation.dumpPath,
    cwd: REPOSITORY.root,
    env: dockerEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    encoding: 'utf8',
  });
} catch (error) {
  const status = Number.isInteger(error?.status) ? `status ${error.status}` : 'command error';
  die(`pg_restore failed (${status})`);
}

// Roles are NOT in the dump. pg_dump carries the wall's GRANTs but not the role they reference,
// so a restore onto a fresh cluster brings the wall back as an empty promise. Say so loudly.
console.log('\nrestore finished. Next steps that are NOT automatic:');
console.log(
  `  1. Roles are not in the dump — apply ${basename(generation.globalsPath)}, then ` +
    '`npm run migrate`'
);
console.log('     to reset the publisher password from .env.');
console.log(`  2. Verify the wall actually came back: POSTGRES_DB=${target} node scripts/verify-wall.mjs`);
console.log('     A restored database with GRANTs but no role is a wall that guards nothing.');
