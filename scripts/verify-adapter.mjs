import { createChecker } from './lib/verify.mjs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

// M2 Task 1 — the adapter contract, asserted against SAVED FIXTURES and never the network.
//
// Fixtures rather than live calls, for two reasons. A test that fails because a third party is
// having a bad afternoon teaches everyone to re-run it until it goes green, which is how a real
// regression gets waved through. And a committed fixture freezes the upstream SHAPE, so the day
// Adzuna renames a field it shows up as a diff in a pull request instead of as silently missing
// data three weeks later.
//
// THE ASSERTION THAT MATTERS is the volatile-field one, and it exists because of something found in
// real data on the first day of collection rather than something imagined. Adzuna returned
// duplicate advertisements within one capture with different payloads. Their source identifiers
// are deliberately omitted from public-safe code. The difference was `adref`, a per-request signed
// token regenerated on every single fetch.
//
// Under the D-008 idempotency key `(source_id, source_ref, payload_hash)` that is not a harmless
// detail: every advertisement would hash differently on every run, land as a brand new row, and be
// recorded as an EDIT. Twice-daily collection across three countries would have manufactured roughly
// 600 spurious revisions a day and destroyed the revision-history signal D-008 was created to
// capture — while looking, from the outside, exactly like a busy job market.
//
// The adapter is therefore responsible for stripping volatile fields, and this proves it did.
// (Key ORDER needs no handling: `payload jsonb` normalises it in Postgres, verified 2026-08-09 —
// md5 of the two orderings is equal. Only genuinely different VALUES matter here.)

const { check, finish } = createChecker('verify-adapter');

// Hash the way PRODUCTION hashes, which is not the way JSON.stringify does.
//
// `payload_hash` is `md5(payload::text)` on a `jsonb` column, and jsonb normalises key order —
// measured 2026-08-09: md5 of `{"a":1,"b":2}` and `{"b":2,"a":1}` are equal as jsonb. Adzuna does
// vary key order between responses, so a key-order-sensitive hash here reports differences the
// database would never see.
//
// The first version of this file used JSON.stringify directly and did exactly that: it failed on
// the `category` object's key order and would have driven a pointless "fix" in the adapter, deleting
// a field to satisfy a test that was wrong rather than a system that was broken. Ninth defect of the
// same family — a guard asserting the wrong property — so it is written down rather than quietly
// corrected.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  }
  return value;
}
const hash = (o) => createHash('md5').update(JSON.stringify(canonical(o))).digest('hex');

const FIXTURES = join('adapters', 'fixtures');
const files = (await readdir(FIXTURES).catch(() => [])).filter((f) => f.endsWith('.json'));
check('fixtures exist', files.length > 0, `${files.length} found`);

const countries = new Set(['nz', 'au', 'sg', '_global']); // mirrors config/sources.json

for (const f of files) {
  const fixture = JSON.parse(await readFile(join(FIXTURES, f), 'utf8'));
  const name = fixture.source;

  let adapt;
  let requiredFields;
  try {
    ({ default: adapt, REQUIRED_FIELDS: requiredFields } = await import(`../adapters/${name}.mjs`));
  } catch (err) {
    check(`${name}: adapter module loads`, false, err.message.split('\n')[0]);
    continue;
  }
  check(`${name}: adapter module loads`, typeof adapt === 'function');
  check(`${name}: exports capture-time required fields`,
    JSON.stringify(requiredFields) === JSON.stringify(name === 'adzuna' ? ['id'] : ['slug']),
    JSON.stringify(requiredFields));

  const out = adapt(fixture);

  check(`${name}: returns an array`, Array.isArray(out), Array.isArray(out) ? `${out.length} records` : typeof out);
  if (!Array.isArray(out)) continue;

  check(`${name}: every record has a non-empty source_ref`,
    out.every((r) => typeof r.source_ref === 'string' && r.source_ref.length > 0));

  check(`${name}: every country_code is known`,
    out.every((r) => countries.has(r.country_code)),
    [...new Set(out.map((r) => r.country_code))].join(', '));

  check(`${name}: every record carries a payload object`,
    out.every((r) => r.payload && typeof r.payload === 'object'));

  // PURITY. The contract says an adapter is a pure function of its input — no clock, no network, no
  // randomness — because the loader may re-run it over years of archived files and must get the
  // same answer every time. A timestamp captured inside the adapter would break that silently.
  check(`${name}: same input twice gives identical output`, hash(adapt(fixture)) === hash(out));

  // THE ONE FROM REAL DATA.
  const byRef = new Map();
  for (const r of out) {
    if (!byRef.has(r.source_ref)) byRef.set(r.source_ref, new Set());
    byRef.get(r.source_ref).add(hash(r.payload));
  }
  const unstable = [...byRef.entries()].filter(([, hashes]) => hashes.size > 1);
  check(
    `${name}: the same ad captured twice hashes identically (volatile fields stripped)`,
    unstable.length === 0,
    unstable.length ? `${unstable.length} ref(s) with unstable payloads: ${unstable.map(([r]) => r).join(', ')}` : 'no unstable refs'
  );
}

// ---------------------------------------------------------------------------
// Capture-time validation — the guard that catches an upstream rename ON THE DAY
// ---------------------------------------------------------------------------
//
// These are negative cases and they belong here permanently rather than in a one-off script,
// because the thing being guarded is a FUTURE event: a source renaming a field months from now,
// probably while nobody is looking. `validateCapture` runs inside ingest-raw.mjs and refuses the
// write when it trips, which matters because raw is immutable — a bad partition cannot be deleted
// afterwards, only annotated around forever.
//
// Note what these do NOT rely on: the saved fixture staying accurate. The fixture is frozen by
// design, which is exactly why it cannot notice the live source changing shape underneath it.

const { validateCapture } = await import('../adapters/validate.mjs');

for (const f of files) {
  const fixture = JSON.parse(await readFile(join(FIXTURES, f), 'utf8'));
  const { source: name, country } = fixture;
  let adapt;
  let requiredFields;
  try {
    ({ default: adapt, REQUIRED_FIELDS: requiredFields } = await import(`../adapters/${name}.mjs`));
  } catch { continue; }

  const run = (records) => validateCapture({
    sourceId: name,
    country,
    records,
    adapt,
    requiredFields,
  });

  const clean = await run(fixture.records);
  check(`${name}: validator accepts the saved fixture`, clean.ok, clean.problems.join('; ') || 'no problems');

  if (name === 'adzuna') {
    const optionalFields = new Set(['salary_min', 'salary_max', 'latitude', 'longitude', 'contract_type']);
    const sparse = await run(fixture.records.map((record) => Object.fromEntries(
      Object.entries(record).filter(([field]) => !optionalFields.has(field)),
    )));
    check('adzuna: validator TOLERATES optional fields disappearing from every record',
      sparse.ok,
      sparse.problems.join('; ') || 'accepted');
    check('adzuna: validator NOTES optional fields disappearing from every record',
      sparse.notes.some((note) => note.includes('fields absent from ALL records now')),
      sparse.notes.join('; ') || 'no note reported');

    const withoutIdentity = await run(fixture.records.map(({ id: _id, ...record }) => record));
    check('adzuna: validator REJECTS id disappearing from every record',
      !withoutIdentity.ok && withoutIdentity.problems.some((problem) => problem.includes('required fields absent')),
      withoutIdentity.ok ? 'accepted — required identity drift would pass' : withoutIdentity.problems.join('; '));
  }

  if (name === 'arbeitnow') {
    const identityOnly = await run(fixture.records.map(({ slug }) => ({ slug })));
    check('arbeitnow: validator TOLERATES non-identity fields disappearing from every record',
      identityOnly.ok,
      identityOnly.problems.join('; ') || 'accepted');
    check('arbeitnow: validator NOTES non-identity fields disappearing from every record',
      identityOnly.notes.some((note) => note.includes('fields absent from ALL records now')),
      identityOnly.notes.join('; ') || 'no note reported');

    const withoutIdentity = await run(fixture.records.map(({ slug: _slug, ...record }) => record));
    check('arbeitnow: validator REJECTS slug disappearing from every record',
      !withoutIdentity.ok && withoutIdentity.problems.some((problem) => problem.includes('required fields absent')),
      withoutIdentity.ok ? 'accepted — required identity drift would pass' : withoutIdentity.problems.join('; '));
  }

  // Records stripped to nothing — what an upstream rename effectively produces, since the adapter
  // reads a field that is no longer there.
  const empty = await run(fixture.records.map(() => ({})));
  check(`${name}: validator REJECTS records missing their identity field`, !empty.ok,
    empty.ok ? 'accepted — an upstream rename would pass unnoticed' : `${empty.problems.length} problem(s) reported`);

  // Identity collapse that still yields valid strings. Padded past the rule's minimum sample,
  // because the check is deliberately loose enough to tolerate genuine pagination duplicates.
  const padded = Array.from({ length: 20 }, () => structuredClone(fixture.records[0]));
  const collapsed = await run(padded);
  check(`${name}: validator REJECTS a mass identity collapse`, !collapsed.ok,
    collapsed.ok ? 'accepted — every ad sharing one ref would pass' : 'collapse detected');

  // Sources add fields all the time. Treating that as a failure would make the guard unusable and
  // it would be switched off, which is worse than not having it.
  const extended = await run(fixture.records.map((r) => ({ ...r, brand_new_field: 'x' })));
  check(`${name}: validator TOLERATES a new upstream field`, extended.ok, extended.problems.join('; ') || 'accepted');
}

finish();
