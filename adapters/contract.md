# The adapter contract

An adapter is a **pure function** from one captured raw file to a list of records:

```js
export default function adapt(file) {
  return [{ source_ref, country_code, payload }, ...];
}
```

It does **no** fetching, **no** file writing, **no** database access and **no** committing. Those
belong to `scripts/ingest-raw.mjs` and, later, the loader — so that write-once, partitioning and
commit mechanics have exactly one implementation instead of one per source.

## The three rules

**1. Pure.** No clock, no network, no randomness, no environment. The loader may re-run an adapter
over years of archived files and must get the same answer every time. `verify-adapter.mjs` asserts
this by running each adapter twice and comparing hashes.

**2. `source_ref` is the source's own stable identifier.** Adzuna's `id`, Arbeitnow's `slug`. Never
a hash, never an index, never something we invent — it must survive the source re-ordering its
results.

**3. Volatile fields must be stripped from `payload`.** This is the rule that exists because of
evidence, not foresight, and it is the one most likely to be undone by someone tidying up.

## Why rule 3 exists

On the first day of collection (2026-08-09) Adzuna returned duplicate advertisements inside one
capture. The source identifiers are deliberately omitted from public-safe documentation. The
payloads differed, and the differing field was
`adref`: a per-request signed token that Adzuna regenerates on **every fetch**.

The idempotency key is `(source_id, source_ref, payload_hash)` with `ON CONFLICT DO NOTHING`
(D-008). A field that changes on every request means every advertisement hashes differently on every
run, lands as a brand-new row, and is recorded as an **edit**. Twice-daily collection across three
countries would have manufactured roughly 600 spurious revisions per day — and it would have looked,
from any dashboard, exactly like an unusually dynamic job market.

That is worse than a crash. It is a plausible wrong answer.

**Key ORDER needs no handling.** Adzuna also varies key order between responses, but `payload` is a
`jsonb` column and Postgres normalises key order — verified 2026-08-09, `md5` of both orderings is
equal. Only genuinely different *values* matter.

## "But invariant 1 says store payloads exactly as received"

It does, and stripping is not a violation of it. Under D-011 the **git repository is the raw store**
and the immutable record: `raw/<source>/<country>/<date>.json` keeps every field exactly as it
arrived, `adref` included, forever. Postgres is a *rebuildable cache* derived from those files.

So the untouched original always exists, and the stripping happens on the way into the cache — which
is precisely the kind of thing a recomputable derivation is allowed to do. If a future need for
`adref` appears, it is already on disk and the cache can be rebuilt to include it.

Invariant 1 protects the archive. It does not require the cache to be a byte-for-byte copy of it.

## Adding an adapter

1. Capture a real response into `adapters/fixtures/<source>.json` and commit it. This freezes the
   upstream shape, so a renamed field arrives as a reviewable diff rather than as silence.
2. Write the adapter. Declare any volatile fields in an exported `VOLATILE` array, with a comment
   saying **what makes each one volatile** — a future reader must be able to tell a deliberate strip
   from an accidental data loss.
3. `npm run verify:adapters`. If the source ever returns the same `source_ref` twice with different
   payloads, the volatile-field assertion fails and names the offending refs.
4. If you strip a field, **include the duplicate pair in the fixture**, as `adzuna-nz.json` does. A
   rule with no failing case is a rule nobody has proven works.
