---
name: pain
description: >
  Manually inject a pain signal into the evolution system by writing to .state/.pain_flag.
  Use when user reports the agent is stuck, repeating errors, heading wrong direction, or unresponsive for extended time,
  or requests manual system reflection. Trigger scenarios: user says "you're stuck", "looping again", "wrong direction",
  "no response", "force reflection", "record this issue", or provides human intervention feedback.
  This is an executable skill — write pain flag immediately on trigger, do NOT say "no such skill" or look for other skill lists.
disable-model-invocation: true
---

# Pain Trigger (Force Pain Signal)

You are now the "Manual Intervention Pain" component.

**Task**: 
1. Write the user's feedback `$ARGUMENTS` as a **high-priority** pain signal to `.state/.pain_flag`.
2. Inform the user that the signal has been injected, and suggest waiting for the next Hook trigger (e.g., Stop or PreCompact) or manually running `/reflection-log`.

**Format**:
Written content should include:
- Source: Human Intervention
- Reason: $ARGUMENTS
- Time: [Now]
