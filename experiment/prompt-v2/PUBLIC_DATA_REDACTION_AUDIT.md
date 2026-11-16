# PUBLIC_DATA_REDACTION_AUDIT — PD-SPEC-001 Remediation Phase 1

> Date: 2026-11-15. Owner decision on record: redact committed copies; full-fidelity data stays local only.
> Verdict at audit time: **committed dataset/inventory now pass all automated leak checks; the exposure that ALREADY entered public Git history is a separate, Owner-decision matter (§5).**

## 1. Leak classes found in the v1 redaction (all confirmed by canary/re-scan)

| Class | Where | Status |
|---|---|---|
| `textPreview` not in deny list | committed `pain-inventory.json` (85 verbatim previews) | FIXED — deny key + structural-string backstop |
| String-encoded JSON (`evidence_json`) kept unanalyzed | `painDiagnosis.evidence_json` (JSON string with verbatim notes) | FIXED — parse → recursively redact → re-serialize; unparseable JSON-ish → placeholder (fail-closed) |
| Free text under UNKNOWN keys inside parsed pipeline outputs (`nested.deep`, arbitrary model keys) | nested objects in artifacts | FIXED — **structural-string backstop**: inside parsed-JSON subtrees any non-structural string (CJK-bearing prose, long unknown-key text) is redacted regardless of key name |
| Relatable identifiers (`session_id`, `sessionIdHint`) | dataset + inventory | FIXED — irreversible stable `anon-<sha256:16>` ids; structure stays correlatable |
| Local/production absolute paths (`snapshotHashes[].path`, `diagnosisTarget.workspaceDir`) | both files | FIXED — path-shaped values under path keys → placeholder |
| Failure reasons kept verbatim | `PAIN_INVENTORY.md` ("[timeout] LLM request timed out: …"), runs[].reason | FIXED — `safeError()` maps to failure CLASS (timeout / rate_limit / lease_conflict / max_attempts_exceeded / output_invalid); unknown messages → placeholder |

## 2. Redaction mechanism (v2, `scripts/redact-for-publication.mjs`)

1. **Key rules**: DENY (free-text families incl. every pipeline-output text field) → sha256 placeholder; ANON (session ids) → stable anon id; PATH (path/workspaceDir) → placeholder; `last_error`/`reason` → safe failure class, else placeholder.
2. **String-encoded JSON**: parsed and recursively redacted with the same rules, re-serialized; unparseable → whole-string placeholder (fail-closed).
3. **Parsed-JSON backstop**: within any parsed pipeline-output subtree, a string survives ONLY if it is structural (ASCII identifier shape / lineage-ref prefixes / ISO timestamp / numeric). Unknown-key free text cannot survive by construction — this closes the blacklist blind spot the canary test proved (planted `nested.deep` canary).
4. **Value-level fail-closed assertion** (`assertNoVerbatimLeak`): every retained string must not contain any sensitive original (whole-original containment; whole-string placeholder semantics make partial copies impossible). Planting a canary into a projection makes the assertion throw (positive control covered by tests).
5. **Repo-wide scanner** (`scripts/scan-public-leaks.mjs`, re-runnable, exit≠0 on failure): harvests ALL sensitive originals from the LOCAL full copies and scans every tracked text file changed by the PR; also asserts the committed files byte-equal a fresh `redactForPublication()` regeneration (so re-running the generation cannot re-leak silently) and that no data file contains absolute paths.

## 3. Verification evidence

- Canary tests: `scripts/__tests__/pdspec001-redaction.test.ts` — **7/7 PASS** (synthetic pain with canary Owner text, nested JSON evidence, session, path, scope free text, failure messages; positive-control mutation proves the assertion catches leaks; placeholder determinism; anon stability; enum preservation for `scope`).
- Scanner: **81 PR-changed files scanned against 1,508 harvested originals + 31 real session ids → 0 failures**.
- Regeneration equivalence: committed `pain-dataset.json` / `pain-inventory.json` byte-equal a fresh `redactForPublication(full)` (scanner check) — re-running the freeze cannot re-introduce verbatim text.
- Structural retention preserved: artifact JSON keys, sourceRef lineage, category/confidence/status/timestamps, candidate ids and kinds all survive; only free text/identifiers/paths are placeholders.
- Local full-fidelity copies: `.tmp/prompt-v2-inventory/*.full.json` (gitignored, hash-pinned in the dataset manifest) — untouched by redaction; the A/B harness reads them.

## 4. Public data surface after remediation

- `pain-dataset.json` (506KB, was 689KB verbatim): structural + placeholders only.
- `pain-inventory.json` (680KB): structural + placeholders only (85 textPreview entries now placeholders).
- Docs (`PAIN_INVENTORY.md`, `DATASET_SELECTION.md`, `EXPERIMENT_CURRENT_STATE_AUDIT.md`): failure classes and ids only; no verbatim text.

## 5. ALREADY-PUBLIC Git history (Owner decision required — NOT actioned by agent)

The verbatim dataset/inventory blobs were committed and **pushed to the public GitHub repo** in the first redaction cycle's predecessors:

- Verbatim `pain-dataset.json` blob `074717ac4841…` exists in pushed commits `72c89a9b4` … `cfa838465` (13 commits on PR branch #2653).
- Verbatim `pain-inventory.json` (85 textPreviews + evidence text) likewise.
- Severity context: content = Owner's own pain-submission words about their agents (incl. brief references to Owner's other projects), evidence notes, and pipeline artifacts — no credentials/tokens (the feedback ingest token was never committed; dropped sections only existed in runtime-derived configs).

Options (Owner decides; agent must NOT force-push):
1. **Accept exposure** — data is Owner-authored governance material; delete nothing (lowest risk of breaking the open PR).
2. **History rewrite + force-push** the PR branch (squash/rebase dropping `72c89a9b4`–`cfa838465` dataset blobs) — removes it from branch history but not from forks/caches once fetched; requires Owner authorization and coordinated CI re-run.
3. **Repo support contact / repo-private migration** — heavier, only if severity is judged high.

## 6. Residual limitations (disclosed, not P0)

- The structural-string backstop admits short ASCII free text (<64 chars, identifier-shaped). Owner narration is CJK-bearing in this dataset; a hypothetical short pure-ASCII Owner sentence could evade the shape check but would still be caught if it appears anywhere in the harvested set (whole-original containment). Canary tests encode this boundary.
- The scanner INFO item (`baseline/model-config.json` contains the production endpoint/workspace path as configuration description) is reviewed-accepted: it names infrastructure, not data content.
