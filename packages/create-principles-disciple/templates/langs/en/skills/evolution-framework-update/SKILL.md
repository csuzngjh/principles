---
name: evolution-framework-update
description: Pull the latest updates for the Principles Disciple evolution framework (including Orchestrator mode, async queue, and map-first protocol).
---

# /evolution-framework-update: Evolution Framework Self-Update

**Goal**: Sync latest code from upstream framework (Hooks, Skills, Agents, Daemon) to maintain system evolution capability.

## 1. Execute Update
Run the following script to pull latest code:

```bash
bash scripts/update_agent_framework.sh
```

## 2. Conflict Handling (Smart Merge)
After script runs, check output:
- **No Conflict**: If shows "✅ Update complete", no action needed.
- **Conflict**: If shows "⚠️ Updates found with conflicts":
  1. Find all `.update` files:
     ```bash
     find .claude -name "*.update"
     ```
  2. For each conflicting file (e.g., `rules/00-kernel.md` vs `rules/00-kernel.md.update`):
     - **Read** original file and `.update` file.
     - **Analyze** differences: merge upstream new features, preserve local personalized config.
     - **Cleanup**: Delete `.update` file after merge.

## 3. Restart to Apply
After update completes, recommend restarting Session to load latest neural hub logic.
