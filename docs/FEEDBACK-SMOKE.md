# Reviewer feedback hosted smoke checklist

Status: **complete - 11 of 11 hosted smoke checks passed.** Steps 1-11 ran against the non-production Supabase project below. Production enablement remains a separate reviewed decision.

Do not enable production feedback until every result below is recorded.

## Record before testing

| Date | Supabase project ref | Dashboard commit SHA | Ordinary login | Moderator login | Result |
|---|---|---|---|---|---|
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 1 PASS - anonymous read and sign-in gate |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 2 PASS - only Supabase-required read-only email scope; no repository, organization, or write scope |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 3 PASS - XSS-shaped text submitted pending |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 4 PASS - pending item absent anonymously |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 5 PASS - ordinary moderation request returned 403 |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 6 PASS - first decision returned 200; repeat returned 409 |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 7 PASS - exact inert text and login public; public-safe fields only |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 8 PASS - rejected item remained private |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 9 PASS - five accepted; sixth showed retry at 2026-09-06T08:06:23.485Z |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 10 PASS - dashboard remained usable offline; feedback showed the retryable unavailable state |
| 2026-09-06 | plhajzmjcfowupzhaoby | 22ecf31 | Jacket-Man-616 | redacted from public export | 11 PASS - browser storage contained no provider_token or provider_refresh_token key |

The five pending rate-limit smoke records were rejected after step 9.

## Checklist

1. As anonymous, confirm approved feedback is listed and submission is blocked by the sign-in prompt.
2. Start GitHub sign-in and confirm the consent page requests only the Supabase-required read-only email scope, with no repository, organization, or write scope.
3. As the ordinary reviewer, submit an XSS-shaped plain-text comment such as <img src=x onerror=alert(1)> to a valid claim and confirm it is pending.
4. As anonymous and in a second non-author browser session, confirm that pending item is not visible.
5. As the ordinary reviewer, call the moderation function and confirm it returns 403.
6. As the moderator, confirm the queue contains the item, approve it once, then repeat the decision and confirm 409.
7. As anonymous, confirm the exact inert comment text and GitHub login render publicly, with no private IDs or moderator note.
8. Submit a second item, reject it as moderator, and confirm it remains private.
9. From the moderator account, before it has submitted feedback, make five rapid valid submissions; confirm all succeed and the sixth returns PostgREST `message: rate limit exceeded` and `details: retry_at=<UTC timestamp>`. Confirm the browser shows that retry time. It must be the expiry of the earliest submission still inside the rolling 60-minute window.
10. Disable network access and confirm the evidence dashboard still works while feedback reports a retryable unavailable state.
11. Inspect browser storage: Supabase session tokens may exist, but no provider_token or provider_refresh_token key may exist.

For each step, append its pass/fail result, date, project ref, dashboard commit SHA, ordinary login, and moderator login to the record above. Treat any failure as a production-enable blocker.
