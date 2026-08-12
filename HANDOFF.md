# HANDOFF — public repository

## Role

This repository is the public code and methodology surface for Hiring Observatory. Production
collection, row-level source data, manifests, credentials, backups, operational incidents, and the
runtime handoff remain in a separate private repository and are not mirrored here.

## Current state

- The repository was bootstrapped from a file-by-file allowlist with a fresh Git root.
- Public fixtures are synthetic and machine-marked; no captured advert row is included.
- CI requires no production secrets and reports independent `verify` and `lint` checks.
- `main` is intended to require pull requests, both checks, conversation resolution, and disabled
  force pushes and deletion.
- Releases from the private source of truth are manual milestone exports. Automatic mirroring is
  deliberately deferred.

## Evidence boundaries

Versioned narrow queries are complete only within their published definitions. The future fixed ATS
employer panel is a bounded cohort. Broad discovery data is a capped ranked sample and cannot support
market-share, churn, closure, or lifespan claims.

## Next public milestone

Publish the fixed ATS employer-panel implementation and methodology only after its private runtime
acceptance passes, using the same allowlist export and exhaustive tree/history verification.
