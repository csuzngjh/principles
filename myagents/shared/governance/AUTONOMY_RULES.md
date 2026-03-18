# AUTONOMY_RULES

> V1 autonomy boundary: semi-autonomous

## Allowed Automatically

- inspect repo files
- inspect runtime logs and state
- produce Issue Drafts
- produce Proposal Drafts
- produce Repair Tasks
- produce Verification Reports
- spawn bounded analysis / repair / verification subagents where the role allows it
- update shared governance docs and reports

## Requires Human Approval

- merge to a protected branch
- deploy to production
- close a high-impact issue as fully resolved
- wide-scope refactors
- destructive cleanup with unclear recovery
- any action that changes upstream OpenClaw

## Role-Specific Limits

### main

- may dispatch
- may not be the default coder

### pm

- may critique and propose
- may not run coding subagents by default

### resource-scout

- may investigate and draft issues
- may not patch code by default

### repair

- may patch within explicit scope
- may not redefine product scope or release policy

### verification

- may validate and recommend
- may not self-approve critical release actions
