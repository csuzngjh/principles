# Track Specification: Directory Architecture Refactor (Phase 4)

## 1. Overview
Restructure the Principles Disciple directory architecture within the OpenClaw workspace. This refactor aims to eliminate the "docs dumping ground" phenomenon, improve RAG (Retrieval-Augmented Generation) clarity, and establish a logical separation between Agent Identity, Execution State, and Human Documentation.

## 2. Functional Requirements
- **Identity & Governance**: Establish a hidden `.principles/` directory at the project root to store core configuration files:
    - `PROFILE.json`
    - `PRINCIPLES.md`
    - `THINKING_OS.md`
    - `00-kernel.md`
- **Execution State**: Establish a hidden `.state/` directory at the project root for volatile operational data:
    - `evolution_queue.json`
    - `WORKBOARD.json`
    - `AGENT_SCORECARD.json`
- **Workspace Visibility**: Move `PLAN.md` to the **Project Root** to ensure maximum visibility for human commanders and ease of access for the agent.
- **OpenClaw Compatibility**: Maintain core OpenClaw bootstrap files at the **Project Root** as required by the engine:
    - `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `USER.md`, `TOOLS.md`, `HEARTBEAT.md`
- **Doc Purification**: Reserve the `docs/` directory exclusively for project documentation. The agent is prohibited from creating internal analysis logs or state files here.
- **Auto-Migration**: Implement a migration logic in the plugin's `init` phase that automatically moves legacy files from `docs/` to their new homes on the first run after the update.

## 3. Technical Requirements
- Update all path references in `packages/openclaw-plugin/src/` (hooks, core services, utils).
- Update `install-openclaw.sh` templates and copy logic.
- Implement `src/core/migration.ts` to handle file relocation and symlink cleanup if necessary.

## 4. Acceptance Criteria
- [ ] Existing `docs/PROFILE.json` is automatically moved to `.principles/PROFILE.json`.
- [ ] Agent correctly intercepts writes to `.principles/` files based on the new Gatekeeper rules.
- [ ] `PLAN.md` is correctly read and written at the project root.
- [ ] No new internal agent files are generated in `docs/` during normal operation.
- [ ] OpenClaw continues to boot correctly using the root-level `AGENTS.md` and `SOUL.md`.

## 5. Out of Scope
- Changing the internal structure of `memory/logs` or `memory/pain`.
- Modifying the OpenClaw core engine path resolution.
