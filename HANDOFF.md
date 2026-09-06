# HANDOFF — public repository

## Role

This repository is the public code and methodology surface for Hiring Observatory. Production
collection, row-level source data, manifests, credentials, backups, operational incidents, and the
runtime handoff remain in a separate private repository and are not mirrored here.

## Current state

- The repository was bootstrapped from an explicit allowlist with a fresh, private-history-free Git root.
- Public fixtures are synthetic and machine-marked; no captured advert row is included.
- CI requires no production secrets; its first public run passed independent `verify` and `lint` checks.
- `main` requires pull requests, both checks, conversation resolution and admin enforcement; force
  pushes and deletion are disabled.
- Releases from the private source of truth are manual milestone exports. Automatic mirroring is
  deliberately deferred.
- The private runtime's immutable v2 cohort completed a natural scheduled capture on 2026-08-15 at
  45/45 with zero failed or missing members across the three supported ATS providers. This is an
  operational coverage attestation, not a public aggregate release; no private run identifier,
  manifest, listing row, employer-linked vacancy fact or scratch artifact crossed the boundary.
- The public ATS pilot release remains `ats-panel-pilot-2026-08-13`: 3 qualified employers across 3
  supported providers, 3/3 complete capture units, 469 observable vacancies and 100% one-day pilot
  coverage. Employer identities and row-level data are absent.
- `docs/evidence/` is an interactive static view over that aggregate only. Its trend gate is closed
  with reason `pilot_period`; UI state cannot override it.
- The first natural scheduled collection after the Phase 2 merge completed successfully on
  2026-08-13. Its operational evidence and row-level captures remain private; this public tree
  continues to contain only synthetic fixtures, code, methodology and the aggregate pilot release.

## Evidence boundaries

Versioned narrow queries are complete only within their published definitions. The fixed ATS
employer panel is a bounded, versioned cohort; the current public artifact is a 3-employer pilot,
while the accepted 45-employer operational cohort has not been published as an aggregate. Neither
supports representative or longitudinal claims. Broad discovery data is a capped ranked sample and
cannot support market-share, churn, closure, or lifespan claims. Q4 trends remain time-locked until
2027-01-01 and require two compatible complete periods.

## Next public milestone

Freeze infrastructure expansion. Build and lock the 100-listing role-classification evaluation,
then publish a privacy-safe baseline only if inclusion precision reaches at least 90% and recall at
least 80%. The private 45/45 operational milestone does not authorize publication of its scratch
aggregate. Approval-gated export automation remains deferred until the baseline release process has
proved useful.
