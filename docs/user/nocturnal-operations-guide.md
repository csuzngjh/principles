# Nocturnal Operations Guide

> **Audience**: End users who run Principles Disciple day-to-day
> **Goal**: Explain what Nocturnal Evolution does and what actions you need to take
> **Constraint**: No algorithm internals, no LoRA/ORPO math — just the operations that matter

---

## 1. What Is Nocturnal Evolution?

Nocturnal Evolution is Principles Disciple's "sleep learning" system. While you sleep or when the agent is idle, it:

1. **Reviews recent behavior** — looks at what happened in recent sessions
2. **Compares against your principles** — checks if better decisions could have been made
3. **Generates training data** — creates "what should have happened" examples
4. **Trains a small model adapter** — uses the examples to train a LoRA adapter on your principles
5. **Rolls out gradually** — new behavior starts in shadow mode before full activation

The system never modifies OpenClaw's core or the main orchestrator agent. Everything is additive — a layer on top of your existing workflow.

---

## 2. The User Operations You Control

Nocturnal Evolution is largely automatic, but there are **six decision points** where you take action:

```
┌─────────────────────────────────────────────────────────────────┐
│                      YOUR CONTROL NODES                          │
│                                                                  │
│  ① Review Samples  ←  "Is this training data any good?"        │
│       ↓                                                          │
│  ② Create Experiment  ←  "Train a new adapter on these samples" │
│       ↓                                                          │
│  ③ Import Results  ←  "The training finished — register it"     │
│       ↓                                                          │
│  ④ Review Evaluation  ←  "Does the new adapter actually help?"  │
│       ↓                                                          │
│  ⑤ Advance Promotion  ←  "Move from shadow → real deployment"   │
│       ↓                                                          │
│  ⑥ Enable / Disable / Rollback  ←  "Control what's live"        │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Node ① — Review Samples

### What happens automatically

Every time the system generates training samples (from pain signals or idle-time reflection), they go into a **sample queue**. Each sample is a pair:

- **Chosen**: What the agent *should* have done (reflected, improved version)
- **Rejected**: What the agent *actually* did (original, flawed version)

### What you do

1. Open the Principles Console → **Samples** page
2. You see pending samples grouped by principle
3. For each sample, you can:
   - **Approve** — include in the next training experiment
   - **Reject** — discard, with an optional reason
   - **Edit** — fix incorrect chosen/rejected pairs manually

### When to reject a sample

- The "chosen" version is actually worse than the original
- The scenario is too specific to be useful as a general example
- The principle cited doesn't actually apply to this case

### Tip

Samples are **not** automatically included in training. Your approval is the gate. If you never approve any samples, no training runs.

---

## 4. Node ② — Create Training Experiment

### What happens automatically

When you approve enough samples, the system can create a training experiment. An experiment is a run of the external trainer (e.g., ORPO on Llama/Qwen) that produces a LoRA adapter checkpoint.

### What you do

1. Open the Principles Console → **Evolution** page
2. Click **New Experiment**
3. Select:
   - **Target principle** or "all approved samples"
   - **Base model** (e.g., Qwen2.5-7B, Llama-3.1-8B)
   - **Training backend**: ORPO (recommended) or dry-run (test only)
   - **Hyperparameters** (you can use defaults)
4. Click **Start Experiment**

The system writes a `TrainingExperimentSpec` to disk and hands it to the external trainer. This runs outside of OpenClaw — you can monitor its progress in the trainer's own log output.

### What "dry-run" does

Dry-run validates that the experiment spec is well-formed and the environment is set up — but does **not** produce a real checkpoint. Use it to verify everything is wired correctly before burning GPU hours.

### Prerequisites

- Approved samples in the queue (at least ~100 is a reasonable minimum)
- External trainer installed and configured (see Operator Guide)
- Sufficient disk space for checkpoint output

---

## 5. Node ③ — Import Training Results

### What happens automatically

When the external trainer finishes, it outputs a LoRA adapter checkpoint. The plugin needs to know about this checkpoint before it can be evaluated or deployed.

### What you do

1. When the trainer finishes, it prints a **checkpoint path**
2. In the Principles Console → **Evolution** page, click **Import Result**
3. Paste the checkpoint path
4. The system:
   - Validates the checkpoint format
   - Records the training lineage (which samples, which base model, which config)
   - Moves the checkpoint into the plugin's registry
   - Marks it as `candidate_only` in the promotion pipeline

### What you see

After import, the checkpoint appears in the **Evolution** page with status **`candidate_only`**. This means: valid artifact, but not yet evaluated and not yet eligible for routing.

---

## 6. Node ④ — Review Evaluation

### What happens automatically

After a checkpoint is imported, it goes through **evaluation**:

- A benchmark run compares the new adapter against the current active one
- The system computes a **quality delta** — does the new adapter perform better on your principle-weighted scenarios?
- Results are recorded in the eval registry

### What you do

1. Open the Principles Console → **Evolution** page
2. Find your imported checkpoint
3. Click **View Evaluation**
4. You see:
   - **Reduced-prompt holdout delta**: How much better/worse the new adapter is on reduced-prompt tasks
   - **Arbiter reject rate delta**: Whether the new adapter causes more or fewer principle violations
   - **Executability delta**: Whether the new adapter causes more or fewer tool-call failures
   - **Regression warnings**: Any metric that got worse beyond the allowed margin

### What the numbers mean

| Metric | Getting Better | Getting Worse |
|--------|--------------|---------------|
| Reduced-prompt holdout delta | ✅ New adapter is smarter | ❌ New adapter is worse |
| Arbiter reject rate delta | ✅ Fewer violations | ❌ More violations |
| Executability delta | ✅ Fewer failures | ❌ More failures |

### Decision

- If all metrics pass the promotion thresholds → the checkpoint moves to **`shadow_ready`**
- If any metric regresses beyond the allowed margin → the checkpoint is **`rejected`**
- If it passes but needs more runtime evidence first → it stays **`candidate_only`** until shadow evidence accumulates

---

## 7. Node ⑤ — Advance Promotion

### What happens automatically

Promotion moves a checkpoint through a series of states:

```
rejected → candidate_only → shadow_ready → promotable → deployed
```

- **shadow_ready**: New adapter handles tasks in shadow mode (main agent routes some tasks to it, observes outcomes, but the main agent still supervises everything)
- **promotable**: Shadow window completed, all runtime checks passed, orchestrator has reviewed
- **deployed**: The checkpoint is now the active checkpoint for its worker profile

### What you do

The system prompts you at each promotion step in the Principles Console. You:

1. Review the eval summary and runtime shadow evidence
2. Click **Approve Promotion** to advance to the next state
3. The system performs the promotion gate checks automatically

### What "shadow mode" means for you

While a checkpoint is in shadow mode:

- The main agent routes **some** eligible tasks to the experimental adapter
- You don't notice anything different — the main agent supervises and can override
- Runtime evidence is collected: does the adapter actually produce better outcomes?
- If anything looks wrong, you can **disable** or **rollback** at any time

### Promotion gate checks (automatic)

The system checks all of these before allowing promotion:

| From State | To State | Gate Checks |
|-----------|---------|------------|
| candidate_only | shadow_ready | Eval attached + delta above threshold + no reject-rate regression |
| shadow_ready | promotable | Shadow window completed + orchestrator review passed + rollback target preserved |

---

## 8. Node ⑥ — Enable / Disable / Rollback

### Enable

When a checkpoint reaches **`promotable`**, you can enable it. This makes it the active adapter for its worker profile. Use the Principles Console → toggle the adapter on.

### Disable

At any time (including during shadow mode), you can disable a checkpoint. The system immediately stops routing to it and falls back to the previous checkpoint. No data is lost.

### Rollback

If something goes wrong, rollback returns the worker to the **last known good checkpoint**. Rollback is immediate and always available — the previous checkpoint is preserved as part of the promotion contract.

**When to rollback**:
- Routing error rate spikes
- Users report consistently worse outcomes
- Benchmark lineage becomes invalid
- You deployed a checkpoint that later turns out to have regressions

### How to rollback

1. Principles Console → **Evolution** page
2. Find the active (problematic) checkpoint
3. Click **Rollback**
4. Confirm the target (previous checkpoint)
5. The system switches routing to the previous checkpoint immediately

---

## 9. The Two Worker Profiles

Currently, Nocturnal Evolution supports two bounded worker profiles:

| Profile | Skill | What it handles | Eligible for routing? |
|---------|-------|----------------|---------------------|
| **local-reader** | pd-explorer | Reading, inspection, information retrieval tasks | ✅ Yes — Phase 7 first rollout |
| **local-editor** | pd-repair | Bounded editing, modification, repair tasks | 🚧 Deferred |

**local-reader** is the first profile to receive Nocturnal Evolution training and promotion. It is the only profile that can currently be routed via this system.

---

## 10. What Runs Automatically

You do not need to micromanage Nocturnal Evolution. The system handles:

- ✅ Sample generation from pain signals and idle-time reflection
- ✅ Arbiter quality gate (discards samples that don't show enough improvement)
- ✅ Training experiment execution (via external trainer)
- ✅ Checkpoint validation and lineage recording
- ✅ Evaluation benchmark runs
- ✅ Shadow evidence collection from real runtime hooks
- ✅ Promotion gate checks

**You** control: approving samples, initiating experiments, reviewing evals, and approving promotion steps.

---

## 11. Troubleshooting

| Symptom | Likely Cause | Action |
|---------|-------------|--------|
| No samples being generated | No pain signals recently, or cooldown in effect | Wait for pain events or idle cycle |
| Experiment won't start | No approved samples | Approve samples first |
| Checkpoint stuck at `candidate_only` | Eval not yet attached, or eval not strong enough | Wait for eval to complete |
| Shadow mode shows bad outcomes | Adapter is not performing well | Disable + rollback to previous checkpoint |
| Promotion blocked | Runtime evidence not yet sufficient | Wait for shadow window to collect more data |

---

## 12. Glossary

| Term | Meaning |
|------|---------|
| **Checkpoint** | A trained LoRA adapter — the output of a training experiment |
| **Shadow mode** | New adapter handles real tasks but main agent supervises and observes |
| **Promotion** | Moving a checkpoint through the state machine toward deployment |
| **Arbiter** | Automatic quality gate — discards samples that don't show enough improvement |
| **Lineage** | Record of which samples, base model, and config produced a checkpoint |
| **Rollback** | Returning to the previous known-good checkpoint |
| **local-reader** | Bounded worker for read/inspect tasks — first profile to receive training |
| **local-editor** | Bounded worker for edit/repair tasks — deferred |
