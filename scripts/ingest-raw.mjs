import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// CRUDE RAW CAPTURE. Deliberately minimal, deliberately shipped before M2's adapter contract.
//
// WHY THIS EXISTS AHEAD OF THE PROPER MILESTONE. Invariant 1 says raw is immutable and everything
// downstream is recomputable from it. That principle has a consequence the plan sequencing missed:
// **capture never needed the schema to be right.** Normalisation, extraction, the occupation
// taxonomy and the aggregates can all be built later over data already on disk — but a day not
// collected is gone permanently, because these sources publish CURRENT vacancies and no archive
// exists to backfill from. Thirty-seven commits of correctness produced zero rows, and the value of
// the eventual dataset is a function of when collection started.
//
// So this does one job: fetch, validate, write once, exit. It does not normalise, does not touch
// Postgres (CI cannot reach it), and does not pretend to be the adapter contract. M2 Task 1 replaces
// it with the tested, fixture-backed version — and, because raw is immutable, everything captured
// between now and then remains fully usable by it. That is the whole point of the invariant.
//
// THE ONE THING IT MUST NOT DO is commit garbage. Raw is immutable, so a malformed file is
// permanent — it cannot be deleted or corrected, only annotated around forever. Every fetch is
// therefore validated (parses, has records, records are objects) BEFORE anything is written, and a
// source that fails writes nothing at all rather than writing an empty shell.

const CONFIG = JSON.parse(await readFile(join('config', 'sources.json'), 'utf8'));
const UA = 'hiring-observatory/0.1 (portfolio research; github.com/VatsalyaB)';
const TIMEOUT_MS = 30000;

const exists = (p) => access(p).then(() => true).catch(() => false);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// UTC, like the canary. A canary or adapter partitioned on Pacific/Auckland would hardcode a region
// into the one layer that must not have one (invariant 4).
const partition = new Date().toISOString().slice(0, 10);

const provenance = {
  event_name: process.env.GITHUB_EVENT_NAME ?? 'local',
  run_id: process.env.GITHUB_RUN_ID ?? 'local',
  run_attempt: process.env.GITHUB_RUN_ATTEMPT ?? 'local',
  sha: process.env.GITHUB_SHA ?? 'local',
};

async function getJson(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    const text = await res.text();
    if (!res.ok) {
      // Status and body LENGTH only. An error body can echo the request back, and for Adzuna the
      // request carries credentials in its query string.
      throw new Error(`HTTP ${res.status} (${text.length}B body withheld)`);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// --- adapters: fetch and return raw records EXACTLY as received -------------------------------

const ADAPTERS = {
  async arbeitnow() {
    const j = await getJson('https://www.arbeitnow.com/api/job-board-api');
    return { records: j.data ?? [], meta: { endpoint: 'arbeitnow job-board-api' } };
  },

  async adzuna(src, country) {
    const id = process.env.ADZUNA_APP_ID;
    const key = process.env.ADZUNA_APP_KEY;
    if (!id || !key) throw new Error('ADZUNA_APP_ID / ADZUNA_APP_KEY not set');

    const records = [];
    let total = null;
    for (let page = 1; page <= (src.pages ?? 1); page++) {
      const u = new URL(`https://api.adzuna.com/v1/api/jobs/${country}/search/${page}`);
      u.searchParams.set('app_id', id);
      u.searchParams.set('app_key', key);
      u.searchParams.set('results_per_page', String(src.results_per_page ?? 50));
      u.searchParams.set('category', src.category);
      u.searchParams.set('content-type', 'application/json');
      const j = await getJson(u);
      total ??= j.count;
      records.push(...(j.results ?? []));
      await sleep(700); // polite; free tier
    }
    return { records, meta: { category: src.category, reported_total: total } };
  },
};

// --- run --------------------------------------------------------------------------------------

let wrote = 0;
let skipped = 0;
let failed = 0;
const failures = [];

for (const src of CONFIG.sources) {
  for (const country of src.countries) {
    const file = join('raw', src.id, country, `${partition}.json`);

    if (await exists(file)) {
      console.log(`skip   ${src.id}/${country} — already written (write-once)`);
      skipped++;
      continue;
    }

    try {
      const { records, meta } = await ADAPTERS[src.adapter](src, country);

      // Validate BEFORE writing. An empty or malformed capture written into an immutable store is
      // permanent, and worse than no capture: it looks like a day where the market was empty.
      if (!Array.isArray(records)) throw new Error('adapter did not return an array');
      if (records.length === 0) throw new Error('zero records — refusing to write an empty partition');
      if (typeof records[0] !== 'object' || records[0] === null) throw new Error('records are not objects');

      // Deeper validation against the real adapter and the saved fixture. This is the only check in
      // the system positioned to catch an upstream field rename ON THE DAY IT HAPPENS — the fixture
      // test cannot, because a frozen fixture keeps passing while live data breaks.
      const { validateCapture } = await import('../adapters/validate.mjs');
      const { default: adapt, REQUIRED_FIELDS } = await import(`../adapters/${src.adapter}.mjs`);
      const check = await validateCapture({
        sourceId: src.id,
        country,
        records,
        adapt,
        requiredFields: REQUIRED_FIELDS,
      });
      for (const n of check.notes) console.log(`  note   ${src.id}/${country} — ${n}`);
      if (!check.ok) throw new Error(check.problems.join('; '));

      const payload = {
        source: src.id,
        country,
        partition,
        fetched_at: new Date().toISOString(),
        ...provenance,
        count: records.length,
        meta,
        records, // exactly as received — invariant 1
      };

      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      console.log(`wrote  ${file} — ${records.length} records`);
      wrote++;
    } catch (err) {
      // Per-source isolation: one source failing must never cost the others their day. This is the
      // property M2 Task 3 Step 6 tests properly; here it is simply the shape of the loop.
      console.log(`FAIL   ${src.id}/${country} — ${err.message}`);
      failed++;
      failures.push(`${src.id}/${country}: ${err.message}`);
    }
  }
}

console.log(`\ningest-raw: ${wrote} written, ${skipped} already present, ${failed} failed`);

// PARTIAL FAILURE MUST STILL GO RED, but only AFTER the commit — which is why this reports rather
// than exits. Exiting non-zero here would abort the job before the commit step and throw away the
// sources that DID succeed, losing a day's data to punish a partial outage. Exiting zero silently
// would be worse: the most likely real failure is a missing ADZUNA_APP_KEY in repository secrets,
// which would quietly reduce the observatory to one source while every run showed green.
//
// So: succeed loudly, fail loudly, and let the workflow decide the exit code once the data is safe.
if (process.env.GITHUB_OUTPUT) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_OUTPUT, `failed=${failed}\nwrote=${wrote}\n`);
}
for (const f of failures) console.log(`::error::ingest failed for ${f}`);

// Exit non-zero only if EVERY source failed — there is nothing to commit, so nothing is lost.
process.exit(wrote === 0 && failed > 0 ? 1 : 0);
