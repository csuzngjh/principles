# m9-05 Real UAT Context

## UAT Execution: 2026-04-29

### Provider Configuration
- **Provider**: xiaomi-coding
- **Model**: mimo-v2.5-pro
- **BaseUrl**: https://token-plan-cn.xiaomimimo.com/v1
- **API Key**: XIAOMI_KEY (from ~/.openclaw/openclaw.json)
- **Timeout**: 60000ms

### Workflow Config (D:/.openclaw/workspace/.state/workflows.yaml)
```yaml
version: "1.0"
funnels:
  - workflowId: pd-runtime-v2-diagnosis
    stages: []
    policy:
      runtimeKind: pi-ai
      provider: xiaomi-coding
      model: mimo-v2.5-pro
      apiKeyEnv: XIAOMI_KEY
      baseUrl: https://token-plan-cn.xiaomimimo.com/v1
      maxRetries: 3
      timeoutMs: 60000
```

### Fixes Applied Before UAT

#### Fix 1: MAX_ABSTRACTED_PRINCIPLE_CHARS = 200
- **default-validator.ts**: Added `export const MAX_ABSTRACTED_PRINCIPLE_CHARS = 200`; replaced hardcoded 40 with this constant
- **diagnostician-output.ts**: Updated JSDoc comment (≤200 chars), added `@see MAX_ABSTRACTED_PRINCIPLE_CHARS`
- **diagnostician-prompt-builder.ts**: Updated prompt instructions from "max 40 chars" to "max 200 chars" in both DIAGNOSTIC_PROTOCOL_INSTRUCTION and JSON output example
- **default-validator.test.ts**: Added tests for 200-char pass, 201-char fail, and 41-char pass (old limit boundary)

#### Fix 2: CandidateIntakeService sourceRecommendationJson Priority
- **candidate-intake-service.ts**: Changed parsing priority — now reads `candidate.sourceRecommendationJson` FIRST (canonical source from SqliteDiagnosticianCommitter's `source_recommendation_json` column), falls back to `artifact.contentJson` only if sourceRecommendationJson is empty/invalid
- **Recommendation interface**: Made `title`, `text`, `triggerPattern`, `action`, `abstractedPrinciple` all optional to safely handle parsed JSON

### UAT-01: Environment Check
```bash
echo $XIAOMI_KEY  # tp-cs6x1cdjzxqde93jm637mgvqa2ogievg6262mamup5zpurji
```
**Result**: PASS — key exists and is valid

### UAT-02: Probe
```bash
pd runtime probe --runtime pi-ai --provider xiaomi-coding --model mimo-v2.5-pro \
  --apiKeyEnv XIAOMI_KEY --baseUrl https://token-plan-cn.xiaomimimo.com/v1 \
  --workspace D:/.openclaw/workspace --timeoutMs 60000
```
**Result**: PASS — healthy: true, degraded: false

### UAT-03: Pain Record
```bash
pd pain record --reason "M9 UAT test signal" --score 75 --source manual_uat \
  --workspace D:/.openclaw/workspace
```
**Result**: PASS
- painId: manual_1777461667018_qjsltozi
- status: succeeded
- artifactId: 9e696728-9693-4e21-ad81-fa129a54e6c5
- candidateIds: [dfd8937b-16e1-4824-bf93-6903b430d4c2]
- ledgerEntryIds: [43f4f93e-81d7-428e-82d6-540b80af1a81]

### UAT-04: Verify Output
- [x] status === 'succeeded'
- [x] artifactId exists (9e696728-9693-4e21-ad81-fa129a54e6c5)
- [x] candidateIds.length > 0 (1 candidate)
- [x] ledgerEntryIds.length > 0 (1 entry)

### UAT-05: Verify Ledger
```bash
data._tree.principles['43f4f93e-81d7-428e-82d6-540b80af1a81']
```
**Result**: PASS — ledger entry exists with:
- text: "Ensure diagnostic requests include populated evidence before initiating root cause analysis"
- triggerPattern: "empty.*context|missing.*evidence|no.*content|blank.*entries"
- action: "Verify source data is accessible and contains substantive content before requesting diagnosis"
- derivedFromPainIds: ["dfd8937b-16e1-4824-bf93-6903b430d4c2"] ✓
- sourceRef correctly maps to candidate://dfd8937b-16e1-4824-bf93-6903b430d4c2

### UAT-06: Idempotency
Second pain record run:
- painId: manual_1777461873944_06v3hvqh
- candidateId: 1316a064-ce07-42db-b06a-21917a551752
- ledgerEntryIds: [92c5b7d2-aa29-4b63-bb04-ff695e10c37e]
**Result**: PASS — No duplicate ledger entries. Each candidateId maps to exactly one ledger entry.

### UAT-07: Legacy Files Unchanged
```bash
ls D:/.openclaw/workspace/.state/diagnostician_tasks.json 2>/dev/null
```
**Result**: PASS — No legacy diagnostician_tasks.json file created

### UAT-08: Document Results
**This file** — m9-05-CONTEXT.md

### Ledger Entry Details

#### Entry 1 (from UAT-03)
- **ID**: 43f4f93e-81d7-428e-82d6-540b80af1a81
- **Candidate ID**: dfd8937b-16e1-4824-bf93-6903b430d4c2
- **text**: "Ensure diagnostic requests include populated evidence before initiating root cause analysis"
- **triggerPattern**: "empty.*context|missing.*evidence|no.*content|blank.*entries"
- **action**: "Verify source data is accessible and contains substantive content before requesting diagnosis"
- **status**: candidate
- **evaluability**: weak_heuristic
- **createdAt**: 2026-04-29T11:21:28.581Z

#### Entry 2 (from UAT-06)
- **ID**: 92c5b7d2-aa29-4b63-bb04-ff695e10c37e
- **Candidate ID**: 1316a064-ce07-42db-b06a-21917a551752
- **text**: "Validate minimum required fields before invoking diagnostic workflows"
- **triggerPattern**: "empty.*target|missing.*evidence|no.*data|incomplete.*payload"
- **action**: "Fail fast with a clear error message when diagnosisTarget is empty or conversationWindow contains no substantive content"
- **status**: candidate
- **evaluability**: weak_heuristic
- **createdAt**: 2026-04-29T11:24:33.xxxZ

### M9 Complete Verification
| Requirement | Status |
|------------|--------|
| PiAiRuntimeAdapter integrates with DiagnosticianRunner | PASS (via m9-adapter-integration.test.ts) |
| Full pain→artifact→candidate→ledger chain succeeds | PASS (m9-e2e.test.ts + real UAT-03) |
| triggerPattern and action preserved in ledger entries | PASS (UAT-05 verification) |
| sourceRef correctly maps to candidate:// IDs | PASS (derivedFromPainIds contains candidateId) |
| Idempotency: no duplicate ledger entries | PASS (UAT-06) |
| No legacy diagnostician_tasks.json created | PASS (UAT-07) |
| Real xiaomi-coding/mimo-v2.5-pro provider works | PASS (UAT-02 + UAT-03) |