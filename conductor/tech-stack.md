# Principles Disciple: Technology Stack

## 1. Programming Languages
- **TypeScript**: The primary language for the native OpenClaw plugin, providing strong typing and modern asynchronous features.
- **Python**: Leveraged for background daemons, evolutionary logic scripts, and complex data processing.
- **Bash (Shell)**: Essential for system-level installation, environment bootstrapping, and high-performance pre-execution hooks.

## 2. Frameworks and Platforms
- **OpenClaw (Native Plugin System)**: Utilized for its robust hook ecosystem, allowing deep interception of LLM input/output and tool calls.
- **Claude Code**: Integrated via a rule-based scaffold that manages principles through local file-system hooks.

## 3. Testing and Build Tools
- **Vitest**: Provides fast, concurrent testing for TypeScript logic with built-in mocking capabilities.
- **TSC (TypeScript Compiler)**: Manages the transpilation of modern TypeScript into executable JavaScript for the OpenClaw environment.
- **Standard Linux Utilities**: Heavy reliance on `rg` (ripgrep), `sed`, and `grep` for efficient file-system scanning and auditing.
