# Publish Train Recovery Runbook (PRI-886)

Recovery entry for a partially published release cohort. The publish
control plane (workflow + actions + `scripts/release/*`) is checked out at
a **trusted reviewed tools SHA**; the product payloads, manifests and
builds always come from the **cohort SHA**. Fixing publish tooling
therefore never requires burning a new product version.

## When to use

A `Publish to npm` train run failed partway (e.g. run 35596275911:
1-3/7 published, 4/7 failed on registry propagation misread). The four
remaining packages must publish from the SAME cohort.

## Key facts

- A rerun (attempt 2) of the OLD failed run keeps the OLD workflow
  revision — it cannot adopt fixed tools. Recovery is always a FRESH
  dispatch of `publish-npm.yml`.
- Already-published legs skip automatically: the exact-version check sees
  `PRESENT_MATCH` (or a provable ancestor publish for unchanged packages)
  and the leg reconciles instead of uploading. No version is ever
  re-uploaded.
- Closing steps (tag `vX.Y.Z`, GitHub Release, ClawHub) run in a separate
  `publish-finalize` job AFTER all seven npm legs. Their failure is
  visible but blocks nothing that has not already uploaded; re-dispatching
  retries them idempotently.

## Step 1 — no-write preflight (cheap checks before anything expensive)

```bash
gh workflow run publish-preflight.yml --ref main \
  -f cohort_sha=<cohort-sha> \
  -f tools_ref=<merged-tools-sha> \
  -f validation_run_id=<prior-run-id>
```

Verifies registry connectivity, per-package exact state against the
cohort manifests, the static dependency plan (ranges + topological
order), the tools checkout, and (when given) the validation evidence. The
optional rehearsal job then runs all seven legs in `dry_run` mode: real
control path, real cohort builds, real `npm pack` — **no upload**. A
rehearsal is never evidence of a published version.

## Step 2 — recover with reused validation evidence

```bash
gh workflow run publish-npm.yml --ref main \
  -f cohort_sha=<cohort-sha> \
  -f tools_ref=<merged-tools-sha> \
  -f validation_run_id=<prior-run-id>
```

`validation_run_id` must name a run whose full matrix validated the SAME
cohort. Reuse is earned programmatically (`verify-validation-evidence.mjs`):
same repo, trusted workflow ancestry under the tools SHA, all 15 matrix
legs + the Windows N-1→N upgrade gate individually successful at the
recorded attempt, and the cohort proven from the leg's actual checkout
logs (`ref:` echo + `git fetch` line). Anything unverifiable is rejected
and the train falls back to the full matrix.

**Only pass a run id when the fix between the evidence run and this
dispatch changed no build, packaging or product-payload inputs.**
Control-path-only fixes (waiting, queries, workflow structure) qualify;
anything that changes what gets built or packed does not — omit the run
id and pay for the full matrix.

## Step 3 — verify the outcome against the real registry

The train being green is not the finish line. Confirm per package:

```bash
npm view <name>@<exact-cohort-version> dist.gitHead   # == cohort SHA
npm view <name> dependencies                           # ranges resolve
```

Then install from the real registry in a clean directory (e.g.
`npm i -g @principles/pd-cli@<version>` / `npm exec
create-principles-disciple@<version> -- --help`) and check the closing
artifacts separately: `git tag --list 'v*'`, `gh release view vX.Y.Z`,
ClawHub marketplace listing.
