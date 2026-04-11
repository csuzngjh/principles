# Phase 20 Review Notes

## What Good Looks Like

- one canonical `.pain_flag` parser
- one canonical snapshot ingress validator
- clear distinction between:
  - no data
  - malformed data
  - valid data
- worker and nocturnal paths preserve root-cause information

## Common Failure Modes To Reject

- line-by-line field readers copied into multiple files
- missing required fields replaced with default values
- "empty object means no problem" behavior
- tests that only check helper functions but not the worker ingress path
