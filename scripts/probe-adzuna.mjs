// Q2 — does Adzuna actually cover NZ, AU and SG?
//
// HANDOFF has called this "five minutes that could reshape a weekend" since 2026-08-08, and it is
// the last thing standing between the breadth layer being real and being an assumption. Everything
// known so far is inference from consumer websites: adzuna.co.nz advertises 15,000+ NZ jobs and
// adzuna.com.au operates, so `nz` and `au` are near-certain — but an operating consumer site does
// not prove API coverage, and adzuna.sg returned HTTP 405, which proves nothing either way.
//
// SECRET DISCIPLINE. The credentials are read from the environment and NEVER printed. The request
// URL carries them as query parameters, so no URL is ever logged either — not on success, not in an
// error, not in a stack trace. Every line this script prints is safe to paste into a commit message
// or an issue, which is the standard worth holding given the whole point of docs/SOURCES.md is
// producing evidence other people can read.

const APP_ID = process.env.ADZUNA_APP_ID;
const APP_KEY = process.env.ADZUNA_APP_KEY;

if (!APP_ID || !APP_KEY) {
  console.error('ADZUNA_APP_ID and ADZUNA_APP_KEY must be set.');
  console.error('Add them to .env (gitignored), then run: npm run probe:adzuna');
  process.exit(1);
}

// Countries to test. Spec order: NZ first, AU next, SG at v3. `gb` is a CONTROL — Adzuna's original
// market. If gb fails too, the problem is the key or the account, not coverage, and that distinction
// decides whether the next hour is spent on credentials or on replacing the breadth layer.
const COUNTRIES = [
  { code: 'nz', why: 'v1 — the whole project starts here' },
  { code: 'au', why: 'v2 — largest coverage gain per unit of effort' },
  { code: 'sg', why: 'v3 — inconclusive until now (405 on the consumer site)' },
  { code: 'gb', why: 'CONTROL — Adzuna home market; failure here means credentials, not coverage' },
];

const results = [];

for (const { code, why } of COUNTRIES) {
  const url = new URL(`https://api.adzuna.com/v1/api/jobs/${code}/search/1`);
  url.searchParams.set('app_id', APP_ID);
  url.searchParams.set('app_key', APP_KEY);
  url.searchParams.set('results_per_page', '20');
  url.searchParams.set('what', 'data engineer');
  url.searchParams.set('content-type', 'application/json');

  let line;
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const text = await res.text();

    if (!res.ok) {
      // Status and length only. The body can echo the request, and the request contains the key.
      line = { code, why, verdict: 'FAILED', detail: `HTTP ${res.status} (${text.length}B body, not shown)` };
    } else {
      const j = JSON.parse(text);
      const ads = j.results ?? [];
      const withSalary = ads.filter((a) => a.salary_min != null || a.salary_max != null).length;
      const predicted = ads.filter((a) => a.salary_is_predicted === '1' || a.salary_is_predicted === 1).length;
      line = {
        code, why,
        verdict: ads.length > 0 ? 'VERIFIED' : 'EMPTY',
        detail: `count=${j.count ?? '?'} page=${ads.length} salary=${withSalary}/${ads.length} predicted=${predicted}`,
        sample: ads[0]?.title?.slice(0, 46),
        currency: ads[0]?.salary_currency ?? ads[0]?.currency,
      };
    }
  } catch (err) {
    line = { code, why, verdict: 'FAILED', detail: err.message.replace(APP_KEY, '[REDACTED]').replace(APP_ID, '[REDACTED]') };
  }
  results.push(line);
  console.log(`[${line.verdict.padEnd(8)}] ${code}  ${line.detail}${line.sample ? `  e.g. "${line.sample}"` : ''}`);
  await new Promise((r) => setTimeout(r, 600)); // polite
}

console.log('\n--- what this decides ---');
const ok = (c) => results.find((r) => r.code === c)?.verdict === 'VERIFIED';
const control = ok('gb');

if (!control && !ok('nz')) {
  console.log('  gb (control) ALSO failed — this is a CREDENTIAL or ACCOUNT problem, not coverage.');
  console.log('  Do not conclude anything about NZ from this run. Check the key, then re-run.');
} else {
  console.log(`  nz  ${ok('nz') ? 'COVERED — the breadth layer stands, M2 Task 6 can proceed' : 'NOT COVERED — STOP. The breadth layer needs replacing before M2.'}`);
  console.log(`  au  ${ok('au') ? 'COVERED — v2 expansion is a config row, as designed' : 'NOT COVERED — v2 needs a different source'}`);
  console.log(`  sg  ${ok('sg') ? 'COVERED — Q2 fully closed, v3 unblocked' : 'NOT COVERED — v3 needs an alternative; this was always the open half of Q2'}`);
}

const predictedSeen = results.some((r) => /predicted=[1-9]/.test(r.detail ?? ''));
if (predictedSeen) {
  console.log('\n  NOTE: predicted salaries present in the sample. Spec section on compensation is');
  console.log('  explicit — salary_is_predicted must be carried through and NEVER mixed with');
  console.log('  disclosed pay. Blending them is the most credibility-destroying error available.');
}

console.log('\nNo URL or credential was printed by this script, by design.');
