---
name: pain
description: Manually trigger a pain signal to force system reflection. Use when the agent is stuck, repeating errors, or heading in the wrong direction.
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
