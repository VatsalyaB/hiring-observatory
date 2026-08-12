// Arbeitnow adapter. See adapters/contract.md — pure function, no I/O.

// Nothing stripped. The 2026-08-09 capture returned 175 advertisements with 175 distinct slugs and
// no duplicate pair, so there is no evidence of a volatile field — and inventing one on suspicion
// would be deleting data for no reason.
//
// This is deliberately an EMPTY list rather than an absent one: if a future capture does produce the
// same slug with two different payloads, `verify-adapter.mjs` fails and names the ref, and this is
// where the fix goes.
export const VOLATILE = [];
export const REQUIRED_FIELDS = ['slug'];

export default function adapt(file) {
  return (file.records ?? []).map((record) => {
    const payload = { ...record };
    for (const field of VOLATILE) delete payload[field];

    return {
      // Arbeitnow's slug is its stable public identifier and appears in the advertisement URL.
      source_ref: record.slug,
      // Arbeitnow is not country-partitioned; `_global` comes from config/sources.json and is
      // deliberately not an ISO code, so it can never be joined against `countries` by accident.
      country_code: file.country,
      payload,
    };
  });
}
