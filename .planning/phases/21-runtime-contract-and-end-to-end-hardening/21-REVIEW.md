# Phase 21 Review Notes

## What Good Looks Like

- runtime contract is based on explicit behavior, not JavaScript implementation details
- bounded session selection is centralized and test-backed
- background and manual nocturnal paths use the same boundary rules
- the milestone ends with at least one strong E2E test layer over the main production path

## Common Failure Modes To Reject

- replacing constructor-name checks with a different brittle heuristic
- adding timestamp filtering in one caller while leaving other selection paths unbounded
- declaring success because unit tests pass while pipeline-level drift remains untested
- preserving "best effort" fallback to a newer unrelated session when bounded selection fails
