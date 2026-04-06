# Workflow v1 Acceptance Checklist

## Purpose

Use this checklist to validate that the packaged workflow is readable, executable, and safe to hand off to another agent.

## Acceptance gates

- [ ] Baseline tests are green
- [ ] `workflow-validation-minimal` completes and writes package-local artifacts
- [ ] `workflow-validation-minimal-verify` completes and validates the previous run
- [ ] Every failure is classified into the approved four-category taxonomy

## Commands

```powershell
node scripts/run.mjs --self-check
node scripts/run.mjs --help
node scripts/run.mjs --task workflow-validation-minimal
node scripts/run.mjs --task workflow-validation-minimal-verify
```

## Run result record

| Field | Value |
|------|------|
| runId | |
| outcome | |
| outputQuality | |
| validation | |
| nextRunRecommendation | |
| failure classification | |

## Required artifact checks

- `decision.md` contains `outputQuality`
- `decision.md` contains `qualityReasons`
- `decision.md` contains readable validation status
- `scorecard.json` contains `outputQuality`
- `scorecard.json` contains `qualityReasons`
- `scorecard.json` contains `validation`
- `scorecard.json` contains `nextRunRecommendation`

## Failure classification

- `workflow bug`
- `agent behavior issue`
- `environment issue`
- `sample-spec issue`

## Stop conditions

If the run exposes a sample-side or product-side issue:

- classify it
- record evidence
- stop the run review
- do not continue into product closure work
