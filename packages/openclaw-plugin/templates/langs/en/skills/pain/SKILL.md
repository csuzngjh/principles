---
name: pain
description: Manually inject a pain signal into the evolution system by writing to .state/.pain_flag. TRIGGER CONDITIONS: (1) User reports agent stuck/looping/unresponsive (2) User says "record this issue", "force reflection", "trigger pain" (3) Tool failure with no follow-up action (4) User provides human intervention feedback.
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
