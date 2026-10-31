---
'create-principles-disciple': patch
---

Stop the Console from writing a second response after one has already been
committed, and give the authenticated Owner E2E suite an assertion budget that
matches the server's own request budget.

A route that finishes after the request timeout now logs the timeout as the
first failure instead of masking it with `ERR_HTTP_HEADERS_SENT`; late writes
are dropped with a bounded warning. The late-error path keeps the original
status rather than replacing it. No Owner-visible copy or response contract
changes.
