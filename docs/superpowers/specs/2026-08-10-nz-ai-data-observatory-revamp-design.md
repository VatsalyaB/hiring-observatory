# NZ AI/Data Observatory Revamp — Design

**Date:** 2026-08-10
**Status:** Approved; Phase 1 integrated and remotely verified 2026-08-12; Phase 2 next
**Owner and primary user:** Vatsalya Baranwal, a New Zealand-based AI/data professional
**Supersedes:** Broad market and churn claims in `docs/specs/2026-08-08-hiring-observatory-design.md`
**Preserves:** All `CLAUDE.md` invariants, existing raw bytes, and the M1 unattended-scheduler gate

## 1. Decision

Continue as a transparent longitudinal study of AI/data opportunities available to NZ-based
professionals. Stop implying that a capped aggregator result window represents the NZ or APAC
labour market.

Implement three source treatments in order:

1. Fully paginate a versioned set of narrow NZ AI/data searches so each search is complete within
   its published definition.
2. Build a named, fixed-quarter employer panel from complete ATS feeds and use it as the
   longitudinal backbone.
3. Retain broad Adzuna `it-jobs` capture as a ranked discovery sample, with a hard prohibition on
   market-churn, closure and lifespan claims.

The scheduler, immutable raw store, provenance, adapters, wall and falsifiable guards remain. The
research contract, source roles and publication gates change.

## 2. Primary user and decision

The owner is the primary user. The observatory helps him assess observable talent demand, choose
capabilities to learn, identify existing capabilities needing stronger public proof, and select
portfolio projects that demonstrate realistic capability bundles. Other NZ AI/data professionals
are the secondary public audience.

The v1 research question is:

> Among AI and data roles available to NZ-based professionals, what capabilities are employers
> asking for, and which changes are strong enough to influence what I learn or demonstrate in my
> portfolio?

## 3. Scope

### Included role families

- Data analysis and business intelligence
- Analytics engineering
- Data engineering and data architecture
- Data science
- Machine-learning and AI engineering
- MLOps
- AI/data leadership

A role qualifies only when AI/data work is central. Generic software, cloud, cybersecurity,
infrastructure and IT-management roles are excluded unless their advertised responsibilities make
AI/data central.

### Geographic eligibility

A role qualifies when it is NZ-located or explicitly open to applicants working remotely from New
Zealand. Employer headquarters do not matter. Globally remote does not imply NZ eligibility;
positive evidence is required.

### Deferred scope

- AU and SG wait until NZ v1 passes the gates in section 16.
- Salary comparisons wait for reliable currency, pay period, disclosure and prediction status.
- Job ads do not support causal claims about technology adoption or economic conditions.
- Commercial positioning waits for source permission and customer evidence.

## 4. Claim contract

Every result names the population it observes.

| Source product | Permitted claim | Prohibited claim |
|---|---|---|
| Narrow Adzuna query census | Complete observable results for the published NZ query set at capture time | All NZ vacancies or representative market share |
| ATS employer panel | Complete observable board vacancies for the fixed supported-employer cohort | All NZ employers or a representative national sample |
| Broad Adzuna IT window | Composition of the capped ranked sample | Closure, lifespan, market churn, total market count or share |
| MBIE comparison | Compatible macro context | Tool-level validation MBIE cannot observe |
| Arbeitnow | Global experimental context | Any NZ conclusion |

The query census is bounded by wording, Adzuna coverage and search behaviour. The ATS panel is
bounded by supported platforms, sectors and employer selection. These are study populations, not
hidden approximations of the entire market.

## 5. Architecture

Use a hybrid census plus employer panel:

- Narrow queries provide immediate breadth.
- ATS feeds provide stable employers, fuller descriptions and longitudinal validity.
- The broad window discovers employers, titles and query vocabulary.
- MBIE supplies macro context.

ATS-only was rejected because it omits unsupported recruitment systems and delays value.
Adzuna-only was rejected because snippets, source dependence and revocable access cannot form the
permanent backbone.

## 6. Versioned NZ query census

### Initial query set

The committed version `nz-ai-data-v1` contains:

| Query ID | Query text |
|---|---|
| `data-analyst` | `data analyst` |
| `business-intelligence` | `business intelligence` |
| `analytics-engineer` | `analytics engineer` |
| `data-engineer` | `data engineer` |
| `data-architect` | `data architect` |
| `data-scientist` | `data scientist` |
| `machine-learning-engineer` | `machine learning engineer` |
| `artificial-intelligence` | `artificial intelligence` |
| `mlops` | `mlops` |
| `data-leadership` | `head of data` |

The 2026-08-10 probe reported 475 results before overlap removal and about 15 page calls at 50
results per page. This proves current feasibility, not a permanent count. The narrow census has a
hard ceiling of 60 Adzuna page requests per UTC day, cumulative across both scheduled attempts; the
second attempt reads that day's committed run manifests before spending the remainder. At the
current six broad-window requests per day, that leaves the regular collector below Adzuna's default
2,500-request monthly allowance even if the narrow ceiling is reached every day. Crossing the
ceiling fails the unfinished query rather than silently truncating it.

Query sets are append-only versions. Wording does not change in place or within a quarter. Broad
window and ATS discoveries feed a monthly query-recall review; omissions enter the next version.

### Raw layout and provenance

Each query has an independent write-once partition:

```text
raw/adzuna-query/nz/<query-id>/<YYYY-MM-DD>.json
```

It records source, country, query ID and text, query-set version, fetch time, workflow provenance,
first reported total, pages fetched, page size, termination condition, count and raw records.
Overlapping adverts remain duplicated in raw query files. Normalisation deduplicates by Adzuna ID
while preserving every query membership.

### Completion rule

Pagination uses temporary storage. A final partition is created only when every page succeeds,
shape and identifiers pass validation, pagination reaches a short or empty terminal page, and the
request budget remains available. A failed query writes no final partition. Other queries commit,
and the second scheduled attempt may retry the missing query. Missing is never converted to zero.

## 7. Quarterly ATS employer panel

### Registry and cohort

The employer registry records canonical ID and name, sector, ATS provider and board ID,
verification evidence, NZ-eligibility evidence, status (`core`, `watchlist`, `retired`) and cohort
dates. An immutable file such as `config/cohorts/2026-Q3.json` freezes the measured cohort.

Discoveries enter the watchlist immediately but enter metrics only at the next quarter boundary.
Retirements also occur at a boundary with a retained reason.

The pilot targets 30–50 verified employers across government, finance, consulting, technology,
utilities, retail/logistics and research. It is explicitly a supported-ATS cohort.

Core admission requires a verified complete endpoint, canonical employer identity, evidence of a
NZ-located or explicitly NZ-eligible role in the preceding 90 days, sector/provider metadata and a
successful real fixture capture.

### Providers and raw layout

Greenhouse, Ashby and SmartRecruiters are endpoint-verified. Lever enters after a known-good board
returns real data. Each provider has one pure adapter; employers are config rows.

```text
raw/<ats-provider>/_global/<employer-id>/<YYYY-MM-DD>.json
```

Store the complete board response before NZ or role filtering. A schema-conforming empty board is a
successful `count: 0` observation. Timeout, HTTP failure, malformed payload or shape-breaking empty
response writes no partition.

## 8. Broad-window fence

Existing `raw/adzuna/<country>/<date>.json` files remain byte-identical. Future broad captures gain
`coverage_mode: ranked_window` in metadata or source config during loading.

The reporting layer must fail closed if ranked-window data is used to compute closure, lifespan,
market churn, complete vacancy count or market share. The window remains useful for discovering
candidate employers, titles, query gaps and sample composition.

## 9. Daily flow and failure isolation

```text
GitHub Actions schedule
  -> broad ranked-window capture
  -> complete narrow query captures
  -> fixed ATS cohort captures
  -> isolated validation
  -> immutable raw partitions
  -> sanitised run manifest
  -> one git commit
  -> load, classify, evaluate and aggregate
  -> private decision brief + public aggregates
```

The canary remains an independent scheduler control. Ingest work is sequential and commits once to
reduce push races.

The run manifest records expected units, complete captures, valid zeros, skips, failures and
controlled error codes. It contains no bodies, credential-bearing URLs or source excerpts. It is
committed even when every fetch fails; the workflow then exits red.

## 10. Classification

Raw remains immutable. Downstream records retain source, source reference, payload hash, capture
date, query membership, cohort version and classifier version.

The deterministic v1 classifier assigns in-scope/excluded, role family, NZ eligibility basis,
seniority where supported, controlled capabilities and bundles, confidence and provenance. Adzuna
snippets and ATS full descriptions remain distinct evidence classes. Missing text is reported, not
interpreted as capability absence.

Classifier versions are append-only. Reprocessing writes new results and never overwrites old ones.

## 11. Insight engine

Every conclusion passes four levels:

1. **Observation:** what appeared.
2. **Comparison:** whether it remains within comparable roles, employers and complete periods.
3. **Inference:** how broadly and reliably the evidence supports it.
4. **Action:** demonstrate, learn, watch or deprioritise.

For each capability and role family, report vacancy frequency, employer breadth, persistence,
momentum, employer concentration, seniority relevance, missingness and cross-source agreement.
Both listing-weighted and employer-weighted views are required. Employer breadth is primary so one
large recruiter cannot masquerade as broad demand.

Overall movement is decomposed by role family. A raw rise caused only by a larger share of
data-engineering jobs is labelled `composition-driven`, not a within-role demand increase. Trend
language requires identical query-set and cohort versions and complete compared periods.

Evidence labels:

- **Strong:** at least four complete weekly periods, five employers, and support from ATS plus the
  query census.
- **Moderate:** at least three employers but one primary source or less than four complete weeks.
- **Early signal:** one or two employers, newly observed or concentrated.
- **Insufficient:** incomplete data, incompatible versions, failed classifier gate or low support.

Counts remain visible when percentages are suppressed. No label implies causality or generalisation
beyond the observed population.

Recurring capability bundles—such as Python + SQL + cloud warehouse, dbt + orchestration + data
quality, or GenAI API + retrieval + evaluation + governance—inform end-to-end portfolio projects.
They remain empirical combinations with denominators, not an invented curriculum.

## 12. Portfolio action model

The real profile lives at `.local/portfolio-profile.json` and is gitignored; a committed example
defines its schema. For each capability it records current ability, public-evidence strength,
learning interest and practical constraints.

| Demand evidence | Portfolio evidence | Action |
|---|---|---|
| Broad and persistent | Weak proof | Demonstrate next |
| Broad and persistent | Missing | Learn next |
| Growing across employers | Present | Make more visible |
| Early or concentrated | Missing | Watch before investing |
| Weak and low-priority | High learning cost | Deprioritise |

Recommendations expose population, role families, employer breadth, evidence label, missingness
and a suggested demonstration archetype. Evidence and interpretation are separate.

## 13. Outputs

The private actionable brief may include named employers, qualifying roles, listing references,
portfolio gaps, demonstration suggestions and watchlists. It stays private.

The public artifact contains only approved aggregates and manually curated methodology metadata:
claim contract, attribution, named cohort, coverage, missingness, concentration, aggregate findings,
capability bundles, evidence labels and limitations. Cohort names are publishable methodology
metadata because they are manually curated public employer identities; no vacancy fact, count or
excerpt attaches to an individual employer in the public artifact. It contains no row-level
listing, excerpt, private error detail or personal profile.

The 30-day publication clock starts when the first live Phase 1 narrow-query partition is committed.
Within those 30 days, publish methodology, named cohort and coverage, baseline role/capability
distributions, the private owner brief, and limitations/permission posture. The release is labelled
`baseline` and makes no trend claim.

## 14. Evaluation and user validation

Hand-label 100 representative listings across included/excluded roles, all role families,
ambiguous titles, location edge cases, Adzuna snippets and ATS full descriptions. Thirty form the
development subset; the other 70 are locked before classifier rules are written and evaluated only
after a classifier version is frozen. Each published role family needs at least eight positive
examples in the locked set; otherwise that family remains visible only as an unevaluated count.

Publication requires at least 90% inclusion precision and 80% recall. Skill extraction precision
and recall are separate. A role-family result is suppressed when labelled support cannot sustain an
honest quality statement. Results are append-only by classifier version.

Ten NZ-based AI/data professionals receive the baseline and a structured form. The usefulness gate
requires five completed responses, three respondents naming a concrete learning, portfolio or
job-search decision changed or confirmed, verbatim trust/usefulness objections, and a recorded
continue/revise/stop decision.

## 15. Permanent negative tests

Tests must prove detection of:

- pagination stopping before the terminal page;
- request-budget exhaustion;
- duplicate adverts across queries;
- query changes without a new version;
- ATS valid-zero versus malformed-empty;
- an employer entering metrics mid-quarter;
- globally remote roles without explicit NZ eligibility;
- generic IT leakage;
- missing periods becoming zeros;
- incomplete periods entering comparisons;
- ranked-window data entering churn or lifespan metrics;
- one employer creating a false broad-demand claim; and
- row-level source material entering public output.

Every guard is watched fail before trust, per `CLAUDE.md` rule 9. Unit tests use fixtures and
temporary directories; live endpoints are probes and acceptance checks, not unit dependencies.

## 16. Rollout and gates

1. **Preserve M1 proof.** Allow the unattended canary to fire; do not alter existing raw.
2. **Complete narrow capture.** Add query versions, full pagination, isolation, request budget and
   coverage. Prove simulations, then run one live capture.
3. **Build ATS panel.** Verify the pilot registry, freeze the cohort and begin daily complete-board
   capture.
4. **Fence broad window.** Classify it as ranked and make prohibited metrics fail closed.
5. **Classify and evaluate.** Build labels, deterministic classifier, vocabulary and bundles. Do
   not publish before evaluation passes.
6. **Ship and validate.** Publish baseline and private brief within 30 days; run the ten-person
   review.

Continue expansion only when the cohort is stable and measurable, classification passes, every
finding exposes denominator/completeness/missingness/concentration, the baseline ships in 30 days,
three users report a concrete decision, and commercial direction has permission plus customer
evidence. If the baseline misses 30 days, freeze infrastructure expansion until it ships.

## 17. Documentation and permissions

The original design remains historical evidence but receives a supersession notice for “a dataset
nobody else has,” broad market positioning, capped-window churn/lifespan, salary as v1, and immediate
AU/SG progression.

When implementation begins, update `HANDOFF.md`, `README.md`, `docs/SOURCES.md`,
`docs/DECISIONS.md` and the milestone plans with revised roles and order.

Adzuna attribution is mandatory. Personal research is the current posture. Commercial or
organisational use requires an explicit permission decision; continued API access is not treated as
permission.

## 18. Non-goals

- Represent all NZ employers or vacancies
- Publish row-level advertisements
- Infer that a disappeared aggregator result was filled or closed
- Make causal labour-market claims
- Build paid extraction before revenue
- Add countries or source classes before NZ v1 passes
- Build a complex dashboard before methodology and baseline are useful

## 19. Expected viability shift

If implemented and validated, this can become a defensible NZ research and portfolio artifact. It
does not become a commercial business automatically. Commercial viability remains a separate
hypothesis requiring permission, repeated user value and a buyer.
