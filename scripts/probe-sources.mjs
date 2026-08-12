// Source prober — turns DOCS-VERIFIED and UNVERIFIED into evidence, or into FAILED.
//
// `docs/SOURCES.md` draws a hard line: VERIFIED means "called the endpoint and got real data back",
// and the file exists because that line was crossed carelessly once already — four ATS sources were
// marked VERIFIED when only their documentation had been read.
//
// So HTTP 200 is NOT the bar here, and this script is deliberately stricter than a health check.
// `api.lever.co/v0/postings/lever` returns 200 with a two-byte body: `[]`. The endpoint plainly
// exists; it returned no listings. Under the file's own definition that is not verification, so
// every probe below must extract a non-empty record set AND pull a sample field out of it. A source
// that answers but yields nothing is reported as reachable-but-empty, never as VERIFIED.
//
// Read-only, keyless, and polite: one request at a time with a delay between them. Anything needing
// a key is listed at the bottom as blocked rather than silently skipped — and anything needing a
// PAID key is out of scope entirely under D-014.

const UA = 'hiring-observatory/0.1 (portfolio research; contact via github.com/VatsalyaB)';
const TIMEOUT_MS = 20000;
const POLITE_MS = 400;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctl.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Each probe: candidate URLs tried in order until one yields a NON-EMPTY record set.
// `extract` returns { n, sample } or throws.
const PROBES = [
  {
    name: 'Greenhouse', cls: 'B',
    urls: ['gitlab', 'duolingo', 'databricks', 'cloudflare', 'figma'].map(
      (c) => `https://boards-api.greenhouse.io/v1/boards/${c}/jobs`
    ),
    extract: (j) => ({ n: j.jobs?.length ?? 0, sample: j.jobs?.[0]?.title }),
  },
  {
    name: 'Lever', cls: 'B',
    urls: ['netflix', 'plaid', 'ramp', 'brex', 'mistral'].map(
      (c) => `https://api.lever.co/v0/postings/${c}?mode=json`
    ),
    extract: (j) => ({ n: Array.isArray(j) ? j.length : 0, sample: j?.[0]?.text }),
  },
  {
    name: 'Ashby', cls: 'B',
    urls: ['ashby', 'linear', 'vanta', 'clerk', 'replit'].map(
      (c) => `https://api.ashbyhq.com/posting-api/job-board/${c}`
    ),
    extract: (j) => ({ n: j.jobs?.length ?? 0, sample: j.jobs?.[0]?.title }),
  },
  {
    name: 'SmartRecruiters', cls: 'B',
    urls: ['smartrecruiters', 'Ubisoft', 'Bosch'].map(
      (c) => `https://api.smartrecruiters.com/v1/companies/${c}/postings?limit=10`
    ),
    extract: (j) => ({ n: j.content?.length ?? 0, sample: j.content?.[0]?.name }),
  },
  {
    name: 'Workable', cls: 'B',
    urls: ['https://apply.workable.com/api/v1/widget/accounts/workable?details=true'],
    extract: (j) => ({ n: j.jobs?.length ?? 0, sample: j.jobs?.[0]?.title }),
  },
  {
    name: 'Recruitee', cls: 'B',
    urls: ['recruitee', 'catawiki'].map((c) => `https://${c}.recruitee.com/api/offers/`),
    extract: (j) => ({ n: j.offers?.length ?? 0, sample: j.offers?.[0]?.title }),
  },
  {
    name: 'The Muse', cls: 'A',
    urls: ['https://www.themuse.com/api/public/jobs?page=1'],
    extract: (j) => ({ n: j.results?.length ?? 0, sample: j.results?.[0]?.name }),
  },
  {
    name: 'HN Algolia', cls: 'D',
    urls: ['https://hn.algolia.com/api/v1/search?query=Ask%20HN%20Who%20is%20hiring&tags=story&hitsPerPage=5'],
    extract: (j) => ({ n: j.hits?.length ?? 0, sample: j.hits?.[0]?.title }),
  },
  {
    name: 'GitHub API', cls: 'D',
    urls: ['https://api.github.com/search/repositories?q=language:python&sort=stars&per_page=3'],
    extract: (j) => ({ n: j.items?.length ?? 0, sample: j.items?.[0]?.full_name }),
  },
  {
    name: 'Stack Exchange', cls: 'D',
    urls: ['https://api.stackexchange.com/2.3/tags?site=stackoverflow&pagesize=3&order=desc&sort=popular'],
    extract: (j) => ({ n: j.items?.length ?? 0, sample: j.items?.[0]?.name }),
  },
  {
    name: 'npm registry', cls: 'D',
    urls: ['https://api.npmjs.org/downloads/point/last-week/typescript'],
    extract: (j) => ({ n: j.downloads ? 1 : 0, sample: `${j.package}: ${j.downloads?.toLocaleString()} dl/wk` }),
  },
  {
    name: 'PyPI', cls: 'D',
    urls: ['https://pypi.org/pypi/pandas/json'],
    extract: (j) => ({ n: j.info ? 1 : 0, sample: `${j.info?.name} ${j.info?.version}` }),
  },
  {
    name: 'data.gov.sg', cls: 'C',
    urls: ['https://api-open.data.gov.sg/v1/public/api/datasets?page=1'],
    extract: (j) => ({ n: j.data?.datasets?.length ?? 0, sample: j.data?.datasets?.[0]?.name }),
  },
];

const results = [];

for (const probe of PROBES) {
  let outcome = { name: probe.name, cls: probe.cls, verdict: 'FAILED', detail: 'no candidate responded', url: '' };

  for (const url of probe.urls) {
    const res = await get(url);
    await sleep(POLITE_MS);

    if (!res.ok) {
      outcome.detail = res.error ?? `HTTP ${res.status}`;
      outcome.url = url;
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      outcome = { ...outcome, verdict: 'FAILED', detail: `HTTP 200 but body is not JSON (${res.text.length}B)`, url };
      continue;
    }
    let n = 0;
    let sample;
    try {
      ({ n, sample } = probe.extract(parsed));
    } catch (err) {
      outcome = { ...outcome, verdict: 'FAILED', detail: `shape mismatch: ${err.message}`, url };
      continue;
    }

    if (n > 0) {
      outcome = {
        name: probe.name, cls: probe.cls, verdict: 'VERIFIED', url,
        detail: `${n} record(s) — e.g. ${String(sample ?? '(no sample field)').slice(0, 52)}`,
      };
      break;
    }
    // 200 + valid JSON + zero records. Reachable, but NOT verification under this repo's rules.
    outcome = { name: probe.name, cls: probe.cls, verdict: 'EMPTY', url, detail: 'HTTP 200, valid JSON, zero records' };
  }
  results.push(outcome);
  const mark = outcome.verdict === 'VERIFIED' ? '  OK  ' : outcome.verdict === 'EMPTY' ? ' EMPTY' : ' FAIL ';
  console.log(`[${mark}] ${outcome.name.padEnd(16)} ${outcome.detail}`);
}

console.log('\n--- endpoints that produced data ---');
for (const r of results.filter((r) => r.verdict === 'VERIFIED')) console.log(`  ${r.name.padEnd(16)} ${r.url}`);

const by = (v) => results.filter((r) => r.verdict === v).length;
console.log(`\nVERIFIED ${by('VERIFIED')}   EMPTY ${by('EMPTY')}   FAILED ${by('FAILED')}   of ${results.length} probed`);
console.log('\nBlocked on a free key, not probed here: Adzuna (Q2), Jooble, Careerjet.');
console.log('Out of scope under D-014 (paid): JSearch/RapidAPI.');
