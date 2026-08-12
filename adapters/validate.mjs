import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

// CAPTURE-TIME VALIDATION. Runs BEFORE anything is written, and refuses the write on failure.
//
// The hole this closes. `verify-adapter.mjs` tests each adapter against a SAVED FIXTURE, which
// freezes the upstream shape — that is its purpose, and also its blind spot: the fixture keeps
// passing forever even after the live source has renamed a field. Meanwhile `ingest-raw.mjs` only
// checked that records were a non-empty array of objects. So the day Adzuna renames `id`, the
// adapter yields `source_ref: "undefined"` for every record, the capture is written and committed,
// and nothing anywhere complains.
//
// The consequence is not a lost day, which would be recoverable. Under
// `(source_id, source_ref, payload_hash)` every advertisement would collapse onto ONE ref and the
// dataset would fill with mutually-overwriting nonsense — permanently, because raw is immutable and
// a committed partition cannot be deleted or corrected, only annotated around forever.
//
// The churn report would eventually notice ("100% new every day"), but only days later and only
// after the bad partitions had already landed. Detection after an irreversible write is not a
// control. This runs at the one moment the damage is still preventable.

const FIXTURES = join('adapters', 'fixtures');

// The union of keys across a set of records. Optional fields legitimately vary per record, so only
// a field missing from EVERY record counts as gone.
const keyUnion = (records) => new Set(records.flatMap((r) => Object.keys(r ?? {})));

async function loadFixture(sourceId, country) {
  for (const name of [`${sourceId}-${country}.json`, `${sourceId}.json`]) {
    try {
      return JSON.parse(await readFile(join(FIXTURES, name), 'utf8'));
    } catch { /* try the next candidate */ }
  }
  return null;
}

/**
 * Returns { ok, problems[], notes[] }. `problems` is fatal — the caller must not write.
 */
export async function validateCapture({ sourceId, country, records, adapt, requiredFields }) {
  const problems = [];
  const notes = [];

  if (!Array.isArray(records) || records.length === 0) {
    return { ok: false, problems: ['no records returned'], notes };
  }

  // ---- 1. SHAPE DRIFT. Required identity fields are fatal when absent from every record. Other
  // fixture fields are allowed to disappear because optional upstream fields can be sparse by day.
  const required = new Set(requiredFields ?? []);
  const after = keyUnion(records);
  const missingRequired = [...required].filter((field) => !after.has(field));
  if (missingRequired.length) {
    problems.push(`required fields absent from ALL records now: ${missingRequired.join(', ')}`);
  }

  const fixture = await loadFixture(sourceId, country);
  if (!fixture) {
    notes.push('no fixture on file — shape drift cannot be checked for this source/country');
  } else {
    const before = keyUnion(fixture.records ?? []);
    const gone = [...before].filter((field) => !after.has(field) && !required.has(field));
    const added = [...after].filter((k) => !before.has(k));
    if (gone.length) notes.push(`fixture fields absent from ALL records now: ${gone.join(', ')}`);
    // New fields are normal and healthy — sources add things. Worth surfacing, never fatal.
    if (added.length) notes.push(`new fields since the fixture: ${added.join(', ')}`);
  }

  // ---- 2. IDENTITY. Run the real adapter over what we just fetched, so the thing being validated
  // is exactly the thing the loader will later rely on, rather than a second guess at it.
  let out;
  try {
    out = adapt({ records, country });
  } catch (err) {
    return { ok: false, problems: [...problems, `adapter threw: ${err.message}`], notes };
  }

  const bad = out.filter(
    (r) => typeof r.source_ref !== 'string' || r.source_ref === '' ||
           r.source_ref === 'undefined' || r.source_ref === 'null'
  );
  if (bad.length) {
    // The literal strings matter: `String(record.id)` on a renamed field yields "undefined", which
    // is a perfectly valid non-empty string and would pass a naive emptiness check.
    problems.push(`${bad.length}/${out.length} records produced an unusable source_ref`);
  }

  // ---- 3. MASS COLLAPSE. If identity breaks in a way that still yields strings, every record ends
  // up sharing one ref. Real data has duplicates — Adzuna returned 98 distinct refs from 100 records
  // on 2026-08-09 because pagination overlaps — so the bar is deliberately loose. Anything at or
  // below half is not a duplicate pattern, it is a collapse.
  const distinct = new Set(out.map((r) => r.source_ref)).size;
  if (out.length >= 10 && distinct <= out.length / 2) {
    problems.push(`only ${distinct} distinct source_refs across ${out.length} records — identity has collapsed`);
  }

  // ---- 4. COUNTRY. Cheap, and catches a config edit that silently mislabels a whole market.
  const wrong = out.filter((r) => r.country_code !== country);
  if (wrong.length) problems.push(`${wrong.length} records carry a country_code other than "${country}"`);

  return { ok: problems.length === 0, problems, notes };
}
