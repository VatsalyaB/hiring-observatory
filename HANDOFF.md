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
- The public ATS pilot release is `ats-panel-pilot-2026-08-13`: 3 qualified employers across 3
  supported providers, 3/3 complete capture units, 469 observable vacancies and 100% one-day pilot
  coverage. Employer identities and row-level data are absent.
- `docs/evidence/` is an interactive static view over that aggregate only. Its trend gate is closed
  with reason `pilot_period`; UI state cannot override it.

## Evidence boundaries

Versioned narrow queries are complete only within their published definitions. The fixed ATS
employer panel is a bounded, versioned cohort; the current 3-employer pilot is below its 30–50 target
and is not representative or longitudinal evidence. Broad discovery data is a capped ranked sample
and cannot support market-share, churn, closure, or lifespan claims. Q4 trends remain time-locked
until 2027-01-01 and require two compatible complete periods.

## Next public milestone

Expand the qualified cohort toward 30–50 without mutating the published cohort version, collect the
complete 2026 Q4 measurement period, and publish comparisons only after the release validator's
compatibility, completeness and time gates all pass.
