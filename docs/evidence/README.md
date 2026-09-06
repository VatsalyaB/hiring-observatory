# Interactive evidence layer

This static dashboard reads only `data/pilot.json`, a validated aggregate release. It has no build
step, external dependency, tracker, production schedule, or access to private evidence.

Serve the public repository root with any static HTTP server and open `docs/evidence/`. Filters
change only precomputed aggregate cells. The release's `trend_gate` is authoritative; browser state
cannot unlock an ineligible comparison.

Reviewer feedback is optional and disabled by default in feedback-config.mjs. It uses only a
Supabase URL and publishable key when enabled; no service key, OAuth secret, moderator login list,
private feedback fields, or provider token belongs in this public tree. See docs/FEEDBACK-SETUP.md
and docs/FEEDBACK-SMOKE.md before enabling it.
