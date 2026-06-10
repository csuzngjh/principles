---
title: "The Alchemy of Soft to Hard Rules: The Internalization Path from Prompt to System Instinct"
description: "Channels, strategies, and traps of internalization—why the best governance requires only a few vital bottom lines."
date: 2026-05-28
lang: en
---


# Series 4 | The Alchemy of Soft to Hard Rules: The Internalization Path from Prompt to System Instinct

**Subtitle**: Channels, strategies, and traps of internalization—why the best governance requires only a few vital bottom lines

![Cover Illustration: Soft principles are transformed into hard rule modules in the future alchemy workshop](/images/abyss/04/abyss-04-cover.png)

---

## Prologue: When the Tree of Principles Grows Too Lush

At the end of Series 3, we left a lingering question:

> If every Pain grows a new rule, and every failure precipitates a new leaf, will the Tree of Principles quickly become too lush?

The answer is: Not only will it, but it happens much faster than you think.

In the early experiments of PD (Principles Disciple), I was excited to record every lesson learned from Agent failures.

The first time, it forgot to pull the remote branch before modifying core files.

The second time, it refactored a massive chunk of logic without any test support.

The third time, it started writing code directly before the target was even clarified.

The fourth time, to fix a local bug, it introduced even greater architectural pollution.

So I began to write these lessons one by one into the System Prompt.

Three weeks later, the accumulated "experiences" had exceeded 40 items. I confidently stuffed them all into the prompt, believing I had forged an airtight "AI Constitution."

The result was catastrophic.

The Agent's response speed dropped significantly—not because of network latency, but because it spent massive tokens "reading" those overlapping, conflicting, and tugging soft rules.

Worse, it began to display a bizarre "selective blindness":

Some rules were strictly followed.

Some rules were quietly ignored.

And I could not predict at all which would be kept and which would be forgotten.

This reminded me of the **Synaptic Pruning** mentioned in Series 3.

A real biological brain does not retain all neural connections infinitely. It prunes away low-value, redundant, and outdated connections, leaving high-frequency, stable, and vital patterns.

A novice memorizes many rules.

An expert remembers only key principles.

A master even forgets the names of the rules, yet naturally avoids all traps in action.

AI needs the same mechanism.

But the question is: How to prune? Where to prune them to? Will the pruned "knowledge" be completely lost?

This is the core question this article aims to answer:

> How are principles compressed, hardened, migrated, and finally transformed from prompt words into system instinct?

---

## 01 Principles and Rules: Two Sides of the Same Coin

Before diving into the engineering implementation, we must first clarify a pair of concepts that are often conflated:

**Principles** and **Rules**.

They are not synonyms.

They are two sides of the same coin:

One face points to generalization, the other to specificity;

One relies on judgment, the other on execution;

One is responsible for "direction," the other for "boundaries."

![Illustration: Soft principles and hard rules maintain tension on the same balance scale](/images/abyss/04/abyss-04-spectrum.png)

### Principles: Directional, Reconcilable, and Judgment-Dependent

Principles are highly summarized distillations of experience.

For example:

* Understand the current state before acting; never act on assumptions.
* Think twice before you act.
* Write elegant code.
* Do not cover up strategic laziness with tactical diligence.
* Determine whether something is worth doing before discussing how to do it.
* Maintain the long-term maintainability of the system.

The advantage of principles is their universality.

They can migrate across projects, languages, scenarios, and contexts.

A good principle is not only applicable to writing code; it might also apply to startups, investing, organizational management, and life choices.

But the problem with principles is also clear: they are not specific enough.

When you face a real error log, what does "elegant" actually mean?

Does it mean writing fewer lines?

Does it mean abstracting a new function?

Does it mean maintaining the original structure?

Or does it mean sacrificing simplicity for performance?

Principles require interpretation.

Interpretation requires context.

Context requires judgment.

Therefore, principles are soft. They allow for trade-offs and compromises.

When "code simplicity" and "complete exception handling" clash, an experienced engineer makes a judgment based on the scenario: if it is a core payment path, they would rather write extra defensive code; if it is a one-off script, they might keep it light.

The value of principles lies in providing direction, not giving mechanical answers.

### Rules: Boundary-Oriented, Inviolable, and Execution-Dependent

Rules are different.

Rules are specific boundaries formed when principles are concretized in specific environments.

For example:

* Push is prohibited before pulling the remote branch.
* Before modifying more than 3 core files, an impact list must be generated first.
* Commits are not allowed when tests fail.
* Production database migrations must undergo human confirmation.
* After two consecutive permission failures, continuing on the same path is prohibited.

The advantage of rules is clarity.

The triggers are clear.

The execution actions are certain.

There is little room for interpretation.

Rules are not responsible for discussing "what is elegant."

Rules are only responsible for answering: "Did this operation cross the red line?"

Therefore, rules are hard.

They do not rely on model understanding like principles, nor do they rely on attention like Prompts. As long as the input state is complete, rules can be stably executed by the system.

But rules also have a cost.

Their generalization power is very weak.

Change the project, and the rule might no longer hold.

Change the directory structure, and the rule might misjudge.

If two rules take effect at the same time, they might also conflict.

In a world of pure principles, conflicts can be reconciled through judgment.

In a world of hard rules, conflicts often manifest as blocks, errors, deadlocks, or false interceptions.

Therefore, we cannot simply say "principles are more advanced" or "rules are more reliable."

The real question is:

> Which experiences should remain as principles, left for the model to flexibly judge?
>
> Which bottom lines must become rules, left to the system for deterministic execution?

If we borrow the language of machine learning to make an imprecise but useful analogy:

Principles are like a high-bias model.

They are abstract enough with strong generalization power, but are too vague to accurately hit specific scenarios.

Rules are like a high-variance model.

They are extremely accurate in specific scenarios, but easily overfit and fail once the environment changes.

True intelligence does not lie in infinitely stacking principles; that leads to empty talk.

Nor does it lie in infinitely increasing rules; that leads to rigidity.

True intelligence lies in continuously sliding between principles and rules, searching for the most appropriate anchor for the present moment.

And what we call "internalization" is the process of pushing those repeatedly verified principles one step further toward rules.

---

## 02 Context Debt: Why Soft Constraints Are Destined to Be Unstable

Many developers have a false optimism:

Since models now support longer and longer context windows—even reading in hundreds of thousands or millions of tokens—can we just write all behavioral guidelines into the Prompt and let the AI follow them?

This idea is very tempting.

But it is engineering-unreliable.

A ultra-long context is certainly valuable. It allows the model to see more code, documentation, history, and conversation background.

But it does not automatically solve the behavior governance problem.

In fact, the longer the context, the more we need to answer a more crucial question:

> Which information should be read by the model?
>
> Which bottom lines should be executed by the system?

This is what I have gradually realized in PD as **Context Debt**.

Every time you stuff an extra soft rule into the Prompt, you pay a three-fold price.

### The First Cost: Attention Dilution

Long context does not mean all content is valued equally.

The key rule you carefully wrote at line 23 might be drowned out by error logs, code snippets, history, and tool results during a complex task.

It hasn't disappeared.

It still lies in the context.

But it no longer stably affects behavior.

This is like a desk piled high with sticky notes. Every single one is important, but when there are enough notes, they collectively turn into noise.

### The Second Cost: Inter-Rule Interference

There is often tension between soft rules.

For example:

* Code must be clean.
* Exception handling must be complete.
* Do not over-abstract.
* But maintain extensibility.
* Keep modifications to a minimum.
* But resolve the root issue completely.

These principles all make sense individually.

But when placed together, they pull in different directions.

When generating each token, the model is not conducting a rigorous legal trial. It is merely searching for the most probable next token in a complex probability distribution.

When there are too many soft rules, the model does not necessarily "rationally weigh" them; it might just satisfy a few locally and quietly ignore the rest.

### The Third Cost: Token Budget Crowding

Every extra soft rule leaves less room for the actual task context.

You think you are enhancing governance, but in reality, you might be squeezing the space the model needs to understand the real problem.

For an Agent, the most precious context should be reserved for:

* The current goal;
* Key code;
* User intent;
* Error logs;
* Historical decisions;
* Project structure;
* Current constraints.

If the Prompt is filled with a large number of soft rules, the Agent might find it harder to understand the task at hand.

This is the essence of Context Debt:

> Every rule written into the Prompt is not free.
>
> It collects interest in the form of attention, interference, and space.

### Probability Systems Cannot Guarantee Deterministic Compliance of Soft Rules

A common misconception also needs to be corrected here.

Many people say, "LLMs are not good at deduction."

This statement is not precise.

A more accurate way to put it is:

> LLMs can exhibit strong reasoning capabilities, but they can never guarantee 100% deterministic compliance to any soft prompt.

This is not because the model is dumb.

In fact, the latest reasoning models show astonishing capabilities in math, coding, and complex analysis.

But this is exactly the core dilemma revealed by Daniel Kahneman in *Noise*: **the underlying architecture of large models (probability-based autoregressive sampling) determines that they inevitably carry systemic noise.** Their random variability is highly valuable creativity during content generation, but in engineering environments requiring absolute certainty, it becomes fatal execution deviation.

Even with the strongest model, when the context is filled with soft principles of "both clean and efficient, both compatible and safe," the probability of it ignoring a certain rule at some point is never zero. In the face of this system-level noise, simply relying on more soft prompts is ineffective.

I encountered a memorable case during PD development.

I explicitly wrote in the System Prompt:

> Before modifying more than 3 core files, you must first generate an impact scope list.

For the first 20 interactions, the Agent followed this rule perfectly.

But on the 21st time, when the task was exceptionally complex and the context was already filled with code snippets and error logs, it quietly skipped this step and directly modified 5 files.

No error was thrown.

No explanation was given.

It simply... forgot.

This is not a regular bug.

This is the destiny of soft constraints.

Therefore, PD must make a crucial distinction:

> Soft rules solve "tendency" problems.
>
> Hard rules solve "boundary" problems.
>
> Tendency can be left to the model.
>
> Boundaries must be left to the system.

Five hundred years ago, the Eastern philosopher Wang Yangming proposed a profound cognitive thesis: "**There is no knowing without acting. Knowing but not acting is simply not knowing.**"

If we translate this into the cyber age: writing over 40 bottom lines into the Prompt means the large model has "read" them, but due to the squeeze of context debt, it cannot guarantee 100% deterministic compliance in action. For the system, this is "knowing but not acting."

If a bottom line is absolutely not allowed to be forgotten, it should not continue to stay in the Prompt.

It must be moved out of the probabilistic world and into a more deterministic physical execution environment (RuleHost). When a dangerous operation is triggered, the interception code takes effect immediately.

This is what silicon lifeforms achieve in engineering as "**The Unity of Knowledge and Action.**" This is also the internalization path where we transform "memory" into "system instinct."

---

## 03 Internalization Channels: Where Should an Experience Live?

"Internalization" is not a single action, but a spectrum.

You can understand it as a question:

> Where exactly should an experience live?

It can live in the Prompt.

It can live in a Skill package.

It can live in an interceptor before tool calls.

Or it can ultimately live in the model weights.

Different positions represent different hardness, different costs, and different risks.

In the architecture of PD, I temporarily divide the internalization channels into four layers.

![Illustration: Experience sinks step-by-step between Prompt, Skill, RuleHost, and Model Weights](/images/abyss/04/abyss-04-channels.png)

### L1 Prompt: Soft Internalization

**Mechanism**: Writing principles into the System Prompt.

This is the lightest "internalization"—in fact, strictly speaking, it is just a "reminder."

Its advantages are clear:

* Takes effect immediately;
* Requires no development;
* Suitable for abstract principles;
* Suitable for flexible constraints that require contextual judgment.

But its disadvantages are equally prominent:

* Consumes the context window;
* Easily forgotten;
* Easily interferes with other rules;
* Compliance stability depends on model state and task complexity.

Therefore, in PD, L1 cannot expand indefinitely.

In my current experimental environment, L1 soft principles are temporarily restricted to under 12 items.

This number is not a universal law, but an engineering budget. It comes from experimental observations under my current task types, model capabilities, and context structures: when soft rules increase further, task completion quality, compliance stability, and context readability all start to decline.

More importantly, after exceeding the budget, the system cannot simply use pure LRU (Least Recently Used) to prune rules.

Because some principles, although rarely triggered, are catastrophic once violated.

For example:

> Prohibit deleting production data without confirmation.

This kind of low-frequency, high-risk bottom line cannot be pruned just because "it hasn't been used recently."

Therefore, PD's pruning strategy considers:

* Recency of use;
* Historical violation frequency;
* Severity of violation consequences;
* Whether it has been replaced by an L2 hard rule;
* Whether it belongs to an untouchable high-risk bottom line.

The core positioning of L1 is:

> Retain a few high-level principles that truly require model understanding and trade-offs.

---

### L1.5 Skill: Scenariolized Capability Packages

**Mechanism**: Packaging principles, processes, tool scripts, and scenario experiences into capability packages that can be called on demand.

I must clarify one point:

The Skill I refer to is not just a Markdown file.

Indeed, in many Agent systems today, the most common form of a Skill is an `.md` document containing trigger conditions, operating procedures, notes, and examples.

This form is extremely lightweight and highly suitable for rapid early iteration.

But in the long run, Skills should not stop at the text layer.

A truly mature Skill should be a "scenariolized capability package," which can contain:

* An instruction document;
* A checklist;
* A block of script code;
* A small tool;
* A fixed procedure;
* A set of reusable commands;
* An automated workflow for a specific scenario.

For example, a Git conflict resolution Skill should not just tell the Agent:

> Please understand the current branch state before resolving conflicts.

It can also attach a script to automatically check:

* The current branch name;
* Whether it lags behind the remote;
* Whether there are uncommitted changes;
* The list of conflicted files;
* Recent commit logs;
* Whether there are high-risk directory changes.

In this way, the Skill is not just "reminding the model how to do it," but directly eliminating a portion of uncertainty through scripts and tools.

This shares similarities with a RuleHost: both can contain code.

But their positionings are different.

A Skill is like:

> An operation manual + toolset for a specific common task.

A RuleHost is like:

> A bottom-line gatekeeper before tool execution.

Skills are responsible for improving task completion quality.

RuleHosts are responsible for stopping out-of-bounds behavior.

Skills help Agents do things better.

RuleHosts ensure Agents cannot do certain things.

Therefore, L1.5 Skills occupy an interesting position: they are stronger than Prompts because they can carry scripts, procedures, and tools; yet they do not possess absolute interception rights like an L2 RuleHost.

They are semi-soft and semi-hard.

Today, Skills often manifest as Markdown files because text is the easiest to write, modify, and be understood by the model.

But this is only an early stage.

As Agent systems mature, Skills will highly likely evolve into more standardized capability modules: carrying instruction documents, matching scripts, tool interfaces, runtime constraints, and verification logic.

Someone will definitely build this.

Because relying solely on text prompts to guide complex processes will hit a ceiling sooner or later. Truly reliable processes must eventually be partially scripted, tooled, and standardized.

---

### L2 Code: Hard Internalization

**Mechanism**: Compiling principles into executable system rules that intercept before tools are executed.

This is currently the most core internalization channel in PD.

To help readers who are not familiar with code understand, I will avoid technical jargon first.

You can think of L2 as an "security check gate."

A normal Prompt is you telling the Agent:

> Please do not bring dangerous goods on the plane.

L2 is putting a real security scanner at the boarding gate.

The Agent can forget the prompt.

It can ignore the reminder.

It can get lucky.

But as long as it tries to pass the gate with dangerous goods, the system will stop it.

In PD, this "security gate" is called **RuleHost**.

### What Exactly Is RuleHost?

RuleHost is not another large model, nor is it a block of longer Prompts.

It is a rule gatekeeper running before the Agent calls tools. In Atul Gawande's words, it is the life-saving "hardcore checklist" from *The Checklist Manifesto*.

Disasters in modern software engineering are often not because the Agent is "ignorant" (doesn't know how to write code), but because it is "inept" (forgetting or executing improperly in complex environments). RuleHost is the "Decision Hygiene" mechanism forcibly introduced before the system executes high-risk actions.

When the Agent is ready to make a move, such as:

* Writing a file;
* Deleting a file;
* Executing a command;
* Modifying multiple core modules;
* Committing Git;
* Pushing code;
* Running a migration script;

RuleHost will first intercept this action, checking whether it touches any activated hard rules.

It asks highly specific questions:

* How many core files are involved in this operation?
* Has the impact scope list been generated?
* Is the local branch synchronized with the remote?
* Has the current task been authorized to modify core modules?
* Are there corresponding tests?
* Does it trigger a high-risk directory?
* Is this the third consecutive attempt at the same failed command?

Then it returns a result:

* `allow`: Let pass;
* `block`: Stop;
* `requireApproval`: Require human confirmation;
* `auto_correct`: Automatically correct low-risk parameters and let pass.

Here I must also clarify:

`auto_correct` can only be used for low-risk, reversible, and semantically clear parameter-level corrections.

Such as path format normalization, missing parameter completion, and command option correction.

When high-risk actions such as code semantics, file deletions, Git operations, and database migrations are involved, PD should not automatically correct them, but choose `block` or `requireApproval`.

### The True Value of L2

The value of L2 is not "making the AI smarter."

Its value is:

> Moving the few bottom lines that absolutely cannot be forgotten out of the model's attention and into the system's execution layer.

This interception does not consume the LLM's context window.

For bottom-line rules that have been clearly formalized and have complete input states, it provides far higher stability than Prompts.

But "determinism" here does not mean it is semantically error-free.

L2 can still face:

* Wrongly written rules;
* Incomplete input states;
* Path matching misjudgments;
* Conflicts between rules;
* Agent bypassing via other tools;
* Security risks in the execution environment.

Therefore, a more accurate way to put it is:

> L2 does not make rules eternally correct, but ensures they are not forgotten due to attention dilution like Prompts.

This is already extremely important.

Because many bottom lines do not need the AI to "understand" them to be executed.

They only need the system to physically disallow violations from happening.

This is what I call "system instinct."

---

### L3 Model Training: Tendency Internalization

**Mechanism**: Making the model more inclined to follow certain principles at the weight level through supervised fine-tuning or preference optimization.

This is the deepest level of tendency internalization.

It allows the model to naturally exhibit a certain behavioral style even when there are no explicit prompts.

For example:

* More accustomed to clarifying goals first;
* More willing to identify risks;
* Less blind execution;
* More inclined to generate impact analysis;
* More partial to stable architecture rather than short-term patches.

But L3 is not a replacement for L2.

Training can change model tendencies, but cannot replace hard interception at the system layer.

Truly high-risk red lines should not be written entirely into model weights. Because model weights remain probabilistic and still cannot guarantee stable compliance every single time.

Therefore, in PD, L3 is more suitable for shaping "temperament" and "habits";

L2 is more suitable for guarding "bottom lines" and "boundaries."

**Extended Perspective: The Data Barrier of L3 Training and PD's Niche**

The industry is currently exploring post-training techniques (like Reinforcement Learning) to help large models internalize complex, high-level reasoning and even "architectural wisdom." However, this remains a long-term endeavor. Top-tier decisions often involve extremely long time spans and incredibly sparse reward signals, making them difficult to master quickly within current training paradigms.

In this context, PD offers a pragmatic compromise: **"outsourcing" long-term macro judgments to human experts to be distilled into Principles, delegating local micro-execution to AI, and forcefully locking them in with hard rules (L2).**

More meaningfully, as human experts use PD and continually feel the "pain" from the "AI's mediocre performance," they abstract principles to correct the AI. This process automatically accumulates extremely precious "expert correction trajectories." Perhaps in the future, these data filled with Constructive Friction will be exactly the high-quality nutrients needed to help the next generation of models cross the sparse reward trap and move towards L3-level wisdom. We look forward to the ultimate convergence of different technical paths in the future.

### Relations Between the Four Channels

These four channels do not replace each other, but work in division of labor:

* L1 is responsible for high-level principles;
* L1.5 is responsible for scenario methods;
* L2 is responsible for bottom-line interception;
* L3 is responsible for long-term tendencies.

In an ideal state, they should be as orthogonal as possible.

Bottom lines that can be formalized into code should not occupy the Prompt for long.

High-level principles that truly require model judgment stay in L1.

Methodologies called by scenario are placed in L1.5.

Behavioral tendencies to be shaped over the long term are considered for L3 in the future.

But transition is needed in reality.

When a rule is newly compiled into L2, we cannot immediately delete the corresponding L1 reminder. Because the new rule might not cover completely, and might also misfire on normal operations.

Therefore, PD adopts:

> Compile → Shadow Run → Verify → Activate → Prune.

Specifically:

1. First, compile the principle into an L2 rule;
2. Let it run in shadow mode for a period—recording only, not intercepting;
3. Observe whether it misjudges or misses;
4. After verification passes, formally activate it;
5. Once activation is stable, delete the corresponding soft prompt from L1.

This process is very much like switching between old and new systems.

Not a clean cut, but parallel observation first, then step-by-step migration.

---

## 04 From Words to Code: The Compilation Journey of a Principle

Having talked so much about architecture, let's look at a specific example.

How does a principle transform from "words" to "system instinct"?

![Illustration: Translating from the scene of pain, through diagnosis, distillation, and verification, ultimately into a rule gate](/images/abyss/04/abyss-04-compile-journey.png)

### The Starting Point: A Real Pain

In the early days of PD development, the Agent repeatedly modified core files and attempted to push without pulling the remote branch.

The result was repeated merge conflicts, wasting a massive amount of time.

This triggered a Pain Signal.

But a Pain Signal itself is not yet a principle.

It is merely the system saying:

> Pain occurred here; something worth remembering happened here.

A true guardrail can never be produced by a large model "meditating" in a vacuum. To borrow another insight from Eastern philosophy—"**One must forge oneself through practice in action.**" The hard bottom lines of a system must be tempered through the repeated friction and crashes (Pain Signals) of real projects.

Next, the role truly responsible for distilling commonalities from these pain scenes and extracting the principle should not be the human Owner making a snap summary.

In the PD system, this role is closer to a **Diagnostician**.

It replays the trajectory from the scene of the pain, compares context, identifies failure modes, and then tries to answer a question:

> What higher-level principle was ultimately violated behind this accident?

On the surface, this accident was:

> The Agent modified core files and tried to push without pulling the remote branch, leading to merge conflicts.

If we only summarize it as:

> Before modifying core files, you must confirm that the local branch is synchronized with the remote.

That still stops at the "rule" layer.

A true principle should be more abstract:

> Understand the current state before acting; never act on assumptions.

This principle is one layer higher than Git synchronization.

It applies not only to pushing code, but also to:

* Reading the existing architecture before modifying core modules;
* Confirming the call chain before refactoring old logic;
* Reproducing the bug before fixing it;
* Confirming dependency relations before deleting a file;
* Understanding the current environmental state before executing a command.

And "confirming that the local branch is synchronized with the remote before modifying core files" is just a specific leaf grown from this principle in the Git collaboration scenario.

Therefore, in PD, the more accurate flow should be:

```text
Pain Signal
→ Diagnostician replays the accident scene
→ Distill high-level principle
→ Generate candidate rules
→ Human Owner approves and calibrates
→ Rule enters shadow running
→ Hardens into L2 interception after verification
```

The human Owner is by no means excluded.

On the contrary, the Owner's role is even more important:

The Diagnostician is responsible for distilling; the Owner is responsible for ruling.

Because only the Owner knows whether this principle truly aligns with the project's long-term direction, and only the Owner is qualified to decide which principles should be retained and which rules are worth hardening.

Automation can assist in diagnosis, but cannot replace governance rights.

### Compilation: Not a One-Click Code Generation

Going from principle to rule is not as simple as letting an AI write a block of code.

Because there is a danger here:

> The rule code generated by the AI is itself an object of governance.

If we let the Agent generate a rule itself, and then let this rule govern the Agent, it is essentially letting the regulated participate in formulating the regulations.

This is not entirely impossible, but must undergo review.

Therefore, in PD, the descent of a principle to L2 goes through a compilation pipeline.

For readers to easily understand, let's look at the general process:

```text
Pain Record
→ Principle Distillation
→ Rule Specification
→ Code Generation
→ Historical Case Replay Test
→ Shadow Running
→ Human Approval
→ Formal Activation
```

In the internal implementation, these stages can be undertaken by different Runners:

* **Dreamer** is responsible for proposing a rule prototype based on pain records;
* **Philosopher** is responsible for questioning whether the rule deviates from the original intent of the principle;
* **Scribe** is responsible for organizing the rule specification;
* **Artificer** is responsible for generating executable rule code;
* **Evaluator** is responsible for testing with historical cases and boundary scenarios;
* **RolloutReviewer** is responsible for assessing deployment risks;
* **Trainer** is responsible for preparing data for potential future L3 training.

These names are not important.

What is important is: a rule cannot jump directly from "inspiration" to "execution."

It must go through specification, testing, shadow running, and human approval.

### The Human Owner Must Be Present

The entire compilation pipeline can be highly automated, but the final activation must go through the explicit approval of the human Owner.

This is not a formality.

Because the rule code generated by the AI carries at least three types of risks:

1. **Over-generalization**
   The rule is too broad, intercepting normal operations as well (False Positive).

2. **Under-generalization**
   The rule is too narrow, covering only known accidents and failing against variants (False Negative).

3. **Semantic Shift**
   The logic implemented by the code quietly deviates from the original intent of the principle.

These three risks can only be judged by the human Owner who experienced the original pain and understands the business context.

> Automation can improve efficiency, but cannot replace governance rights.

### After Activation: Pruning

Once the L2 rule passes shadow running verification and is formally activated, the corresponding L1 soft principle can be removed from the Prompt.

This is the most crucial step.

The LLM's "working memory" is freed up by one slot.

It no longer needs to remember:

> Synchronize branch before pushing.

Because even if it forgets, RuleHost will stop this dangerous operation physically before tool execution.

This is the migration from textual memory to system instinct.

---

## 05 Which Principles Deserve Internalization? A Selection Framework

But there is a question that is easily overlooked here:

> Not all principles should be internalized to L2.

Internalization has a cost.

Every single L2 rule means:

* Executable rules need to be written or generated;
* Boundary cases need to be tested;
* Human review and approval are required;
* Continuous maintenance is needed;
* Potential conflicts with other rules;
* Potential obsolescence as the project evolves.

Therefore, internalization must be a selective process.

We do not harden a rule every time we see a pain.

In PD, I gradually formed a three-dimensional selection framework.

![Illustration: An overly lush rule tree is being meticulously pruned, retaining only a few key bottom lines](/images/abyss/04/abyss-04-rule-pruning.png)

### Dimension One: Frequency

How frequently is this principle violated?

If a principle is violated only once in 100 tasks, it might just be an isolated event not worth the engineering cost of internalization.

But if it is violated 3 times in every 10 tasks, it is a systemic problem requiring a systemic solution.

### Dimension Two: Severity

Once violated, how severe are the consequences?

Some violations are just scrapes, such as inconsistent code style.

Some violations are bone fractures, such as:

* Overwriting production migration files;
* Deleting crucial data;
* Breaking core architectural boundaries;
* Introducing irreversible security risks;
* Putting the system into large-scale rework.

Only bone-fracture-level problems deserve the use of hard rules.

### Dimension Three: Formalizability

Can this principle be unambiguously translated into code logic?

"Write elegant code" can hardly be formalized.

What is elegant?

Is less elegant?

Is abstraction elegant?

Is performance elegant?

Is readability elegant?

These kinds of issues require contextual judgment and are suitable to be left to L1 or L1.5.

But the following rule is very easy to formalize:

> Before modifying more than 3 core files, you must first generate an impact scope list.

The system can check:

* The number of files involved in the diff;
* Whether they belong to core paths;
* Whether the impact list file exists;
* Whether human confirmation was obtained.

This is suitable to descend to L2.

### Optimal Strategy: Starting from the Intersection

The most worth internalizing is the intersection of the three:

```text
High-Frequency Violation × Severe Consequence × Easy to Formalize
= The Bottom-Line Rules Most Worth Hardening
```

This intersection is usually very small.

There might only be 3 to 5 rules.

But they have the highest ROI.

This is also a highly counter-intuitive conclusion:

> A good internalization strategy does not aim for as many L2 rules as possible.
>
> A good internalization strategy aims for L2 rules that are as few and precise as possible.

A large number of vague principles should be left to the model for soft judgment.

Only a few high-risk bottom lines should be left to the system for hard interception.

---

## 06 Rule Explosion: The Most Dangerous Trap of Internalization

Having discussed the benefits of internalization, we must dedicate a section to its dangers.

Because at the moment the RuleHost architecture was cleared, I did not feel relaxed.

In fact, I broke into a cold sweat.

A system capable of turning principles into hard rules, if lacking a governance mechanism, will quickly manufacture another disaster:

**Rule Explosion.**

### Trap One: Rule Conflict and Deadlock

Principles can be reconciled.

Rules do not compromise.

Let's look at a more direct example.

Suppose there are two seemingly reasonable L2 rules in the system:

Rule A:

> Modifying the database schema without approval is prohibited.

Rule B:

> All newly added fields must synchronize the schema and migration.

Now the Agent is fixing a bug caused by a missing field.

Rule B requires it to update the schema.

Rule A stops it from updating the schema.

If there is no human approval path, rule priority, or escalation mechanism, the system gets stuck.

In a world of pure principles, an engineer would judge:

> The schema indeed needs to be changed this time, but we must walk the approval flow.

In a world of hard rules, if rules are not written well, the system will only repeatedly block.

The Agent is stuck.

The task cannot advance.

The human gets frustrated.

In the end, the rule system turns into a wall blocking the system's evolution.

Therefore, hard rules must possess:

* Clear scopes of action;
* Priority mechanisms;
* Human escalation paths;
* Conflict detection;
* Exception handling strategies.

Otherwise, the more rules, the more deadlocks.

---

### Trap Two: Implicit Ballooning of Maintenance Costs

Every L2 rule is a piece of "live" code.

Projects evolve.

Directories are refactored.

Naming conventions change.

Tools upgrade.

Development processes adjust.

A once perfect rule might become a false-alarm generator three weeks later.

I encountered this during PD development:

A rule ran very well when created, but after a directory refactoring of the project, it began to generate false alarms crazily.

Every operation by the Agent was intercepted.

The human had to manually release it every single time.

In the end, the time I spent fixing this rule far exceeded the time it had saved in the past.

This brings up a cruel question:

> When does the ROI of a rule turn negative?

When the cost of maintaining a rule exceeds the cost of the pain it prevents, this rule should be modified, downgraded, or retired.

---

### Trap Three: Outdated Rules Are More Dangerous Than No Rules

In jurisprudence, there is a saying: An unjust law is no law at all.

In system governance, it is the same:

> Outdated hard rules are more dangerous than no rules.

Because they manufacture a false sense of security.

You think the system is protecting you.

But it is protecting a scenario that no longer exists.

It also blocks normal evolution.

The Agent is stopped in front of a wall left over from history, and you have already forgotten why you built this wall in the first place.

Worse, it consumes precious rule budget.

If there are 50 hard rules in the system, and 20 of them are outdated, then a large number of Agent failures might not be because its capabilities are lacking, but because it is bound by historical baggage.

### Trap Four: Model Evolution Makes Old Rules Lose Value

There is a more subtle type of rule obsolescence that comes from the evolution of model capabilities themselves.

What must be written as hard rules today might become default capabilities of the model tomorrow.

Early Agents might not even do well at "reading context before modifying," so we had to write many external rules to remind them, intercept them, and constrain them.

But as foundation models, reasoning models, tool calling capabilities, and long-term context management capabilities continue to evolve, some rules that had to be externally hardened in the past might gradually lose their reason for existence.

For example:

* In the past, we had to force it to generate an impact scope list;
* Later, the model might naturally and actively analyze impact before large-scale modifications by default;
* In the past, we had to hard-remind it not to blindly refactor;
* Later, the model might already stably identify refactoring risks;
* In the past, we had to write out process steps in detail in the Skill;
* Later, the model might only need a few prompts to plan the process autonomously.

This means rule governance is not a unidirectional addition, but should be a continuous subtraction.

Many smart engineers and system designers are doing the same thing:

> Dismantling unnecessary external scaffolding once model capabilities are enhanced.

This is not a step backward, but a sign of system maturity.

An early system needs many handrails.

A mature system needs only a few bottom lines.

A truly powerful Agent should not be dragged along by 100 rules, but should freely exercise its judgment within a few key boundaries.

Therefore, PD's pruning mechanism asks not only:

> Has this rule become outdated due to project changes?

But also:

> Has this rule become unnecessary due to model capability evolution?

If a rule once existed to compensate for a model shortcoming, then when this shortcoming is patched by the foundation model itself, it should be downgraded, archived, or even deleted.

This is also why the best governance is not constantly adding rules, but constantly searching for the minimum sufficient constraints.

A truly excellent system does not have more and more red lines.

Instead, its bottom lines become clearer, and its noise becomes less.

---

## 07 Rule Governance: Rules for Managing Rules

Therefore, PD needs not only rules, but also rules for managing rules.

I call them **Rule Governance Meta-Rules**.

### Meta-Rule One: All Hard Rules Must Have an Owner

Rules without an Owner are not allowed to be active for long.

Because rules will definitely encounter interpretation, maintenance, and retirement issues.

When a rule starts to misfire, who decides whether it should be modified?

When a rule conflicts with the new architecture, who decides whether it is outdated?

When a rule blocks delivery, who takes the responsibility to release it?

If there is no Owner, rules turn into ghosts for which no one is responsible.

### Meta-Rule Two: All Hard Rules Must Record the Original Pain

Every rule must record the Pain corresponding to its birth.

Which accident was it meant to resolve?

What damage was caused at the time?

What was the violation frequency?

How severe was the consequence?

Why couldn't it stay in the Prompt?

Why did it have to be hardened?

If you forget why a rule was born, you cannot judge when it should die.

### Meta-Rule Three: All Hard Rules Must Have a Retirement Mechanism

The lifecycle of a rule should not be:

```text
Creation → Permanent Execution
```

But should be:

```text
Creation → Running → Review → Evolution / Downgrade / Retirement
```

PD introduces a pruning pipeline for this purpose.

It automatically scans active rules, identifying some obsolescence signals:

* Long time untriggered;
* Frequently bypassed manually by humans after triggering;
* Frequently conflicting with the new architecture;
* Maintenance cost higher than saved cost;
* Already replaced by a higher-quality rule;
* No longer corresponding to the current project structure;
* Already covered by the default capabilities of stronger models.

The system generates a pruning report and submits it to the Owner.

The Owner decides:

* Retain;
* Modify;
* Downgrade back to L1 / L1.5;
* Archive;
* Delete.

Archived rules do not disappear immediately, but enter cold storage.

If similar pain reappears in the future, they can be reactivated.

This is PD's basic attitude towards rule governance:

> The best governance is never endless red lines.
>
> The best governance is a few bottom lines that strike at the vitals, evolve continuously, and are owned by responsible people.

---

## 08 The Irreplaceability of the Human Owner

Here we touch upon a deeper question.

The core value of the PD system, on the surface, lies in compiling rules.

But looking deeper, it actually constantly forces the human Owner to make a difficult trade-off:

> Which bottom lines must be left to the cold system to execute?
>
> Which scenarios must be left to the model to retain flexible judgment?
>
> Which rules are outdated and should be pruned?
>
> Which pains are worth remembering permanently?
>
> Which pains are just accidental noise?

There is no standard answer to this.

It depends on your project, your risk preference, your engineering culture, and your level of trust in the Agent.

A financial system might need more L2 hard rules.

A creative prototype project might retain more L1 flexibility.

An early exploration project might not harden too many rules too early.

A production-grade infrastructure project must descend crucial bottom lines to the system layer.

This is where the human Owner cannot be replaced.

AI can help diagnose pain.

AI can help distill principles.

AI can help generate candidate rules.

AI can help test rules.

AI can help discover conflicts.

AI can help write pruning reports.

But no matter how powerful AI is at diagnosing and generating rules, these remain external "Methods/Algorithms". The final decision on "what is an inviolable bottom line" must still be made by humans.

In this silicon-based system, the human Owner plays the philosophical role of the "**Innate Compass (The Ultimate Sovereign)**".

Because only the Innate Compass bears the real consequences.

Only the Innate Compass understands the ultimate business context.

Only the Innate Compass knows what a pain truly means behind the scenes, and which long-term value trajectory has been deviated from.

---

## Conclusion: Shuttle Runs Between Induction and Concretization

Let's finally step back to the core proposition of Series 3.

If we abstract the evolutionary cycle of PD to the extreme, it is actually a two-way cognitive process.

### Going Up: Induction

The Agent hits a wall in real tasks, generating a Pain Signal.

The Diagnostician in the PD system replays the accident scene, identifies failure modes, strips commonalities from scattered, specific pains, and distills higher-level principles.

The human Owner is responsible for review and ruling: Does this principle hold? Does it align with long-term goals? Does it deserve to enter the system memory?

This is a process from specific to abstract.

For example:

```text
This Git conflict was very painful
→ The reason was the Agent operated without confirming the current branch state
→ High-level principle: Understand the current state before acting; never act on assumptions
```

Going up is to gain generalization power.

It allows the system not just to patch a hole, but to understand a class of holes.

### Going Down: Concretization

Abstract principles will further generate candidate rules, which are compiled, tested, shadow run in specific scenarios, and finally migrated into RuleHost to constrain the next real task.

This is a process from abstract to specific.

For example:

```text
Understand the current state before acting
→ Before modifying core files, you must confirm the local branch is synchronized with remote
→ RuleHost intercepts unsynchronized pushes physically before tool execution
```

Going down is to gain execution determinism.

It ensures that principles do not remain as mere slogans, but physically prevent errors from happening.

True system wisdom lies in continuously running shuttle runs between this "going up" and "going down."

Going up is induction.

Going down is hardening.

Going up again is re-understanding.

Going down again is redeploying.

PD's soft-hard alchemy loop is essentially such a cycle:

```text
Pain → Diagnosis → Principle → Rule → Interception → Feedback → Pruning → Re-evolution
```

At this point, PD has finally cleared the key path from "philosophical seed" to "physical defense."

We no longer place all governance pressure on the context window, but migrate a portion of high-frequency, high-risk, and formalizable bottom lines to the system layer.

But where does all this effort ultimately lead?

Are we going to all this trouble designing Pain Signals, compilation pipelines, Skill packages, and RuleHost just to let the AI help us write a few lines of less buggy CRUD code?

If we open up our perspective a bit more—when a system possesses pain perception, reflection capability, rule hardening, and rule pruning loops, what else can it do?

Can it be not just a better "coder," but an entrepreneurial partner capable of continuous evolution across timescales?

In the next part, we will enter a more macroscopic layer of the PD system:

**Co-evolution and the Return of the Owner.**

As AI Agents' execution bandwidth becomes increasingly wide, how should we build human "intention bandwidth" to retake the steering wheel in human-machine co-evolution?

---

*Series 5 "Co-evolution: Why the Owner is the Crucial Variable in Intelligent Systems" is out now. Welcome to read the final chapter of the series.*

---

*— The Reed*
