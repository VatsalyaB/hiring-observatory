# ATS complete-board adapter contract

Each adapter exports `collectBoard({ employer, fetchPage, qualification })` and returns one closed
provider-neutral envelope:

```js
{
  provider,       // greenhouse | ashby | smartrecruiters
  board_id,       // exact registry binding
  complete,       // always true for a returned envelope
  valid_zero,     // true only for a previously qualified employer
  reported_total, // non-negative integer
  vacancy_ids,    // unique stable upstream IDs in response order
  pages            // unmodified parsed upstream response pages
}
```

`fetchPage(url)` returns `{ url, status, body }`, where `url` is the final response URL and `body`
is the upstream response text. The adapter rejects redirects away from the exact requested URL,
non-2xx status, malformed JSON, schema drift, unstable/duplicate vacancy identity, and incomplete
pagination with a controlled code. Errors never contain upstream response text.

Greenhouse and Ashby each expose one complete public board response. SmartRecruiters uses sequential
`limit`/`offset` requests and succeeds only when a stable `totalFound` is exhausted exactly. No
adapter filters by title, description, location, or role family before returning `pages`.

A zero-job response is valid only when `qualification` is false and the registry row is already
`qualified`. Qualification always requires a complete non-empty response.
