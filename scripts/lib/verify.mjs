import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from 'pg';

// Shared harness for the verify scripts. Extracted after `check()` was found copy-pasted into
// eleven files, the pg config block into eight, and the connect-retry helper into four.
//
// WHY THE COMMENTS MOVED HERE RATHER THAN DIED (CLAUDE.md rule 10). Each copy carried its own
// paragraph explaining the WSL cold-start problem. Deduplicating the code deduplicates the
// explanation too — it survives once, where it actually governs, instead of eight times where it
// drifts. The rule is that the reasoning stays; it does not say it must stay eight times.

// WSL2 tears the distro down between sessions, so Postgres cold-starts on the next one and refuses
// connections for several seconds. Without a bounded wait the first verify of a session fails
// spuriously — and docs/REEVAL.md calls these scripts, so false alarms train us to ignore them,
// which is exactly how a real regression gets waved through. Cold starts have been measured at 15s.
export const WAIT_MS = Number(process.env.VERIFY_WAIT_MS ?? 45000);

const RETRY_MS = 500;

/** Owner connection settings. One definition, so a change lands everywhere. */
export const pgConfig = (overrides = {}) => ({
  host: process.env.POSTGRES_HOST ?? '127.0.0.1',
  port: Number(process.env.POSTGRES_PORT ?? 5432),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ...overrides,
});

/** `publisher` — the role the wall exists to constrain. */
export const publisherConfig = (overrides = {}) =>
  pgConfig({ user: 'publisher', password: process.env.PUBLISHER_PASSWORD, ...overrides });

/**
 * Poll an assertion until it succeeds or WAIT_MS elapses. `attempt` returns `{ ok, detail, ...rest }`.
 * Poll only the CONNECTION — retrying an assertion would hide a missing grant behind a 45s wait.
 */
export async function poll(attempt) {
  const started = Date.now();
  let last = 'no attempt completed';
  while (Date.now() - started < WAIT_MS) {
    try {
      const result = await attempt();
      if (result.ok) return { ...result, waitedMs: Date.now() - started };
      last = result.detail;
    } catch (err) {
      last = err.message;
    }
    await sleep(RETRY_MS);
  }
  return { ok: false, detail: `${last} (gave up after ${WAIT_MS}ms)`, waitedMs: Date.now() - started };
}

/** Connect with a bounded retry. Fresh Client per attempt — node-postgres refuses to reconnect one that failed. */
export async function connectWithRetry(cfg) {
  return poll(async () => {
    const c = new Client(cfg);
    try {
      await c.connect();
      return { ok: true, client: c };
    } catch (err) {
      await c.end().catch(() => {});
      return { ok: false, detail: err.message };
    }
  });
}

/** Surface a slow start rather than silently absorbing it. */
export const withWait = (result) =>
  result.waitedMs > 1000 ? `${result.detail} [waited ${(result.waitedMs / 1000).toFixed(1)}s]` : result.detail;

/** Pass/fail recorder plus the summary line and exit code every verify script repeated identically. */
export function createChecker(label) {
  let failed = 0;
  return {
    check(name, ok, detail = '') {
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
      if (!ok) failed++;
    },
    get failed() {
      return failed;
    },
    finish() {
      console.log(failed === 0 ? `\n${label}: OK` : `\n${label}: ${failed} failure(s)`);
      process.exit(failed === 0 ? 0 : 1);
    },
  };
}

/**
 * The UTC partition key, previously reimplemented in canary.mjs, ingest-raw.mjs and
 * canary-status.mjs. Changing it in two of three would silently split the dataset.
 *
 * UTC deliberately, under invariant 4: keying on Pacific/Auckland would hardcode a region into the
 * layer that must not have one. It also pairs both daily crons inside one partition, which is what
 * makes the second run of a day a genuine no-op.
 */
export const utcPartition = (d = new Date()) => d.toISOString().slice(0, 10);
