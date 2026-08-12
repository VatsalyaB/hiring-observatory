import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// Task 5c support — the unattended proof, read from the repository itself.
//
// The exit condition for M1 is that a SCHEDULED run fired while nobody was watching. That fact
// lives in two places: the Actions tab, which needs a browser and a login, and the committed
// payload's `event_name`, which does not. This reads the second one.
//
// It also answers the question 5c Step 3 asks and a single night cannot: how late does GitHub
// actually start these? One sample is an anecdote. The 48h staleness window in sql/004 was chosen
// against an assumption, and this is what will replace that assumption with a measurement.
//
// Read-only. It never writes to raw/ — that would defeat the thing it is measuring.

const DIR = join('raw', '_canary');
const CRONS = ['09:17', '21:17']; // UTC, from .github/workflows/canary.yml

const files = await readdir(DIR).catch(() => []);
const partitions = files.filter((f) => f.endsWith('.json')).sort();

if (partitions.length === 0) {
  console.log('No canary partitions yet.');
  console.log('Expected raw/_canary/<YYYY-MM-DD>.json — none found.');
  console.log('If the workflow has been pushed and a cron has passed, that is the finding.');
  process.exit(0);
}

const rows = [];
for (const f of partitions) {
  const p = JSON.parse(await readFile(join(DIR, f), 'utf8'));
  const observed = new Date(p.observed_at);

  // Which cron instant did this write follow? Normally the day's first (09:17Z). If the write
  // instead follows 21:17Z, the 09:17Z run was DROPPED — precisely the failure GitHub documents
  // and the reason there are two crons at all.
  const candidates = CRONS.map((c) => new Date(`${p.partition}T${c}:00Z`)).filter((d) => d <= observed);
  const scheduled = candidates.at(-1) ?? null;

  const scheduledRun = p.event_name === 'schedule';
  rows.push({
    partition: p.partition,
    event: p.event_name,
    observed: p.observed_at.replace('T', ' ').replace(/\..*/, 'Z'),
    delayMin: scheduledRun && scheduled ? Math.round((observed - scheduled) / 60000) : null,
    firedAt: scheduled ? scheduled.toISOString().slice(11, 16) : '—',
    droppedFirst: scheduledRun && scheduled && scheduled.toISOString().slice(11, 16) === '21:17',
    run: p.run_id,
  });
}

const w = (s, n) => String(s).padEnd(n);
console.log(`${w('partition', 12)}${w('trigger', 18)}${w('written (UTC)', 22)}${w('after cron', 12)}delay`);
console.log('-'.repeat(74));
for (const r of rows) {
  const delay = r.delayMin === null ? '—' : `${r.delayMin} min${r.droppedFirst ? '  ** 09:17 RUN WAS DROPPED **' : ''}`;
  console.log(`${w(r.partition, 12)}${w(r.event, 18)}${w(r.observed, 22)}${w(r.firedAt, 12)}${delay}`);
}

// Gaps matter more than delays. A late run is an inconvenience; a missing UTC day is a hole in the
// dataset that cannot be backfilled, because these sources only publish current vacancies.
const first = new Date(`${rows[0].partition}T00:00:00Z`);
const today = new Date(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
const have = new Set(rows.map((r) => r.partition));
const gaps = [];
for (let d = new Date(first); d < today; d.setUTCDate(d.getUTCDate() + 1)) {
  const key = d.toISOString().slice(0, 10);
  if (!have.has(key)) gaps.push(key);
}

const scheduled = rows.filter((r) => r.event === 'schedule');
const delays = scheduled.filter((r) => r.delayMin !== null).map((r) => r.delayMin);

console.log('\n--- summary ---');
console.log(`  partitions written      ${rows.length}`);
console.log(`  by a scheduled run      ${scheduled.length}`);
console.log(`  by workflow_dispatch    ${rows.filter((r) => r.event === 'workflow_dispatch').length}`);
console.log(`  missing UTC days        ${gaps.length}${gaps.length ? ` -> ${gaps.join(', ')}` : ''}`);
if (delays.length) {
  const mean = Math.round(delays.reduce((a, b) => a + b, 0) / delays.length);
  console.log(`  scheduled start delay   min ${Math.min(...delays)} / mean ${mean} / max ${Math.max(...delays)} min`);
  console.log(`  48h staleness window    ${Math.max(...delays) < 120 ? 'comfortable at this lag' : 'REVIEW — lag is material'}`);
} else {
  console.log('  scheduled start delay   no scheduled run has written a partition yet');
}

console.log(
  scheduled.length === 0
    ? '\nM1 EXIT CONDITION NOT MET — no partition has been written by a scheduled run.'
    : `\nM1 exit condition: SATISFIED by ${scheduled.length} scheduled write(s). Keep observing for dependability.`
);
