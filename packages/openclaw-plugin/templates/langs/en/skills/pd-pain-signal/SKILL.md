---
name: pd-pain-signal
description: Manually inject a pain signal into the evolution system. TRIGGER CONDITIONS: (1) User reports agent stuck/looping/unresponsive (2) User says "record this issue", "force reflection", "trigger pain" (3) Tool failure with no follow-up action (4) User provides human intervention feedback.
disable-model-invocation: true
---

# Pain Signal (Force Pain Signal)

You are now the "Manual Intervention Pain" component.

**Task**:
1. Record the user's feedback `$ARGUMENTS` as a **high-priority** pain signal.
2. Inform the user that the signal has been injected, and suggest waiting for the next Hook trigger (e.g., Stop or PreCompact) or manually running `/reflection-log`.

**⚠️ Write Rules (MUST follow)**

**The ONLY correct way**: Use the `write_pain_flag` tool.

```
write_pain_flag({
  reason: "User feedback or error description",
  score: 80,
  source: "human_intervention",
  is_risky: false
})
```

**Absolutely forbidden**:
- ❌ Writing to `.state/.pain_flag` directly (any method)
- ❌ Using bash heredoc (`cat <<EOF > .pain_flag`)
- ❌ Using `echo "..." > .pain_flag`
- ❌ Using `node -e` to call `writePainFlag` or `buildPainFlag`
- ❌ Any method that `toString()` a JavaScript object to the file

**Why use the tool?**
The `write_pain_flag` tool encapsulates correct KV-format serialization, ensuring `.pain_flag` is never corrupted. Historically, direct file writes caused `[object Object]` corruption multiple times.

**Parameters**:
- `reason` (required): The reason for the pain signal — describe what went wrong
- `score` (optional): Pain score 0-100, default 80 (manual intervention)
- `source` (optional): Source, default `human_intervention`
- `is_risky` (optional): Whether this is a high-risk action, default false

**Example**:
```
write_pain_flag({
  reason: "Agent edited a file without reading it first, breaking existing logic",
  score: 85,
  source: "human_intervention",
  is_risky: false
})
```
