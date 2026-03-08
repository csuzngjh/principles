---
name: watch-evolution
description: Start the background evolution daemon to process queued tasks from EVOLUTION_QUEUE.json.
---

# /watch-evolution: Background Evolution Guardian

**Goal**: Start a continuously running process to automatically analyze and fix backlog code issues.

## 1. Environment Preparation
- Ensure `evolution_mode: "async"` is configured in `docs/PROFILE.json`.
- Ensure `docs/EVOLUTION_QUEUE.json` exists.

## 2. Startup Command
Run the following command to start the daemon:

```bash
python scripts/evolution_daemon.py
```

## 3. Workflow
1. **Auto Scan**: Scan `docs/EVOLUTION_QUEUE.json` every 30 seconds.
2. **Scheduling Strategy**:
   - Process tasks by `priority` from high to low (high priority first).
   - Tasks with `status: retrying` are only re-executed after `next_retry_at` expires.
   - Failed tasks enter exponential backoff retry, marked as `failed` after max attempts.
3. **Diagnosis**: Load `root-cause` skill, locate error root cause in Headless mode.
4. **Fix**: Load fix skill, automatically modify code and run tests.
5. **Log**: Call `reflection-log` to store experience in `PRINCIPLES.md` and `ISSUE_LOG.md`.
6. **Dashboard**: Real-time update of `docs/EVOLUTION_PRD.md` showing progress.

## 4. Exit
- Press `Ctrl+C` to stop background task. Task state will be preserved in JSON, can continue on next startup.
