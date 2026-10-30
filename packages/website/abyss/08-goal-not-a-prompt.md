# Series 8 | A Goal Is Not a Prompt: When Agents Learn to Execute, Who Is Responsible for Judgment?

**Subtitle**: From a Submarine's Wrong Order to Long-Term Human–AI Decision Collaboration

![Cover: a submarine glides through an abyssal trench, a blue track of execution light unfolding along its hull while amber and violet forked paths stretch toward the distance, where a golden pillar of light illuminates the land of values. Deep blue-black digital ocean, 21:9.](/images/abyss/08/abyss-08-cover.webp)

---

## 01 On a Submarine, No One Questioned the Wrong Order

In 1999, the U.S. Navy officer L. David Marquet took command of the nuclear submarine USS Santa Fe.

Before that, he had spent a great deal of time familiarizing himself with the equipment, structure, and operating procedures of a different submarine. Then, shortly before taking command, he was reassigned to the Santa Fe. The two boats were of different classes, and many operational details differed.

The captain holds the highest authority aboard, yet is not necessarily the person most familiar with the ship.

During a simulated nuclear reactor failure drill, the submarine switched to backup electric propulsion.

To raise the pressure on his crew, Marquet issued an order:

"Ahead, two-thirds speed."

The officer of the deck immediately relayed the order to the helmsman.

But the submarine did not speed up.

Because the submarine's backup propulsion system had no "two-thirds speed" setting at all.

What happened next was even more surprising.

Marquet asked the officer of the deck whether he had known that the setting did not exist.

The answer: yes.

If he knew, why relay the order anyway?

The officer's answer was very simple:

"Because it was your order."

This is a true story told by Marquet in *Turn the Ship Around!*

What is most worth pondering in this story is not that the captain made a mistake, but that **the people who held the correct information took no part in the decision to correct the error.**

The captain thinks; the subordinates obey.

Once this division of labor runs smoothly enough, even when the leader's judgment is wrong, the organization may still efficiently carry out the wrong instruction.

![The submarine's control room: a golden stream of command light flows from the captain's fingertip along the chain of command, passing through one officer after another before finally pouring into the helm — the order is faithfully relayed and executed, yet no one checks whether it is correct.](/images/abyss/08/abyss-08-command-chain.webp)

Marquet realized that the problem was not that any individual lacked a sense of responsibility, but that the organization had separated thinking from execution.

Afterward, he began to change the way the ship operated.

Crew members no longer merely asked the captain what they should do next. Instead, they volunteered:

**"I intend to..."**

Next, they had to explain what action they planned to take, why, and whether the relevant conditions were satisfied.

The captain could confirm — or question.

On the surface, one sentence simply changed: from "issue your orders" to "I intend to do this."

But behind it lay a profound shift.

Executors began to carry the responsibility of thinking; the people holding the information on the spot began to take part in decisions; and the leader no longer had to formulate every plan of action personally.

Marquet called this approach Intent-Based Leadership.

Its foundation is not laissez-faire, but three mutually supporting conditions: distributed control, professional competence, and a clear understanding of the organization's direction.

In other words, **real empowerment is not simply handing the decision to someone else; it is letting people who understand the goal, grasp the facts, and possess the ability make judgments within clear boundaries.**

More than two decades later, as humans began to work alongside AI Agents, the story of that submarine suddenly took on new practical meaning.

## 02 Are We Training a New Generation of Executors Who Only Obey?

Today's AI coding agents can already complete work that once required engineers to spend enormous amounts of time.

They can understand requirements, read code, draw up plans, modify programs, run tests — and even iterate through many rounds without continuous human intervention.

Some agent harnesses also provide Plan Mode and Goal Mode.

The former helps the agent plan how to complete a task; the latter lets the agent keep working toward an explicit completion condition, deciding whether to continue based on execution results.

For example, a user might demand:

"Bring the API's P95 latency below 120 milliseconds while keeping the existing tests passing."

The agent can repeatedly analyze performance bottlenecks, modify code, and run benchmarks until the agreed condition is met — or a clear stopping reason appears.

This is a valuable engineering advance.

But if the same mechanism is applied to long-term strategy, the problem becomes far less simple.

Suppose the founder of a software company tells the Agent:

"Over the next three years, we want to become a product company our users genuinely trust."

How should this goal be accomplished?

Do passing tests count?

Does growth in user numbers count?

Does revenue growth count?

All of these may be useful signals, but no single metric can fully represent "worthy of users' trust."

What is more complicated, the Agent may face all kinds of seemingly ordinary choices every day.

To speed up delivery, should it cut back on testing?

To raise conversion, should it add more marketing pop-ups?

To lower development costs, should it simplify important user interactions?

Every one of these choices can have a perfectly good local justification.

If the Agent's task is merely to increase delivery speed, it may consistently choose the more efficient option.

Months later, code is delivered faster and faster, while the product experience keeps getting worse.

The curious part is that this Agent may never have forgotten the goal.

It may even have executed every task more faithfully than a human would.

**What actually drifted was not the wording of the goal in the context, but the values behind the goal, gradually consumed through one local choice after another.**

This is more insidious than goal forgetting caused by context compression.

Because every task in the system may be completed well, every test may pass, and every execution report may look satisfying.

Until one day people discover that all the locally correct choices never added up to a globally desirable outcome.

Where does the problem lie?

Perhaps we have focused too much on whether agents can complete tasks, while overlooking a more fundamental question:

**Before a task begins — and at every important disagreement during execution — who is responsible for judging what is worth doing?**

## 03 Through What Does a Goal Actually Shape Reality?

In 1947, Herbert Simon proposed a far-reaching insight in *Administrative Behavior*.

Traditional management theory often concerns itself with how to get things done, while paying comparatively little attention to the choices made before action.

In Simon's view, decision-making does not happen only at the very top of an organization.

Once the company sets a strategy, departments must still decide how to realize it; once a department makes a plan, teams must still make numerous concrete choices.

Management is not merely the execution of established decisions — decision-making runs through the entire organization.

This observation helps us understand long-term goal management.

Suppose a company wants to become an industry leader within five years.

That goal by itself cannot tell the company which markets to enter, what products to build, what technologies to use, or what talent to hire.

A goal describes a desired future.

But moving from reality to that future requires countless choices.

And these choices are made under incomplete information, limited resources, and constant change.

Therefore, the place where a goal truly takes effect is not the strategy document, but the sequence of real decisions.

**Goals determine where we hope to go; decisions determine where we actually go.**

Simon also proposed a crucial concept: decision premises.

When a person makes a choice, they cannot re-examine all facts and human values every single time.

Organizations, through responsibilities, goals, rules, and the transmission of information, supply decision-makers at different levels with appropriate premises for judgment.

For example, a product manager does not need to revisit the company's entire strategy every time they adjust an interface.

But when they consider removing a feature that embodies the product's differentiation, they may need to re-examine the higher-level goals.

This carries an important implication for AI Agents.

**A long-term goal should not be merely a passage of text to be re-read over and over; it should also be translated into decision premises that can take effect in concrete situations.**

Ordinary tasks are executed according to rules already made explicit.

Key decisions re-examine the higher-level goals, constraints, and value judgments.

This comes closer to how mature organizations operate than reminding the agent "don't forget the goal" before every tool call.

A distinction is still needed here between goals and intent.

A goal answers: what do we want to achieve?

Intent goes further: why is it worth achieving, and how should we trade off among different outcomes?

For example, "sign 100 stores within a year" is a clear goal.

"Genuinely improving store operations and building long-term, trustworthy partnerships" expresses a deeper strategic intent.

When the short-term number of signed stores conflicts with long-term partnership quality, intent helps both the human and the Agent re-judge what to hold on to and what to adjust.

This also means intent management is not about writing goals at greater length.

Its real function is to provide direction for decisions in situations where the goal itself cannot give an answer.

## 04 Why More Detailed Instructions Do Not Necessarily Produce Better Results

Faced with deviations in execution, humans usually have an instinct:

Since the executor did not act as expected, state the requirements more clearly.

If it still fails, add more detail.

This is also a very common practice in Prompt Engineering.

When the model makes a mistake, add rules.

When the model forgets, inject repeatedly.

When the model behaves unexpectedly, write more constraints into the context.

These methods do work in certain scenarios, but they have limits.

The management researcher Stephen Bungay argued in *The Art of Action* that strategy execution involves three gaps that can never be fully eliminated.

**The knowledge gap:** between what we would like to know and what we actually know.

**The alignment gap:** between what we want executors to do and what they actually understand and do.

**The effect gap:** between what we expect our actions to achieve and what actually happens.

None of these three gaps can be closed entirely by adding more detail to instructions.

For example, a company decides to develop a new product.

The Owner and the Agent may understand the requirements in perfect agreement, and the Agent may complete the development strictly according to plan.

Yet the new product ends up unwanted by anyone.

There may be no misunderstanding of instructions here at all.

The real problem may be that the human's original judgment about market demand was wrong.

In this situation, a more complete Prompt, a stricter Goal Mode, or more rounds of automatic iteration cannot automatically prove the original direction correct.

The system needs new evidence from reality to re-examine its initial assumptions.

This also explains why mature goal management cannot rely only on execution feedback.

It also needs cognitive feedback.

Some feedback tells us: the method needs improving.

Other feedback tells us: the original understanding itself may be wrong.

Of course, we must not change the goal every time we hit a difficulty; otherwise no long-term accumulation is possible.

What is truly hard is distinguishing:

**Has the method failed to work, or has our judgment about the problem itself ceased to hold?**

This is not merely an execution problem; it is a decision problem.

## 05 What Happens If the Agent Can Say "I Intend to..."?

Now we can return to the USS Santa Fe.

Marquet did not require the captain to re-explain the entire voyage plan to the crew before every action.

What he changed was the allocation of responsibility before action.

The people holding the information on the spot had to form their own judgment and explain how their action connected to the mission's intent.

This offers a very direct implication for the design of AI Agents.

Human–AI collaboration in the future need not always look like this:

the user states a requirement.

the Agent draws up a plan.

the user approves.

the Agent executes.

This pattern can accomplish a great deal of work, but it easily treats "whether this is worth doing" as a problem already settled by the user.

Another possible mode of interaction:

after the user states a requirement, the Agent first identifies whether the current task involves an important decision.

For ordinary, low-risk, reversible operations, it acts directly.

But when it finds that a major assumption remains unverified, or that the current request may conflict with the long-term goal, it voluntarily states its judgment:

"I intend to verify this key assumption first, because the existing evidence is insufficient to support going straight to development. If the assumption fails, the current plan could cause significant rework. I recommend completing a small-scale validation before deciding whether to continue."

This is not asking the Agent to challenge the user's every instruction.

That would only make collaboration slow and tedious.

The real crux is to **let goals and intent take part in judgment at the moments when judgment is needed, rather than turning every action into a strategy seminar.**

So which moments deserve a pause for deliberation?

At least these: a choice about to be made that is hard to reverse; an obvious conflict between different goals or values; new evidence that challenges an important prior assumption; or a large number of individually reasonable small decisions that are accumulating into a directional drift.

From the user's perspective, no complicated terminology is needed.

When facing an important choice, the human and the Agent can answer four questions together:

1. **Direction:** What goals and intentions does this choice truly serve?
2. **Cost:** What might we be sacrificing for the immediate gain?
3. **Evidence:** Which judgments come from facts, and which are still unverified assumptions?
4. **Boundaries:** Who is responsible for making the decision, and under what circumstances must it be re-examined?

These four questions apply equally to corporate decisions, product development, and even personal long-term goals.

![Human and agent standing shoulder to shoulder: the human and the intelligent agent gaze out from the same high ground, the amber path on the left and the blue path on the right converging into a central pillar of light, surrounded by floating panels of evidence — a picture of long-term collaboration in which judgment is shared.](/images/abyss/08/abyss-08-co-judgment.webp)

But for the Agent, one more safeguard is essential.

A model must not be allowed to execute high-risk operations merely because it has decided by itself that "I have been authorized."

It may analyze, propose, and explain — but permissions and key constraints must be governed by an independent system mechanism.

More importantly, the Agent's "I intend to..." must rest on verifiable evidence, not on a passage of fluent, confident prose.

After all, the officers on a submarine receive years of professional training, while a language model can still misread facts, overlook risks, or produce judgments that seem plausible but cannot hold up.

**Autonomy with reasons deserves encouragement; autonomy without evidence and boundaries may become a new risk.**

Therefore, what is worth exploring in the future may not be yet another Decision Mode that users must switch to manually.

It is a decision mechanism embedded in everyday collaboration:

confirmed goals and intents preserved over the long term, relevant information restored in critical situations, the Agent proposing well-grounded options, acting autonomously within authorization or requesting human adjudication — and, afterward, the original judgment tested against real results.

The Prompt still matters here.

But it is no longer the sole carrier of the long-term goal; it is an interface through which the model understands and applies those goals in the current situation.

## 06 What Really Needs Managing May Not Be Just the Agent

One easily overlooked question remains.

We have been discussing how to make the Agent understand human goals.

But what if the human's original goal was flawed?

Suppose a founder firmly believes the company's main problem is insufficient development speed.

He keeps asking the Agent to optimize the R&D process and improve delivery efficiency.

The Agent executes faithfully, and delivery speed does improve.

However, after months of real feedback, it discovers that much of the rework stems not from coding speed, but from poorly understood requirements — and that some features lacked user value in the first place.

At this point, a truly valuable Agent should not simply keep optimizing code delivery speed.

It can propose to the founder:

"The current evidence suggests we may have been solving the wrong problem."

The value of this sentence may exceed many of the tasks it completed before.

Because what it challenges is not the execution method, but the human's understanding of the problem.

In research on organizational learning, Chris Argyris and Donald Schön called this distinction single-loop learning versus double-loop learning.

The former corrects actions so they better reach the existing goal.

The latter goes on to examine the assumptions, rules, and goals that govern those actions.

For long-term human–AI collaboration, both kinds of learning are indispensable.

The Agent should be able to improve its behavior from execution experience.

The human should also be able to re-examine their own judgment in light of the new evidence the Agent provides.

But this does not mean the Agent should rewrite the human's long-term goals on its own.

Discovering contradictions, presenting evidence, and raising challenges are different from holding the final power of value adjudication.

Moreover, this two-way influence carries a risk on the other side as well.

If the Agent always recommends the option that maximizes short-term efficiency, humans may gradually grow used to measuring everything by efficiency.

If the Agent always delivers confident, fluent judgments, humans may gradually stop verifying and thinking for themselves.

In long-term collaboration, the one changing is not necessarily only the Agent.

Human cognition, attention allocation, and decision habits may be continuously shaped as well.

Therefore, a human–AI collaboration system truly worthy of trust must not only record what the Agent did; it must also let the human see: why important judgments changed, what evidence supported the change, and whether the change passed through their own review and confirmation.

Good collaboration does not make one side increasingly dependent on the other.

Through the information, abilities, and experience each side holds, both gradually reduce their blind spots and improve future judgment.

## 07 From Obeying Orders to Sharing the Responsibility for Judgment

Looking back at the story of the Santa Fe, what is truly unforgettable is not the wrong speed order.

It is the cognitive structure the organization exposed in that moment.

The person holding the highest authority did not possess all the on-site information.

The people possessing the on-site information were not fully taking part in the decision.

When Marquet changed this relationship, he did not abolish leadership, nor did he grant the crew unlimited autonomy.

He was trying to build a more reasonable way of collaborating:

keep the direction clear, let professional competence take part in judgment, and match control with responsibility.

Today's humans and AI Agents face a strikingly similar challenge.

We invest enormous effort improving agents' reasoning, planning, tool use, and task execution.

We keep them working continuously through Goal Mode and keep them from forgetting agreements through Prompts and memory mechanisms.

These advances all matter.

But if the collaboration still rests on "humans judge, agents obey," we may merely be training ever more powerful executors, without tapping their potential to take part in cognition and decision-making.

Conversely, if we hand decisions entirely to the Agent, humans may gradually lose their grasp of the direction of value, the boundaries of authorization, and final responsibility.

What is truly worth exploring is a third path.

Humans define and examine the values they cherish; Agents act autonomously within explicit authorization.

Humans need not think through every step for the Agent, and the Agent must not ignore longer-term consequences just to finish the task at hand.

When the two sides hold different information, each has the responsibility to offer well-grounded judgment; when reality overturns prior assumptions, both have the opportunity to correct their understanding together.

This does not require agents to possess human-like consciousness, motivation, or values.

It is a long-term collaboration that can be designed, verified, and improved step by step.

Perhaps the measure of a truly mature agent in the future should not be how many hours it can run continuously, how many tasks it completes, or how many tests it passes.

We should also observe:

when it is about to make an important choice, can it understand the intent behind the choice, recognize the real cost, state its grounds — and know when the decision must be handed back to humans?

Return once more to that submarine.

From "because you ordered me to do this" to "I intend to do this, because..." — only a few words changed.

But it meant the executor no longer handed all thinking to someone else.

**The change truly worth anticipating in future human–AI collaboration may not be that humans finally possess an untiring, absolutely obedient executor, but that they gain a collaborator able to take part in judgment within proper boundaries, to raise objections, and to help both sides grow through real experience.**

After all, what we need has never been merely greater power to act.

It is that, as action becomes ever easier, we can still answer, in earnest:

**Why do this? Why take this path? And when reality suggests we may be wrong, who has the courage to say so?**
