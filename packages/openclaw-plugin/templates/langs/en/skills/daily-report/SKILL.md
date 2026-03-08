---
name: daily-report
description: Configure and send daily evolution reports (supports email/IM/voice notifications)
disable-model-invocation: true
---

# Evolution Daily Report

This skill enables the agent to help users configure and automatically send daily evolution reports, allowing users to perceive the system "improving every day."

## Execution Principles

1. First run must confirm requirements with the user
2. User preferences are stored in `{stateDir}/daily-report.md`; skip collection if exists
3. Use OpenClaw's cron tool to create scheduled tasks
4. Autonomously select available delivery channels

---

## Flow

### Step 1: Check Configuration File

Read `{stateDir}/daily-report.md`:
- **Exists** → Check cron task status, execute report generation
- **Not exists** → Enter requirement collection flow

### Step 2: Requirement Collection (First Run)

Ask through conversation:

1. **Enable evolution daily report?**
2. **Send time?** (Default: 9:00 daily)
3. **Timezone?** (Default: Asia/Shanghai)
4. **Delivery channel?**
   - Email → Need email address
   - WhatsApp/Telegram → Need phone number/User ID
   - Discord/Slack → Need channel ID
   - Voice notification → Need phone number
5. **Report style?** (See "Style Options" below)
6. **Content preferences?** Select which modules to include

### Step 3: Create Configuration File

Write user preferences to `{stateDir}/daily-report.md`:

```markdown
# Daily Report Configuration

## Basic Info
- Status: enabled
- Created: {date}

## Send Settings
- Send time: 09:00
- Timezone: Asia/Shanghai
- Cron expression: 0 9 * * *

## Delivery Channel
- Channel: whatsapp
- Target: +8613800138000

## Report Style
- Style: standard
- Language: en

## Content Preferences
- Growth highlights: yes
- Pain signals: yes
- Trend comparison: yes
- Insights: yes

## Cron Task
- jobId: {filled after creation}
```

### Step 4: Create Cron Task

Use cron tool:

```json
{
  "action": "add",
  "job": {
    "name": "evolution-daily-report",
    "schedule": { "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" },
    "sessionTarget": "isolated",
    "payload": {
      "kind": "agentTurn",
      "message": "Execute daily report skill: read log data, generate report and send"
    },
    "delivery": { "mode": "announce", "channel": "whatsapp", "to": "+8613800138000" }
  }
}
```

### Step 5: Report Generation (Scheduled or Manual Trigger)

1. Read data sources
2. Calculate evolution metrics
3. Generate Markdown based on user style
4. Send report

---

## Data Sources

| Data | Path | Description |
|------|------|-------------|
| Daily stats | `{stateDir}/logs/daily-stats.json` | Aggregated data |
| Raw events | `{stateDir}/logs/events.jsonl` | Detailed audit |
| Pain rules | `{stateDir}/pain_dictionary.json` | Rule count |
| User config | `{stateDir}/daily-report.md` | Preferences |

---

## Style Options

Ask user preference during requirement collection:

| Style | Features | Suitable For |
|-------|----------|--------------|
| **Concise** | 3-5 core metrics, 1 min read | Busy users |
| **Standard** | Full metrics + trend comparison, 5 min read | Default recommendation |
| **Detailed** | Full data + analysis suggestions, 15 min read | Data enthusiasts |
| **Humorous** | Casual tone + emoji style | Casual users |
| **Visual** | ASCII charts + progress bars | Visual learners |

---

## Evolution Metrics Elements

### Growth Highlights (Positive)

| Metric | Data Source | Progress Signal |
|--------|-------------|-----------------|
| Rules learned | `pain_dictionary.json` rule count | System learned to identify new error patterns |
| Rules promoted | `DailyStats.pain.candidatesPromoted` | L3 semantic detection → formal rule |
| Evolution tasks completed | `DailyStats.evolution.tasksCompleted` | Self-improvement completed |
| GFI peak decrease | `DailyStats.gfi.peak` MoM | Less friction, more stable |
| Success rate increase | `DailyStats.toolCalls.success/total` | Smoother execution |

### Health Monitoring (Warnings)

| Metric | Data Source | Warning Signal |
|--------|-------------|----------------|
| Pain signal count | `DailyStats.pain.signalsDetected` | How many error patterns detected |
| GFI peak hour | `DailyStats.gfi.hourlyDistribution` | When is most painful |
| Death spiral detection | fix/fail/error word frequency in git log | Stuck in fix loop |
| Queue health | Evolution queue status | Congested or not |

### Trend Comparison (Progress Perception)

| Metric | Calculation | Meaning |
|--------|-------------|---------|
| 7-day success rate trend | 7-day success/total change | Long-term stability |
| Pain signal weekly change | This week vs last week | Problems decreasing? |
| Rule growth rate | New rules this week | Learning speed |
| GFI average change | 7-day GFI average trend | Overall friction trend |

---

## Default Report Template

```markdown
# 🌱 Evolution Daily Report - {date}

## 📈 Today's Growth
- 🧠 Rules learned: {rules_promoted}
- ✅ Evolutions completed: {tasks_completed}
- 🎯 Success rate: {success_rate}% ({trend_emoji})
- 📉 GFI peak: {gfi_peak} ({gfi_trend})

## ⚡ Pain Signals
- Detections: {pain_count}
- Avg intensity: {avg_score}
- Top sources: {top_sources}

## 📊 Trend Comparison
- 7-day success rate trend: {success_trend}
- Pain signal weekly change: {pain_trend}

## 💡 Today's Insights
{insights}

---
📊 Source: Principles Disciple
```

---

## Manual Trigger

Users can run `/daily-report` anytime to manually generate and send today's report.
