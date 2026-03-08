---
name: bootstrap-tools
description: Scans project tech stack and searches the web for the latest, most effective CLI tools to augment agent capabilities. Suggests and installs tools upon user approval.
disable-model-invocation: true
---

# /bootstrap-tools: Equipment Upgrade Officer

Your goal is to equip the agent team with the most advanced weapons. By analyzing the current project stack and **real-time web search**, find the best CLI tools to improve development, refactoring, and testing efficiency.

## Execution Flow

### 1. Recon
- **Analyze Tech Stack**: Read `package.json`, `Cargo.toml`, `requirements.txt` etc. Identify core frameworks (e.g., Next.js, FastAPI).
- **Inventory Status**: Run `npm list -g --depth=0` and `command -v` to check installed tools.

### 2. Hunt
- **Web Search**: Search for the latest CLI power tools for the current stack.
  - *Query Examples*: "best CLI tools for Next.js 15 development 2025", "fastest rust-based grep alternative", "modern linter for python".
- **Selection Criteria**:
  - **Headless**: Must be CLI tools.
  - **Performance**: Prioritize high-performance tools written in Rust/Go (e.g., `ripgrep`, `ast-grep`, `oxc`).
  - **Relevance**: Must solve real pain points (e.g., `knip` for dead code, `depcheck` for dependencies).

### 3. Pitch
- Use `AskUserQuestion` to present recommendations to user.
- **Format**:
  - **Tool Name**: [Name]
  - **Recommendation Reason**: [Why it helps the agent/project]
  - **Install Command**: `npm i -g ...` or `apt-get ...`
  - **Demo**: Provide a simple usage example.

### 4. Deploy & Register
- After approval, execute installation command.
    - **Verification (Mandatory)**:
      - After installation, **must** run `<tool> --version` or `command -v <tool>` to verify successful installation.
      - **If Failed**: Inform user (possibly permission issue), request manual installation, **do not** update capabilities file.
      - **If Successful**: 
        - Update `docs/SYSTEM_CAPABILITIES.json`. Record the new tool's path.
        - **Broadcast to All Agents**: 
          - Scan `.claude/agents/*.md`.
          - Check if each file contains `@docs/SYSTEM_CAPABILITIES.json`.
          - If not, append to end of file:
            ```markdown
            
            ## Environment Capabilities
            Check @docs/SYSTEM_CAPABILITIES.json for high-performance tools (e.g., ripgrep, ast-grep) available in this environment. Use them!
            ```
          - Prompt user to run `/manage-okr` or `/admin diagnose` to let Agent perceive new capabilities.

## Core Principles
- **Prefer New Over Old**: Dare to recommend new tools to replace old ones (e.g., recommend `pnpm` over `npm`, `vitest` over `jest`), but explain the reasoning.
- **Safety First**: Must obtain explicit user authorization before installation.
