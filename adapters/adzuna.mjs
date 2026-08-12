// Adzuna adapter. See adapters/contract.md — pure function, no I/O.

// Fields that change between requests for an UNCHANGED advertisement. Stripping them is what keeps
// the D-008 idempotency key meaningful; leaving them in turns every re-fetch into a fake edit.
//
//   adref — a per-request signed token (JWT-shaped, carries a fresh `s` claim each time). Proven
//           volatile by real data on 2026-08-09: Adzuna returned the same advertisement twice
//           inside one capture, identical in every field except this one. The source identifier is
//           deliberately omitted from public-safe code and documentation.
//
// NOT stripped, deliberately, so the distinction stays visible to whoever reads this next:
//   __CLASS__ — a serialiser artefact ("Adzuna::API::Response::Job"). Useless, but STABLE, so it
//               costs nothing and removing it would be tidying rather than correctness. Minimal
//               intervention: strip what breaks something, keep what merely offends.
export const VOLATILE = ['adref'];
export const REQUIRED_FIELDS = ['id'];

export default function adapt(file) {
  return (file.records ?? []).map((record) => {
    const payload = { ...record };
    for (const field of VOLATILE) delete payload[field];

    return {
      // Adzuna's own id. String, because it arrives as one and a numeric coercion would silently
      // lose precision on ids beyond 2^53.
      source_ref: String(record.id),
      country_code: file.country,
      payload,
    };
  });
}
