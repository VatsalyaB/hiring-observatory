import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  dockerComposeArgs,
  resolveCanonicalRepository,
  streamBackupSetAtomically,
} from './lib/backup-restore.mjs';

// pg_dump of the observatory database, run inside the canonical Postgres container and streamed to
// the invoking worktree's gitignored backups/ directory. Custom format (-Fc) so pg_restore can be
// selective and so the dump is compressed. The container's /backups bind mount is deliberately not
// part of this transfer.
//
// Since D-011 the raw store is a private git repo, but `private.raw_listings` — the Seek tier
// behind the wall — deliberately never enters either repository. That makes this dump the ONLY
// copy of the private tier that exists anywhere. scripts/verify-restore.mjs asserts the private
// schema is actually in it rather than assuming.
//
// Nightly scheduling and off-site upload are deferred to M2 on purpose. This is a manual dump with
// a proven restore, which is the thing M1 promised.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKUP_DIR = join(ROOT, 'backups');
const REPOSITORY = resolveCanonicalRepository({ cwd: ROOT });

const DB = process.env.POSTGRES_DB;
const USER = process.env.POSTGRES_USER;

if (!DB || !USER) {
  console.error('backup: POSTGRES_DB and POSTGRES_USER must be set');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const name = `observatory-${stamp}.dump`;
const globalsName = `observatory-${stamp}.globals.sql`;

// Create it from the host first so atomic partials and final files are owned by the invoking user.
mkdirSync(BACKUP_DIR, { recursive: true });

function dockerPg(args, opts = {}) {
  return execFileSync('docker', dockerComposeArgs(
    REPOSITORY,
    'exec', '-T', '-e', 'PGPASSWORD', 'postgres', ...args
  ), {
    cwd: REPOSITORY.root,
    encoding: 'utf8',
    env: { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '' },
    ...opts,
  });
}

// WSL2 tears the distro down between sessions, so the container may still be cold-starting.
// Bounded poll on pg_isready, same shape as the verify scripts — a spurious failure here would be
// indistinguishable from a real one, and this is the script that protects the only copy of the
// private tier.
const WAIT_MS = Number(process.env.VERIFY_WAIT_MS ?? 45000);
const started = Date.now();
let ready = false;
let lastErr = 'no attempt completed';
while (Date.now() - started < WAIT_MS) {
  try {
    dockerPg(['pg_isready', '-U', USER, '-d', DB], { stdio: 'pipe' });
    ready = true;
    break;
  } catch (err) {
    lastErr = String(err?.stderr || err?.message || err).split('\n')[0];
    await new Promise((r) => setTimeout(r, 500));
  }
}
if (!ready) {
  console.error(`backup: postgres not ready after ${WAIT_MS}ms — ${lastErr}`);
  process.exit(1);
}
const waited = Date.now() - started;
if (waited > 1000) console.log(`backup: waited ${(waited / 1000).toFixed(1)}s for postgres`);

const dockerEnv = { ...process.env, PGPASSWORD: process.env.POSTGRES_PASSWORD ?? '' };
// pg_dump covers one database; it does NOT cover cluster-level roles. Without them a restore onto
// a fresh cluster fails on the GRANT/REVOKE statements that ARE in the dump, and the `publisher`
// role that enforces invariant 2 would simply not exist — the wall would come back as an empty
// promise. --no-role-passwords is deliberate: it keeps every credential out of the file (invariant
// "no secrets in git" should not depend solely on .gitignore holding). The real password is
// re-applied by `npm run migrate`, which ALTERs the role from ${PUBLISHER_PASSWORD}.
const [dump, globals] = await streamBackupSetAtomically({
  entries: [
    {
      command: 'docker',
      args: dockerComposeArgs(
        REPOSITORY,
        'exec', '-T', '-e', 'PGPASSWORD', 'postgres',
        'pg_dump', '-U', USER, '-d', DB, '-Fc'
      ),
      destination: join(BACKUP_DIR, name),
      cwd: REPOSITORY.root,
      env: dockerEnv,
    },
    {
      command: 'docker',
      args: dockerComposeArgs(
        REPOSITORY,
        'exec', '-T', '-e', 'PGPASSWORD', 'postgres',
        'pg_dumpall', '-U', USER, '--roles-only', '--no-role-passwords'
      ),
      destination: join(BACKUP_DIR, globalsName),
      cwd: REPOSITORY.root,
      env: dockerEnv,
    },
  ],
});

console.log(`backup: wrote backups/${name} (${dump.bytes} bytes)`);
console.log(`backup: wrote backups/${globalsName} (${globals.bytes} bytes, no passwords)`);
