# Ray Dalio Disciple - Quick Start Guide
## Everything You Need to Know

**Core Philosophy**: Use Claude Code as usual, let the system handle the rest

---

## 🎯 Three-Minute Setup

### What You Need to Do (Only 3 Steps)

```bash
# 1️⃣ Install dependencies
sudo apt-get install jq  # Linux/WSL
brew install jq          # macOS

# 2️⃣ Clone project
git clone <your-repo>
cd principles

# 3️⃣ Start using
claude  # That's it!
```

**That's all!** The system will work automatically in the background.

---

## 📖 Daily Usage (Most Important)

### ✅ Normal Situation: You Don't Need to Do Anything

```bash
# Just talk to Claude normally
claude> Help me write a function to parse JSON
# ✅ System automatically: checks → passes → executes → done
# ✅ You see: the code result
```

**System's automatic operations** (you don't need to care):
- ✅ Automatically checks if file path is safe
- ✅ Automatically records operations to logs
- ✅ Automatically runs tests (if configured)
- ✅ Automatically generates audit logs

### ⚠️ When You Need to Cooperate (System Will Clearly Prompt)

#### Situation 1: Modifying Dangerous Files

```bash
claude> Help me modify infra/config.yaml

🤔 System: Wait! This file is dangerous
❌ Blocked: risk edit requires docs/PLAN.md

📝 What you need to do:
1. Tell Claude: "Enter Plan Mode"
2. Claude will automatically create a plan
3. After you review and approve
4. Claude automatically executes
```

#### Situation 2: Previous Task Failed

```bash
claude> Help me fix login bug

⚠️ System shows at startup:
⚠️ Unhandled pain flag detected
⚠️ Suggestion: Resolve previous failure first

📝 What you need to do:
1. Tell Claude: "Check pain flag"
2. Claude will show what failed last time
3. Decide whether to continue or abandon
4. Auto-cleanup after resolution
```

#### Situation 3: Tests Failed

```bash
claude> After code modifications...

❌ Post-write checks failed
❌ Pain flag written to docs/.pain_flag

📝 What you need to do:
1. Tell Claude: "Check test failure"
2. Claude will fix the issue
3. Auto-cleanup pain flag after tests pass
```

---

## 🔄 Complete Example: Fix a Bug

See what actual usage looks like:

```bash
# === Scenario: Login Failure ===

$ claude

👤 You: Users report login failures, please check

🤖 Claude: Sure, let me analyze the issue
        [Auto-read logs, check code]
        Found: Session timeout config missing

👤 You: How to fix?

🤖 Claude: Need to modify src/auth/session.py
        This file is in risk path
        Need to create a plan

👤 You: Then create a plan

🤖 Claude: [Auto-enter Plan Mode]
        Plan generated:
        - Add session timeout config
        - Update login verification logic
        - Add unit tests

👤 You: Looks good, execute

🤖 Claude: [Auto-executes]
        Modifications complete ✅
        Tests passed ✅ 12/12
        Pain flag cleaned ✅

👤 You: Thanks!
```

**What you did**:
- ✅ Describe the problem
- ✅ Approve the plan
- ✅ Confirm execution

**What system did automatically** (you don't need to care):
- ✅ Detect risk path
- ✅ Generate audit
- ✅ Execute plan
- ✅ Run tests
- ✅ Record logs
- ✅ Cleanup markers

---

## 🎓 Core Concepts (Simplified)

### Three "Automatics" of the System

| Automatic What | Why | Do You Need to Care? |
|----------------|-----|---------------------|
| **Auto Check** | Prevent breaking important files | ❌ No |
| **Auto Record** | Log all operations | ❌ No |
| **Auto Cleanup** | Remove markers on success | ❌ No |

### Three "Prompts" You Might Encounter

| Prompt | Meaning | What You Do |
|--------|---------|-------------|
| "Blocked: Need PLAN" | This change is dangerous | Let Claude create plan |
| "Pain Flag Exists" | Previous task incomplete | Let Claude resolve first |
| "Tests Failed" | Code has issues | Let Claude fix |

---

## 📊 System Architecture (You Don't Need to Understand Details)

```
┌─────────────────────────────────────────┐
│      Your Daily Work Area               │
│  (Normal conversation with Claude)       │
└─────────────────────────────────────────┘
           ↓
┌─────────────────────────────────────────┐
│   System Auto-runs in Background        │
│         (You Don't See It)               │
│                                         │
│  🛡️ Risk Check: Modifying dangerous?    │
│     → Yes → Prompt you for plan         │
│     → No → Continue                     │
│                                         │
│  📝 Audit Record: Log all operations    │
│  🧪 Auto Test: Run tests (if configured)│
│  🧹 Auto Cleanup: Remove markers       │
└─────────────────────────────────────────┘
```

**Key point**: You don't see these, they happen automatically. You only respond when prompted.

---

## 🚨 Common Scenarios (What You Might Encounter)

### Scenario 1: Modify Normal Files (Most Common)

```bash
👤 You: Modify README.md
🤖 Claude: Sure [modifies directly]
✅ Done
```

**Your experience**: Same as using Claude normally, no difference.

---

### Scenario 2: Modify Dangerous Files (Occasional)

```bash
👤 You: Modify infra/config.yaml
🤖 Claude: This file is dangerous, need a plan
👤 You: OK, create plan
🤖 Claude: [Plan generated]
👤 You: Execute
🤖 Claude: [Execution complete]
✅ Done
```

**Your experience**: One extra confirmation, otherwise same.

---

### Scenario 3: Previous Failure (Rare)

```bash
$ claude

⚠️ System prompt: Pain flag detected
⚠️ Suggestion: Resolve previous failure first

👤 You: OK, resolve it first
🤖 Claude: [Auto-handles]
✅ Cleaned, can continue
```

**Your experience**: System reminds you, you agree, system resolves.

---

## 💡 Usage Tips (Remember These Three)

### 1️⃣ Use Normally, Don't Overthink

```bash
# ✅ Right mindset
"I'll use Claude as usual, system will protect me"

# ❌ Wrong mindset
"I need to understand how system works before using"
```

### 2️⃣ Respond to Prompts

```bash
# ✅ System: "Need PLAN"
→ You say: "OK, create plan"

# ✅ System: "Tests failed"
→ You say: "Fix it"

# ✅ System: "Pain flag exists"
→ You say: "Resolve it first"
```

### 3️⃣ Trust System Protection

```bash
# System says dangerous → Then create plan
# System says failed → Then fix it first
# System says passed → Then use confidently
```

---

## 🔧 Configuration (Set Once, Works Forever)

### Basic Configuration (Recommended)

Edit `docs/PROFILE.json`:

```json
{
  "risk_paths": ["infra/", "db/", "prod/"],
  "gate": {
    "require_plan_for_risk_paths": true
  }
}
```

**Effect**: Tell system which directories are dangerous

**What you do**:
1. Add directories you consider dangerous to `risk_paths`
2. Save file
3. Done! System will auto-protect these directories

### Advanced Configuration (Optional)

```json
{
  "tests": {
    "commands": {
      "smoke": "npm test --silent"
    }
  }
}
```

**Effect**: Auto-run tests after file modification

**What you do**: Change a command, rest is automatic.

---

## ❓ FAQ

### Q1: Do I need to understand how the system works?

**A**: No! Just use Claude as usual, the system protects you in background.

### Q2: Do I need to manually run any scripts?

**A**: No! All automation scripts are auto-triggered by Claude Code.

### Q3: Do I need to view those log files?

**A**: No! Unless you want to troubleshoot. System auto-manages logs.

### Q4: Will the system be annoying?

**A**: No!
- ✅ 90% of time: System works silently
- ⚠️ 10% of time: System prompts you
- ❌ 1% of time: System blocks you (dangerous ops)

### Q5: Can I bypass system checks?

**A**:
- Normal files: Yes, system doesn't check
- Dangerous files: No, must follow process (this protects you)

### Q6: What if system fails?

**A**:
```bash
# System leaves pain flag
# Next startup reminds you
# You just say: "Resolve it"
# Claude auto-handles
```

---

## 📚 Further Reading (Optional)

If you want to learn more:

- 📖 **Complete User Guide**: `docs/USER_GUIDE_EN.md`
- 🔧 **DEBUG Mode**: `docs/DEBUG_HOOKS_USAGE.md`
- 🛡️ **Code Quality**: `docs/SHELLCHECK_GUIDE.md`
- 📊 **System Review**: `docs/CLAUDE_CODE_MASTER_REVIEW.md`

**But remember**: None of these are necessary to understand. You just use Claude as usual.

---

## 🎉 Summary

### Your Workflow

```
1. Start Claude
   ↓
2. Normal conversation
   ↓
3. If prompted → respond to prompt
   ↓
4. Done
```

### System Workflow (You Don't See)

```
1. Monitor your operations
   ↓
2. Check if dangerous
   ↓
3. If dangerous → prompt you
   ↓
4. Log all operations
   ↓
5. Auto-cleanup markers
```

### Core Principle

> "You focus on solving problems, system handles protection"

---

## 💬 Final Words

This system's design philosophy:

- ✅ **Doesn't change your workflow**
- ✅ **Doesn't increase cognitive load**
- ✅ **Only prompts when necessary**
- ✅ **Auto-handles everything automatable**

**You don't need to**:
- ❌ Understand agent mechanism
- ❌ Manually run scripts
- ❌ View log files
- ❌ Remember complex processes

**You only need to**:
- ✅ Use Claude as usual
- ✅ Respond when prompted
- ✅ Trust system protection

**It's that simple!** 🎉

---

**"System automates everything automatable, only lets users do decisions that must be made by humans."**

**Author Note**: This is the user view of Ray Dalio Disciple system. If you're curious about internal workings, read `USER_GUIDE_EN.md`. But remember: Understanding internal mechanisms is not a prerequisite for using the system.
