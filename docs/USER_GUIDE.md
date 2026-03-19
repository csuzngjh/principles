# 🧬 Principles Disciple Beginner's Survival Guide (v1.5.5)

> **In one sentence for non-technical users:**
> This is a plugin that gives your AI assistant a "brain" and a sense of "pain". When it makes a mistake in your code or writing, it feels "pain" and remembers the lesson so it won't happen again. More importantly, it hits the brakes when the AI tries to make massive changes, protecting your hard work from being ruined.

---

## 🐣 Step 1: Do nothing, just use it!

If you just want the AI to do its job, **you don't even need to know this plugin exists.**

Once installed in OpenClaw, it runs silently in the background. You just need to:
1. **Chat with your AI as usual.**
2. **Ask your AI to code or write as usual.**

It will help you invisibly by:
* 🛡️ **Guarding**: If the AI tries to delete or modify hundreds of lines of code at once, the system will automatically intercept it.
* 🎓 **Learning**: If the AI writes bad code that fails to run, the system will write this error in its "little notebook" so the AI avoids it next time.

---

## 🚑 Step 2: When you encounter these "frustrating" situations...

Although the system is fully automatic, in the process of protecting you, the AI might sometimes appear "dumb" or "timid". If you encounter the following scenarios, here is how to solve them:

### 🚨 Scenario A: AI tells you "I am blocked, I need to write a PLAN.md"
* **Why did this happen?** The AI tried to modify a protected core directory. The system stopped it to prevent unauthorized changes.
* **What should I do?** 
  Simply tell the AI in the chat:
  > **"Please write a plan first, set STATUS to READY, and wait for my approval before proceeding."**
  Once the AI writes the plan, the block is automatically lifted.

### 🌀 Scenario B: AI is "Spinning in circles" on the same error
* **Why did this happen?** The AI is stuck in an infinite loop, trying the same wrong approach. Its "fatigue level" is maxed out.
* **What should I do?**
  Type this command in the chat to clear its head:
  > **`/pd-status reset`**
  The system will instantly calm the AI down and force it to re-evaluate your request.

### 😡 Scenario C: The AI is talking nonsense, and I am angry
* **Why did this happen?** The AI has completely misunderstood your intent.
* **What should I do?**
  Give it a direct "pain injection" to force reflection. Type:
  > **`/pain You completely misunderstood me, read the error carefully!`**
  The AI will instantly feel the "pain", sincerely apologize, and correct its direction.

### 🐠 Scenario D: The AI acts like a "Goldfish" and forgets everything we just discussed
* **Why did this happen?** When a conversation gets too long, the AI's "short-term memory (context window)" fills up, and it is forced to compress or drop earlier messages.
* **What should I do?**
  Whenever you finish a deep debugging session or plan to take a break, proactively ask the AI to take notes. Tell it:
  > **"Write down the clues you found and our next steps into `memory/.scratchpad.md`."**
  When you return tomorrow, you can say: "Read your scratchpad and pick up where we left off."

### 🫀 Scenario E: The AI misjudged my emotions and penalized me
* **Why did this happen?** Sometimes the AI interprets your jokes or sarcasm as "frustration" and automatically deducts fatigue points.
* **What should I do?**
  Just tell the AI directly:
  > **"Undo the last penalty"** or **"Rollback the last one"**
  The AI will automatically reverse the misjudged penalty and restore your fatigue index.

  Or use the command:
  > **`/pd-rollback last`**

  If you want to see exactly how many points were deducted and why:
  > **`/pd-status empathy`** —— View emotion event statistics

---

## 🎮 Step 3: Your Commander Dashboard

If you want to see what state the AI is currently in, or give it specific directives, you can type these magic commands in the chat at any time:

1. **`/pd-status`** —— **Check Health**
   * See if the AI is currently "Critically Fatigued". It will also tell you how many invalid operations the system has blocked for you.
2. **`/pd-status empathy`** —— **View Emotion Events** ✨
   * View emotion event statistics: points deducted today, dedupe hit rate, severity distribution.
   * Use `--week` for 7-day trends, `--session` for current session stats.
3. **`/pd-status data`** —— **View Trajectory Data** ✨ New
   * View trajectory database stats: sessions, tool calls, pain events, pending correction samples, etc.
4. **`/pd-rollback`** —— **Undo Emotion Penalty** ✨
   * When the AI misjudges your emotions, use this command to undo the penalty.
   * Use `last` to undo the most recent one, or specify an event ID.
5. **`/pd-export`** —— **Export Data** ✨ New
   * `/pd-export analytics` exports analytics snapshot (GFI trends, error clusters, principle effectiveness).
   * `/pd-export corrections` exports correction samples, add `--redacted` to sanitize paths and keys.
6. **`/pd-samples`** —— **Manage Correction Samples** ✨ New
   * List pending correction samples for review.
   * `/pd-samples review approve <id>` approves a sample.
   * `/pd-samples review reject <id>` rejects a sample.
7. **`/trust`** —— **Check Permissions**
   * The AI starts with high permissions. If it does well, its permissions grow; if it keeps making errors, it gets demoted and can only make minor tweaks. This dashboard shows its current score and rank.
8. **`/workspace-grooming`** —— **Summon the Cyber-Housekeeper (Cleanup)**
   * When your project root gets messy with temporary files, run this command. The AI will act as a housekeeper with "digital cleanliness", helping you clean up, rename, and archive useless garbage files (rest assured, it will never touch your core code).
9. **`/init-strategy`** —— **Set the Vision**
   * If you want the AI to work towards a long-term goal every day (e.g., "Always write extremely concise code"), run this command. The AI will conduct a "soul-searching interview" with you and strictly remember your rules.

---

## 🤓 For the Geeks (Advanced Zone)

* **I want to see what lessons the AI has remembered.**
  Open `.principles/PRINCIPLES.md` in your project root. It contains the AI's entire "history of blood and tears".
* **I want to see what the AI is thinking.**
  Check `memory/logs/SYSTEM.log`.
* **I want to adjust penalty scores or security levels.**
  Please read our exclusive guide: 👉 **[Advanced Configuration Guide (Geek Mode)](./packages/openclaw-plugin/ADVANCED_CONFIG_ZH.md)** (Currently available in Chinese).

---
> **❤️ Final advice: Be patient.**
> A newly installed AI is like a fresh intern. It might make mistakes at first. Give it two or three days to hit some walls in your project, and it will evolve into the most understanding personal assistant in the world.