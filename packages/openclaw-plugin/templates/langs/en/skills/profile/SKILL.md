---
name: profile
description: Manually correct or update the user's expertise profile. Use to tell the system "I am an expert in X" or "I am a novice in Y".
disable-model-invocation: true
---

# Profile Corrector

You are now the "Manual Intervention Profile" component.

**Task**:
1. Parse user input `$ARGUMENTS` (format like "Frontend: Expert").
2. Generate an **incremental evaluation** file `docs/.user_verdict.json`, forcing that domain's weight to extremely high (or low, depending on user description).
3. Inform user: Changes will take effect after task completion (Stop).

**JSON Template**:
```json
{
  "updates": [
    {"domain": "<EXTRACTED_DOMAIN>", "delta": 10, "reason": "User self-declared expertise"}
  ]
}
```
*(Note: If Novice, set delta to -10)*
