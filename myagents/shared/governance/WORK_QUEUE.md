# WORK_QUEUE

> Shared team queue

## Intake Sources

- pain signals
- runtime anomalies
- user feedback
- resource scout reports
- product proposals
- verification failures

## Queue Rules

- Every entry should be converted into one of the four standard artifacts.
- `main` decides routing.
- `pm` evaluates product-facing ambiguity or tradeoffs.
- `resource-scout` owns evidence collection.
- `repair` only starts once a Repair Task exists.
- `verification` runs after a repair attempt or when explicit verification is requested.

## Current Queue Types

- candidate issue
- candidate proposal
- repair candidate
- verification pending
- escalation needed
