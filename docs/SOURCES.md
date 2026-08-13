# Source registry

Every data source, its class, its coverage, and — critically — whether it has actually been
confirmed to work.

## Verification status has a strict meaning

| Status | Meaning |
|---|---|
| **VERIFIED** | **Called the endpoint and got real data back.** Date recorded. |
| **DOCS-VERIFIED** | Read the official documentation and confirmed it exists and describes the shape — but *the endpoint has not been called*. Weaker than VERIFIED. Docs go stale, endpoints get deprecated, auth requirements change. |
| **UNVERIFIED** | Plausible or widely referenced, but *not confirmed by us at all*. May not exist as described. |
| **FAILED** | Tried, did not work. Kept deliberately so nobody re-tries it blindly. |

The VERIFIED / DOCS-VERIFIED distinction exists because it was got wrong immediately. The first
draft of this file marked four ATS sources as VERIFIED when only their documentation pages had
been read. That is exactly the error this file is meant to prevent, so the status was split
rather than the entries quietly corrected.

**Do not promote a source to VERIFIED without calling it.** A plausible-sounding API that turns
out not to exist is how a weekend gets destroyed. Milestones may not depend on UNVERIFIED sources
without flagging the dependency explicitly.

**Re-run the evidence:** `node scripts/probe-sources.mjs`. Keyless, read-only, one request at a
time. It requires a **non-empty record set plus a sample field** before it will report VERIFIED —
HTTP 200 is not the bar, because `api.lever.co` answers 200 with a two-byte `[]` and that is an
endpoint working, not a source verified.

**A 404 from a guessed slug is not evidence against a source.** Several Class B endpoints are
`https://…/{company}/…`, so a wrong company name produces a 404 that says nothing about the API.
Those entries are recorded as inconclusive with the reason stated, never as FAILED — marking a
working source dead is the same class of error as marking an unread one VERIFIED, just inverted.

---

## Why diversity is an architectural requirement, not a nice-to-have

A single-source observatory is one terms-of-service change away from dead, and its findings are
indistinguishable from that source's own market share. The mix below is deliberately spread
across five classes with different failure modes:

- **Aggregators** give breadth and salary data, but are the most fragile — commercial terms and
  rate limits change without notice.
- **ATS boards** give first-party full job-ad text, are effectively permanent, and are
  country-agnostic — but only cover employers who use those systems, skewing modern and larger.
- **Official statistics** give ground truth. They are slow and coarse, but they let you say "our
  sample says X, the official index says Y, here is the gap" — which is what separates research
  from scraping.
- **Ecosystem signals** are leading indicators. What appears in code and community activity tends
  to precede what appears in job ads.
- **Compensation sources** are the hardest and the most valuable, because salary disclosure norms
  vary enormously by country.

If any one class went dark tomorrow, the project survives. That is the test.

---

## Active source roles after Phase 1

- **Narrow NZ query census:** complete only within the ten published `nz-ai-data-v1` queries and
  the source's observable results at capture time. It does not represent all NZ vacancies or a
  national market share. The first complete partition is 2026-08-11 UTC (2026-08-12 NZST); one
  live attempt used 16 pages, and that date starts the 30-day baseline clock.
- **Broad Adzuna window:** a capped ranked discovery sample pending the Phase 3 fail-closed fence.
  It may support sample-composition and discovery work, but not market churn, closure, lifespan,
  total-vacancy or market-share claims.
- **ATS employer panel:** the next implementation plan and the longitudinal backbone. It will use a
  named, fixed-quarter employer cohort and complete supported-board captures, with claims bounded
  to that cohort.

---

## Class A — Aggregator APIs (breadth, multi-country)

| Source | Status | Coverage | Notes |
|---|---|---|---|
| **Adzuna** | **VERIFIED 2026-08-09** | **nz, au, sg all confirmed by keyed call** | **Q2 CLOSED.** Keyed call to `/v1/api/jobs/{country}/search/1?what=data+engineer` returned live ads for **nz (145), au (1,984), sg (2,391)**, with **gb (7,556) as a control**. Counts are for that one query, not total market size. **Singapore was the genuinely open half of Q2** — the consumer site returned 405 and proved nothing — and it is covered, so v3 is unblocked. Country is a path segment, so adding a market really is a config row, exactly as invariant 4 requires. Original notes retained below. |
| ~~Adzuna (pre-verification note)~~ | superseded 2026-08-09 | Multi-country | Country is a **path segment**: `/v1/api/jobs/{country}/search/{page}`. Returns `salary_min`/`salary_max`, `salary_is_predicted`, `category`, `company`, `location.area[]`, `contract_type`, `created`. Needs free `app_id` + `app_key`. **Country coverage, checked 2026-08-08:** `adzuna.co.nz` is a live market advertising 15,000+ NZ jobs and `adzuna.com.au` also operates, so `nz` and `au` are near-certain country codes (inferring the code from the domain, as `adzuna.co.uk` → `gb`). `adzuna.sg` returned HTTP 405 — host exists, request rejected — so **Singapore is inconclusive**. An operating consumer site strongly implies API coverage but does not prove it: confirm with a real keyed call at M2. |
| **Arbeitnow** | VERIFIED 2026-08-08 | Global, EU-heavy | Live JSON, no auth, real listings with full descriptions. Useful immediately. |
| **Remotive** | VERIFIED 2026-08-08 · **notice READ 2026-08-09 · `publishable = false` (D-016)** | Remote/global | **The notice was finally opened and it is substantive.** In summary, not quoted: attribution and a link back to Remotive are *required* of anyone using the data; jobs must not be submitted onward to third-party job sites (Jooble, Neuvoo, Google Jobs and LinkedIn are named); using listings to harvest signups or email addresses is called a breach; data is deliberately delayed 24 hours; roughly four calls a day is the advised ceiling and excessive requests get blocked; non-compliance is met with termination of access; and a paid private API exists with a five-figure monthly starting budget. **Assessment:** collection is plainly within what they grant, and we do not redistribute listings — invariant 3 means only aggregates ever leave. But the notice is written for job-board *display*, and says nothing about derived statistics, so publishing aggregates from it sits in genuine ambiguity rather than clear permission. Set `publishable = false` until that is resolved deliberately — the same posture as the Seek tier, and it costs nothing today because nothing publishes until M6/M7. **Deliberately not yet in `config/sources.json`.** |
| Careerjet | UNVERIFIED | Many incl. NZ/AU/SG/JP | Affiliate API. Verify terms carefully. |
| Jooble | UNVERIFIED | Many countries | Public API, per-country keys. |
| JSearch (RapidAPI) | UNVERIFIED | Global via Google Jobs | Paid but cheap. Would be the broadest single addition. |
| **The Muse** | VERIFIED 2026-08-09 | US-heavy | Free, **keyless**. `www.themuse.com/api/public/jobs?page=1` returned 20 live postings. Low priority for APAC, but it is the only Class A source needing no key at all, which makes it useful as a pipeline smoke test that costs nothing. |

## Class B — ATS public boards (depth, first-party text, country-agnostic)

These are the backbone. Same adapter works for a Singapore employer as a New Zealand one — only
the employer registry changes. That property is what makes geographic expansion cheap.

| Source | Status | Notes |
|---|---|---|
| **Greenhouse** | **VERIFIED 2026-08-09** | `boards-api.greenhouse.io/v1/boards/{board}/jobs` — keyless, **188 live postings** returned. Confirms the class thesis: one adapter, employer registry is the only per-country variable. |
| **Lever** | DOCS-VERIFIED 2026-08-08 | **Endpoint confirmed reachable 2026-08-09, but NOT promoted.** `api.lever.co/v0/postings/{company}?mode=json` returns HTTP 200 and valid JSON, but all five company slugs tried returned `[]`. The slugs were guesses, so this is **a failure of my input, not evidence against Lever** — the API shape is right and the endpoint answers. Needs one known-good slug to promote. Do not mark FAILED. |
| **Ashby** | **VERIFIED 2026-08-09** | `api.ashbyhq.com/posting-api/job-board/{name}` — keyless, **58 live postings** returned. |
| **SmartRecruiters** | **VERIFIED 2026-08-09** | `api.smartrecruiters.com/v1/companies/{company}/postings` — keyless, **8 live postings** returned. |
| Workable | UNVERIFIED | `apply.workable.com/api/v1/widget/accounts/{account}?details=true` returned **404 on 2026-08-09**, but the account slug was a guess, so this is not evidence the API is absent. Re-probe with a known Workable employer before drawing any conclusion. |
| Recruitee | UNVERIFIED | `{company}.recruitee.com/api/offers/` returned **404 on 2026-08-09** for two guessed slugs. Same caveat as Workable — inconclusive, not negative. |
| Teamtailor | UNVERIFIED | Common in Nordics/APAC. |
| Personio | UNVERIFIED | EU-heavy. |
| JazzHR / Breezy | UNVERIFIED | Smaller employers. |
| Workday | UNVERIFIED | Large enterprises. Harder — CXS endpoints, less friendly. High value if cracked, since it covers the big banks and insurers. |

Phase 2 exact-board re-verification on 2026-08-13 produced at least one complete, non-empty,
recent-NZ-evidence board on each of Greenhouse, Ashby and SmartRecruiters. The named registry,
provider response fixtures and per-board counts remain private; public releases expose only cohort
and provider aggregates.

## Class C — Official statistics (ground truth and calibration)

The credibility layer. Cheap to add, disproportionate payoff — being able to benchmark your
sample against an official index is the difference between "some job ads I collected" and
"a calibrated sample with a stated methodology".

| Source | Status | Country | Notes |
|---|---|---|---|
| MBIE Jobs Online | UNVERIFIED | NZ | Monthly online vacancy index. |
| Stats NZ | UNVERIFIED | NZ | Labour market series. |
| Jobs and Skills Australia — Internet Vacancy Index | UNVERIFIED | AU | Page exists; fetch failed on a converter bug, not a 404. Monthly, occupation × region, free. Strongest single calibration source for AU. |
| data.gov.sg / MyCareersFuture | UNVERIFIED | SG | `api-open.data.gov.sg/v1/public/api/datasets` returned **HTTP 403 on 2026-08-09** — the host answered and refused, which is a different signal from a 404 and suggests a header, path or registration requirement rather than absence. Inconclusive. MyCareersFuture is government-run; check for an API separately. |
| Singapore Ministry of Manpower | UNVERIFIED | SG | Labour statistics. |
| e-Stat / MHLW | UNVERIFIED | JP | Japanese-language. Deferred with the rest of Japan. |
| OECD / ILO | UNVERIFIED | Cross-country | For normalising between countries. |

## Class D — Ecosystem signals (leading indicators)

The genuinely differentiating layer, and the cheapest. Nobody else building a job-ads dashboard
bothers with this, and it enables the most interesting question the dataset can ask: **does
adoption in code lead demand in job ads, and by how long?** That is a real research finding, not
a chart.

| Source | Status | Notes |
|---|---|---|
| **GitHub API** | **VERIFIED 2026-08-09** | Keyless call returned results. Unauthenticated limit is 60 req/hr, which is ample at twice-daily cadence and needs no key — so it stays inside D-014. |
| **Hacker News "Who's Hiring" via Algolia** | **VERIFIED 2026-08-09** | `hn.algolia.com/api/v1/search` — keyless, returned matching stories including a live "Who is hiring" thread. The earlier "fetch returned nothing" was the **JS-rendered docs page**, not the API; calling the API directly resolved it, which is exactly why DOCS-VERIFIED is a weaker status than VERIFIED. |
| **Stack Exchange API** | **VERIFIED 2026-08-09** | Keyless call returned popular tags. Tag trends over time. |
| **npm registry / PyPI** | **VERIFIED 2026-08-09** | Both keyless and both returned data (`typescript` weekly downloads; `pandas` metadata). Download stats as tool-adoption ground truth. |
| Meetup | UNVERIFIED | Ecosystem activity by city. Useful for the APAC expansion narrative. |

## Class E — Compensation

Hardest class. Salary disclosure norms vary sharply: NZ and AU increasingly disclose, Singapore
rarely does. Any cross-country pay comparison must handle wildly different disclosure rates or it
will produce confidently wrong numbers.

| Source | Status | Notes |
|---|---|---|
| Salary in ad text | — | Extracted by the LLM layer. Coverage varies by country; track disclosure rate as a metric in its own right, it is an interesting finding. |
| Adzuna salary fields | **VERIFIED 2026-08-09 · earlier estimate CORRECTED the same day** | **First measurement (superseded):** 20 ads per country on `what=data engineer` gave nz 4/20, au 2/20, sg 2/20, gb 20/20 with 8 predicted — from which "roughly 10–20% disclosure across ANZ/SG" was concluded. **That conclusion was wrong for Singapore.** Re-measured on `category=it-jobs`, 100 ads per country: **nz 8/100 (8%), au 9/100 (9%), sg 73/100 (73%), none predicted.** The first sample was small and drawn from a different, narrower population; the generalisation outran it. Singapore discloses pay far *more* than NZ or AU, which **inverts the spec's stated assumption** that SG rarely discloses. (The GB finding stands: Adzuna predicts for GB and not for ANZ/SG, so GB completeness is partly synthetic.) **AND THE VALUES ARE NOT COMPARABLE — see the period gap below.** |
| Adzuna salary **period/currency** | **GAP FOUND 2026-08-09 — blocks any cross-market pay figure** | The salary fields carry **no currency and no pay period**. Observed medians: nz 140,000, au 80,000, **sg 1,440**. Read naively that is Singapore paying ~1% of New Zealand; it is a units artefact, because SG advertisements commonly quote **monthly** while NZ/AU quote annual. Periods are mixed *within* a market too — SG ranges 144 to 184,780 — and there are outright junk values (nz `salary_min=5`, au `180`). **Invariant 6 does not cover this:** it mandates original amount + original currency + conversion, and says nothing about period. Currency can be inferred from the `countries` config; **period cannot, and must be inferred per-advertisement before any salary is normalised.** Treat this as a prerequisite of M4, not a refinement. |
| Stack Overflow Developer Survey | UNVERIFIED | Annual, free, country-level comp. |
| levels.fyi / Glassdoor | — | No usable public API. Do not scrape. |

## Private tier — not for publication

| Source | Status | Notes |
|---|---|---|
| Seek (GraphQL adapter, owner-built) | Owner-held | Writes to the `private` schema only. Never published, never joined into anything publishable, never crosses to Supabase. See D-002 and invariant 2 in `CLAUDE.md`. |

---

## Expansion sequence

| Phase | Region | Marginal cost |
|---|---|---|
| v1 | New Zealand | Baseline. |
| v2 | Australia | Near-zero — same Adzuna adapter with a different country code, shared ANZSCO occupation taxonomy, and the IVI as calibration. Largest coverage gain per unit of effort of any expansion step. |
| v3 | Singapore | Low. English-language, Adzuna coverage to be confirmed, ATS boards work unchanged. Needs an ISCO-08 crosswalk since ANZSCO does not apply. |
| v4 | Japan | Real cost. Japanese-language ads need a translation step ahead of extraction, and the ATS mix differs substantially. Genuinely future work — do not let it influence v1 design beyond keeping language a field rather than an assumption. |

## Rules for adding a source

1. Verify it by calling it. Record the date in this file.
2. Write an adapter conforming to the common contract — `(config, since_cursor) → RawRecord[]`.
   No source-specific logic escapes the adapter.
3. Add a row to the `sources` config table. Do not add code branches per source elsewhere.
4. Add a staleness alarm. A source that stops returning data must alarm within 48 hours.
5. Record its terms-of-service posture here. If publication rights are unclear, it goes to the
   private tier until they are clear.
