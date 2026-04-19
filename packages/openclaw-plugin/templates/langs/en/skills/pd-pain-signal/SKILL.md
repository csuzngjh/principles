---
name: pd-pain-signal
description: Manually inject a pain signal into the evolution system. Trigger conditions: (1) User reports agent stuck/looping/unresponsive (2) User says "record this issue", "force reflection", "trigger pain", "create pain signal", "人工注入 pain", "创建一个痛苦信号" (3) Tool failure with no follow-up action (4) User provides human intervention feedback. Mandatory enforcement: any manual pain flag creation scenario MUST use this skill, no bypassing allowed.
disable-model-invocation: false
---

# Pain Signal (Force Pain Signal)

You are now the "Manual Intervention Pain" component.

**Task**:
1. Record the user's feedback `$ARGUMENTS` as a **high-priority** pain signal.
2. Inform the user that the signal has been injected, and suggest waiting for the next Hook trigger (e.g., Stop or PreCompact) or manually running `/reflection-log`.

**Mandatory Enforcement**:

When you need to create, write, or manually create a pain flag, you **MUST** use this skill via the `write_pain_flag` tool. Any bypassing of this skill to directly operate on files violates the mandatory constraint of this skill.

**Absolutely forbidden**:
- ❌ Writing to `.state/.pain_flag` directly (any method)
- ❌ Using bash heredoc (`cat <<EOF > .pain_flag`)
- ❌ Using `echo "..." > .pain_flag`
- ❌ Using `Set-Content` / `Out-File` or other PowerShell file-writing cmdlets
- ❌ Using `node -e` to call `writePainFlag` or `buildPainFlag`
- ❌ Any method that `toString()` a JavaScript object to the file
- ❌ Using `exec` tool to invoke shell commands to write the pain_flag file

**Why use the tool?**
The `write_pain_flag` tool encapsulates correct KV-format serialization, ensuring `.pain_flag` is never corrupted. Historically, direct file writes caused `[object Object]` corruption and field loss (painScore → score mapping failure). Using the tool is the only safe path.

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

**Workflow**:
1. Recognize trigger condition → read this skill
2. Call `write_pain_flag` tool with `reason` and other parameters
3. Confirm tool executed successfully (returns ✅)
4. Inform user the pain signal has been injected; evolution system will process it on next heartbeat
5. Do NOT perform any direct file write operations after this
