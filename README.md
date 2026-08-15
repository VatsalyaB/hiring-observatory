# Hiring Observatory

Hiring Observatory is a reproducible study of AI and data opportunities available to New
Zealand-based professionals. This public repository contains executable collectors, deterministic
transformation and verification code, database migrations, synthetic test fixtures, and the
methodology needed to interpret future aggregate releases.

The production runtime and collected dataset are held separately in a private repository. No raw
job advertisements, production manifests, credentials, database dumps, or scheduled production
collectors are published here.

## Evidence state

**Operational acceptance is not publication.** On 2026-08-15, the private runtime's immutable
45-employer v2 cohort completed a natural scheduled capture at 45/45 with zero failed or missing
members across the three supported ATS providers. This is a public-safe coverage attestation only:
no private run identifier, manifest, listing row, employer-linked vacancy fact, or v2 aggregate has
been copied here.

The [ATS employer-panel evidence instrument](docs/evidence/) remains a static, filterable view over
the separately approved 3-employer pilot release: 100% capture coverage for one complete pilot day
and 469 observable vacancies. It remains deliberately marked `pilot_only`. The operational 45/45
milestone closes cohort expansion; it does not convert this published pilot into a baseline or a
trend. The next product gate is the locked 100-listing classifier evaluation and a privacy-safe
baseline release.

## What the evidence can and cannot say

- A versioned narrow-query result is complete only within the published queries and the source's
  observable results at capture time. It is not a census of all vacancies.
- The fixed ATS employer panel is a named, versioned cohort. Its current public artifact is a small
  pilot; the accepted 45-employer operational cohort has not been published as an aggregate. Neither
  is a representative employer sample or longitudinal evidence.
- Broad discovery captures are capped ranked samples. They may describe the composition of the
  captured sample and help discover employers, titles, and query gaps.
- Broad samples do **not** support market share, market-wide churn, vacancy closure, or vacancy
  lifespan claims.

The first verified narrow capture covered all 10 `nz-ai-data-v1` queries: 478 query observations,
339 distinct advertisements, and 29.1% overlap. Those are aggregate completeness facts; the
underlying rows remain private.

## Verify locally

Requirements: Node.js 22+, Docker, and Docker Compose.

```bash
npm ci
cp .env.example .env
npm run up
npm run migrate
npm run verify:public
npm run verify:public-history
```

The committed fixtures are invented examples marked `fixture_kind: "synthetic"`. ATS adapter,
aggregate-release and interactive-dashboard tests run as part of `verify:public`. Collectors require
users to supply their own source credentials; CI uses no production secrets.

## Repository boundary

The public tree is generated from `config/public-export.json`, an explicit file-by-file allowlist.
`scripts/verify-public-export.mjs` proves that extra files, raw paths, production workflows,
traversal, duplicate destinations, unmarked fixtures, private ATS registry/cohort paths, unsafe
evidence JSON, and private-repository locators fail closed. The history verifier checks every
commit, including deleted paths, and requires one root commit.

Public updates are deliberate milestone releases. Automatic mirroring remains disabled until at
least two manual releases and a planted-raw negative test have demonstrated the boundary.

## Documentation

- `docs/superpowers/specs/2026-08-10-nz-ai-data-observatory-revamp-design.md` — canonical product and methodology design.
- `docs/SOURCES.md` — source verification status and limits.
- `docs/evidence/README.md` — dashboard data boundary and local viewing instructions.
- `docs/AUTHORITY.md` — decision rights and publication controls.
- `HANDOFF.md` — public repository state and next public milestone.
