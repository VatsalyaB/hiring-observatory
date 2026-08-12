# Authority contract

**Closes Q14.** Written 2026-08-09, before adapters exist, so "runs unattended" is a specification
rather than an aspiration.

## Why this file exists

The goal is a pipeline that runs for months without human intervention. The naive route to that is
to automate everything and hope. The route taken here is the opposite: **define the bounded zone
precisely enough that autonomy inside it is safe, and make everything outside it escalate.**

Autonomy is a delegation with limits, evidence and a revocation path — not an absence of oversight.
An operation is only autonomous here if all five questions below have an answer.

**Attribution.** The vocabulary — graduated autonomy, authority contracts, HADO, WORM evidence, the
failure-mode taxonomy — comes from a third-party agentic-AI governance framework (Gy+AI; authority
engineering and HADO credited there to Chris Greenham). It is applied here to this project's own
architecture. Nothing from that material is reproduced, and none of it belongs in Curiosum work.

## The five questions

Every authority decision in this project must state:

| | |
|---|---|
| **Scope** | Which outcomes, processes and systems? |
| **Limits** | What values, risks and conditions bound it? |
| **Decision rights** | What remains human-authorised? |
| **Evidence** | What must be logged and reviewable? |
| **Revocation** | How is the authority withdrawn, and by whom? |

## The autonomy ladder

| Level | Meaning | Human involvement |
|---|---|---|
| **ASSIST** | Advise only | Human decides and acts |
| **APPROVE** | Prepare | System prepares; human authorises |
| **DELEGATE** | Act within limits | System acts inside policy and value thresholds |
| **AUTONOMOUS** | Operate continuously | System acts, monitors and escalates inside a tightly bounded domain |

---

## Contract by operation

### AUTONOMOUS — runs unattended, no human in the loop

**Ingest from a source already marked VERIFIED**
- *Scope:* sources with `enabled = true` and `publishable = true` in `sources`.
- *Limits:* row count within a sane band of the trailing average; response validates against the
  adapter's schema; source still VERIFIED in `SOURCES.md`.
- *Decision rights:* none — fully delegated.
- *Evidence:* the run row in `ingest_runs`, the committed raw partition, `last_success_at`.
- *Revocation:* set `sources.enabled = false`, or disable the workflow in the Actions tab.

**Commit a raw partition**
- *Scope:* `raw/<source>/<country>/<YYYY-MM-DD>.json`.
- *Limits:* **write-once.** A second run on the same date must be a no-op, never a rewrite. This is
  not tidiness — git stores a fresh blob per changed file, so rewriting duplicates the dataset into
  history on every run.
- *Evidence:* git history *is* the evidence. Commit author, timestamp, diff.
- *Revocation:* disable the workflow. Committed history is deliberately not revocable — that is the
  point of an append-only store.

**Normalise and deduplicate**
- *Scope:* deriving `listings` from raw.
- *Limits:* deterministic and recomputable; must never write to `raw_listings`.
- *Evidence:* rebuildable — the check is that Postgres can be reconstructed from git alone.
- *Revocation:* not applicable; it is a pure function and can simply be re-run.

### DELEGATE — acts within limits, escalates outside them

**LLM extraction**
- *Scope:* listings with full text, using the current `extractor_version`.
- *Limits:* hard cost cap per run; low-confidence results escalate rather than guess; Haiku by
  default, escalating model only within the cap.
- *Decision rights:* exceeding the cap stops the run — it does not request more budget.
- *Evidence:* append-only rows in `extractions` stamped with `extractor_version` and `run_id`.
- *Revocation:* lower or zero the cap; disable the extraction step.

**Publish aggregates**
- *Scope:* derived aggregates only, never row-level listings, never raw text.
- *Limits:* refuses to publish if the wall test fails or any enabled source is stale.
- *Evidence:* the published artefact plus the commit that produced it.
- *Revocation:* revert the publishing commit; the private store is unaffected.

### APPROVE — prepared automatically, authorised by a human

**Promoting an extractor version**
- *Limits:* the eval regression gate must pass first. A regression is *refused*, not flagged — that
  is why extractions are versioned and append-only.
- *Decision rights:* **Vatsalya.** A machine may not decide that lower quality is acceptable.
- *Evidence:* precision/recall for both versions against the labelled set.

**Adding a new source**
- *Decision rights:* **Vatsalya.** Terms-of-service review is irreducibly a human judgement, and
  publication rights are the whole basis of D-002.
- *Evidence:* a dated entry in `SOURCES.md` with its verification status.

### ASSIST — never automated, under any circumstances

- **Changing the wall, roles or grants.** The wall is the control; a system that can rewrite its own
  constraints has none.
- **Deleting anything** — databases, history, raw partitions, backups.
- **Making the private repo public.** Irreversible, and it is the containment boundary for D-002.
- **Publishing raw third-party advert text.** Aggregates only.

---

## Failure modes and their controls

The eight-mode taxonomy, mapped to what actually exists here. Kept honest — the gaps are listed as
gaps.

| Failure mode | Control | Status |
|---|---|---|
| **Authority** — acts outside permission | `publisher` role, column-scoped grants, the permission wall | Built, proven falsifiable |
| **Evidence** — cannot reconstruct what happened | Git history as WORM store; `ingest_runs` correlation | Built |
| **Memory** — retains sensitive state | Invariant 8; error detail confined to `private.ingest_errors` | Built (D-012) |
| **Loop** — repeats, stalls or amplifies | Write-once partitions, `ON CONFLICT DO NOTHING`, workflow concurrency group | Built |
| **Coordination** — context lost at hand-off | `run_id` threaded raw → listings → extractions → aggregates | Built (D-013) |
| **Grounding** — stale or untrusted input | `SOURCES.md` VERIFIED discipline, `source_staleness` view | **Partial — nothing alarms yet (M2)** |
| **Tool** — wrong parameters | Country FK, adapter schema validation | **Partial — validation lands with adapters (M2)** |
| **Goal** — optimises the wrong thing | Hand-labelled eval set with precision/recall | **Absent until M5** |

Control objective, in order: **prevent, detect, contain, explain, recover.**

## Revocation — how to stop it

Documented as a control, not left to be improvised during an incident.

| Scope | Action | Effect |
|---|---|---|
| One source | `update sources set enabled = false where id = '…'` | That adapter stops; others continue |
| All ingestion | Disable the workflow in the Actions tab | Everything stops; history is untouched |
| Publishing only | Revert the publishing commit | Public artefacts roll back; private store unaffected |
| Everything, immediately | Revoke the repository's Actions write permission | Nothing can commit; hardest stop available |

**Nothing revokes committed history**, by design. Raw is immutable and the store is append-only —
recovery means adding a correcting record, never erasing one.

## Review

Revisit at each milestone boundary. An operation may only be promoted up the ladder when its limits,
evidence and revocation path are all in place — never because it has "been fine so far".
