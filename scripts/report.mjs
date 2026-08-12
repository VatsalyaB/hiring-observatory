import { readFile } from 'node:fs/promises';
import { listBroadCaptures } from './lib/raw-capture-discovery.mjs';

// First look at the data. Aggregates only — invariant 3, and it is also what the source terms allow.
//
// WHAT ONE DAY CAN AND CANNOT SHOW, stated up front because this is where a portfolio project starts
// lying to itself. A single snapshot can describe COMPOSITION: who is advertising, in what
// proportions, disclosing what. It cannot describe CHANGE, and change is the entire point of an
// observatory. Every number below is "as at this capture", not a trend, and calling it a trend later
// would be the most obvious way to discredit the whole thing.

const files = await listBroadCaptures('.');

const captures = [];
for (const f of files) captures.push({ ...f, date: f.partition, data: JSON.parse(await readFile(f.path, 'utf8')) });

const dates = [...new Set(captures.map((c) => c.date))].sort();
const total = captures.reduce((n, c) => n + c.data.count, 0);

console.log('BROAD RANKED WINDOW — exploratory composition only; not a market census; no churn or lifespan claims');
console.log(`  ${total} advertisements across ${captures.length} captures`);
console.log(`  dates: ${dates.join(', ')}${dates.length === 1 ? '  (one day — composition only, no trend is derivable)' : ''}\n`);

const pct = (n, d) => (d === 0 ? '—' : `${Math.round((n / d) * 100)}%`);
const bar = (n, d, w = 22) => '█'.repeat(Math.round((n / Math.max(d, 1)) * w)).padEnd(w, '·');

// --- salary disclosure, the finding worth having ----------------------------------------------
console.log('  SALARY DISCLOSURE — what share of ads state pay at all');
console.log('  (Adzuna only; Arbeitnow does not carry structured salary fields)\n');
for (const c of captures.filter((c) => c.source === 'adzuna')) {
  const ads = c.data.records;
  const disclosed = ads.filter((a) => a.salary_min != null || a.salary_max != null);
  const predicted = disclosed.filter((a) => a.salary_is_predicted === '1' || a.salary_is_predicted === 1);
  const real = disclosed.length - predicted.length;
  console.log(`    ${c.country.padEnd(8)} ${bar(real, ads.length)}  ${String(real).padStart(3)}/${ads.length}  ${pct(real, ads.length).padStart(4)} genuinely disclosed${predicted.length ? `  (+${predicted.length} predicted, excluded)` : ''}`);
}

// --- who is advertising -----------------------------------------------------------------------
function top(items, n = 8) {
  const counts = new Map();
  for (const i of items) if (i) counts.set(i, (counts.get(i) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

console.log('\n  MOST ACTIVE ADVERTISERS (NZ)');
const nz = captures.find((c) => c.source === 'adzuna' && c.country === 'nz');
if (nz) {
  for (const [company, n] of top(nz.data.records.map((a) => a.company?.display_name))) {
    console.log(`    ${String(n).padStart(3)}  ${company}`);
  }
}

console.log('\n  WHERE THE NZ ROLES ARE');
if (nz) {
  for (const [loc, n] of top(nz.data.records.map((a) => a.location?.area?.[1]), 6)) {
    console.log(`    ${String(n).padStart(3)}  ${loc}`);
  }
}

console.log('\n  CONTRACT SHAPE (NZ, where stated)');
if (nz) {
  const stated = nz.data.records.filter((a) => a.contract_time || a.contract_type);
  for (const [k, n] of top(stated.map((a) => [a.contract_time, a.contract_type].filter(Boolean).join(' / ')), 5)) {
    console.log(`    ${String(n).padStart(3)}  ${k}`);
  }
  console.log(`    ${String(nz.data.records.length - stated.length).padStart(3)}  (not stated)`);
}

// --- composition within each capped ranked sample ---------------------------------------------
console.log('\n  ROLE MIX WITHIN EACH CAPPED RANKED SAMPLE — share of captured ads matching each term');
// WORD BOUNDARIES, NOT SUBSTRINGS. The first version of this used `.includes()` and reported "AI"
// at 41-56% — because "ai" occurs inside email, training, maintain, available, detail and chain.
// That is a plausible wrong answer, the expensive kind: nobody queries it, it goes in a chart, and
// the headline becomes "half of all IT roles mention AI". Two-letter acronyms need case-sensitive
// whole-word matching; everything else needs at minimum a word boundary.
const TERMS = [
  { label: 'data', re: /\bdata\b/i },
  { label: 'engineer', re: /\bengineer(ing|s)?\b/i },
  { label: 'analyst', re: /\banalyst(s)?\b/i },
  { label: 'security', re: /\bsecurity\b/i },
  { label: 'cloud', re: /\bcloud\b/i },
  { label: 'AI (strict)', re: /\bAI\b/ },              // case-SENSITIVE: excludes "ai" inside words
  { label: 'machine learning', re: /\bmachine learning\b/i },
  { label: 'developer', re: /\bdevelopers?\b/i },
];
const adz = captures.filter((c) => c.source === 'adzuna');
console.log(`    ${''.padEnd(18)}${adz.map((c) => c.country.padStart(7)).join('')}`);
for (const { label, re } of TERMS) {
  const row = adz.map((c) => {
    const hits = c.data.records.filter((a) => re.test(`${a.title} ${a.description}`)).length;
    return pct(hits, c.data.records.length).padStart(7);
  });
  console.log(`    ${label.padEnd(18)}${row.join('')}`);
}

// --- remote, from the source that tracks it ---------------------------------------------------
const arb = captures.find((c) => c.source === 'arbeitnow');
if (arb) {
  const remote = arb.data.records.filter((a) => a.remote).length;
  console.log(`\n  REMOTE (Arbeitnow, global)  ${bar(remote, arb.data.records.length)}  ${remote}/${arb.data.records.length}  ${pct(remote, arb.data.records.length)}`);
  console.log('\n  MOST COMMON TAGS (Arbeitnow)');
  for (const [tag, n] of top(arb.data.records.flatMap((a) => a.tags ?? []), 8)) {
    console.log(`    ${String(n).padStart(3)}  ${tag}`);
  }
}

console.log('\n  Sources: Adzuna (adzuna.com), Arbeitnow (arbeitnow.com). Aggregates only.\n');
