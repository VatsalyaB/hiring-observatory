import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Task 5b — the canary heartbeat.
//
// This is a REHEARSAL OF THE REAL INGESTION PATTERN, not a throwaway. The same partitioning, the
// same write-once discipline and the same commit mechanics carry M2's adapters. Getting it wrong
// here costs an evening; getting it wrong in M2 costs the dataset.
//
// WRITE-ONCE (invariant 1). The partition file is created once and never modified. Git stores a
// fresh blob for every changed file, so one growing file would duplicate the whole dataset into
// history on every run and cross GitHub's 1 GB guidance within months. The second run of any day
// must therefore be a genuine no-op, not a rewrite — and that is asserted, not assumed.
//
// UTC, DELIBERATELY (invariant 4). No country, currency or region may be hardcoded anywhere, and a
// canary partitioned on Pacific/Auckland would hardcode exactly that. UTC also has a property worth
// keeping: both crons (09:17 and 21:17 UTC) fall inside one UTC day, so each day sees one write and
// one no-op — which is what makes the redundancy against GitHub's documented dropped runs free.
// Real adapters partition by the source country's own timezone, which comes from `countries`, a
// config row. This canary has no country, hence no timezone to look up.

const OUT_DIR = join('raw', '_canary');

const exists = async (p) => access(p).then(() => true).catch(() => false);

// toISOString() is always UTC regardless of the runner's TZ. Stated explicitly because a future
// reader will reasonably wonder whether the host timezone leaks in here. It does not.
const partition = new Date().toISOString().slice(0, 10);
const file = join(OUT_DIR, `${partition}.json`);

if (await exists(file)) {
  // Not an error, and not a failure to report. This is the write-once rule working.
  const existing = JSON.parse(await readFile(file, 'utf8'));
  console.log(`already exists, no-op: ${file}`);
  console.log(`  written by run ${existing.run_id} attempt ${existing.run_attempt} via ${existing.event_name}`);
  console.log(`  observed_at ${existing.observed_at}`);
  process.exit(0);
}

const payload = {
  observed_at: new Date().toISOString(),
  partition,
  // `event_name` is not in the Task 5b brief and is the point of the whole exercise. 5c has to prove
  // a SCHEDULED run fired — not a workflow_dispatch someone clicked — and the Actions tab is the
  // only other place that distinction is visible. Recording it in the committed payload makes the
  // proof self-evidencing from `git log` alone, which matters because a correct no-op leaves no
  // commit at all, and because the Actions tab needs a browser and a login to read.
  event_name: process.env.GITHUB_EVENT_NAME ?? 'local',
  run_id: process.env.GITHUB_RUN_ID ?? 'local',
  run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? 'local',
  sha: process.env.GITHUB_SHA ?? 'local',
};

await mkdir(dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

console.log(`wrote ${file}`);
console.log(JSON.stringify(payload, null, 2));
