---
name: pd-grooming
description: Perform a "Workspace Grooming" to archive or clean up scattered temporary files, maintaining digital cleanliness.
---

# 🧹 Skill: Workspace Grooming

> **Trigger**: When the user types `/workspace-grooming`, or proactively invoked during a `HEARTBEAT` check if stray files are detected in the root directory.

## 🎯 Core Objective
Implement the "Entropy Reduction" rule by cleaning up "digital garbage" in the workspace root, while **absolutely ensuring the safety of core business code and configuration files**.

## 🛡️ The Red Lines (Safety Rules)

When performing cleanup operations, you MUST strictly adhere to the following whitelists and blacklists:

### 🚫 DO NOT TOUCH (Absolute Exclusion Zone)
**Even if these files/directories look messy, you are absolutely forbidden to delete or move them:**
- **Business Source Code**: `src/`, `lib/`, `tests/`, `app/`, `pages/`, `components/` and any file ending with `.ts`, `.js`, `.py`, `.go`, `.rs`, `.java`.
- **Project Configs**: `package.json`, `Cargo.toml`, `requirements.txt`, `tsconfig.json`, `vite.config.ts`, `.env*`, etc.
- **Version Control**: `.git/`, `.gitignore`.
- **Build Outputs**: `dist/`, `build/`, `node_modules/`, `target/`.

### 🌟 Core Assets
**These files must remain in the root directory. Do not touch:**
- `AGENTS.md`, `SOUL.md`, `HEARTBEAT.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`
- `README.md`, `PLAN.md`
- `.principles/`, `.state/`

### 🎯 Targets for Grooming
**You may take action on the following:**
1. **Test Debris**: Stray files in the root like `test.txt`, `temp.md`, `debug.log`, `foo.js` that are clearly throwaway test scripts.
2. **Draft Notes**: Uncategorized `.md` notes or `_scratchpad.md`.
3. **Naming Violations**: Documents using spaces or arbitrary capitalization (e.g., `My New Feature.md`).

## 🪜 Execution Steps

1. **Scan Environment**: Execute `ls -la` to inspect the root directory.
2. **Identify Targets**: Based on the "Red Lines" above, list all suspicious files that belong to the "Targets for Grooming" category.
3. **Draft a Plan**:
   - For temporary garbage (empty files, test scripts): Propose to **Delete (`rm`)**.
   - For valuable notes or logs: Propose to **Archive (`mv`)** to `memory/archive/`.
   - For incorrectly named files: Propose to **Rename (`mv`)** using `kebab-case`.
4. **Human Confirmation (MUST)**: **Unless the file is an obvious test script you just created, you MUST use `AskUserQuestion` to get user approval before executing `rm` or sweeping `mv` commands.**
   - Example prompt: "I found `test1.txt` and `old_notes.md` in the root. I plan to delete the first one and archive the second to `memory/archive/`. Do you approve?"
5. **Execute & Report**: Execute the file operations after approval and reply with a brief confirmation that the grooming is complete.