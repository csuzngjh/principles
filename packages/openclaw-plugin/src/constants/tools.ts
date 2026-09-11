export const READ_ONLY_TOOL_NAMES = [
  'read', 'read_file', 'read_many_files', 'image_read',
  'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
  'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'ref_search_documentation', 'ref_read_url',
  'resolve-library-id', 'get-library-docs',
  'memory_recall', 'save_memory', 'todo_read', 'todo_write',
  'ask_user', 'ask_user_question',
  'pd-status', 'report',
] as const;

/**
 * PRI-741 declaration correction: this list is the OpenClaw HOST layer of the
 * tool semantic registry, so it may only contain names the OpenClaw hook
 * actually dispatches (evidence: OpenClaw tool-mutation-names.ts — the file
 * mutation family is exactly write/edit/apply_patch). Generic LLM vocabulary
 * names (write_file/edit_file/replace/insert/patch) are NOT OpenClaw tools;
 * declaring them made `hasHostTool` pass for rules that can never fire.
 */
export const LOW_RISK_WRITE_TOOL_NAMES = [
  'write', 'edit', 'apply_patch',
] as const;

// OpenClaw's shell tool is `exec` (hook-face canonical id); `bash`,
// `run_shell_command`, `execute`, `shell`, `cmd` are config-level aliases
// that normalize to exec and never reach the hook payload.
export const BASH_TOOL_NAMES = [
  'exec',
] as const;

// OpenClaw has no dedicated delete/move file tools — destructive file
// operations arrive as exec (shell) commands.
export const HIGH_RISK_TOOL_NAMES = [
  ...BASH_TOOL_NAMES,
] as const;

export const AGENT_TOOL_NAMES = [
  'sessions_spawn',
] as const;

export const CONTENT_LIMITED_TOOL_NAMES = [
  ...LOW_RISK_WRITE_TOOL_NAMES,
] as const;

export const CONSTRUCTIVE_TOOL_NAMES = [
  ...LOW_RISK_WRITE_TOOL_NAMES,
  // Include all BASH aliases for consistent constructive classification
  ...BASH_TOOL_NAMES,
  ...AGENT_TOOL_NAMES,
] as const;

export const EXPLORATORY_TOOL_NAMES = [
  ...READ_ONLY_TOOL_NAMES,
] as const;

export const READ_ONLY_TOOLS = new Set<string>(READ_ONLY_TOOL_NAMES);
export const LOW_RISK_WRITE_TOOLS = new Set<string>(LOW_RISK_WRITE_TOOL_NAMES);
export const HIGH_RISK_TOOLS = new Set<string>(HIGH_RISK_TOOL_NAMES);
export const BASH_TOOLS_SET = new Set<string>(BASH_TOOL_NAMES);
export const AGENT_TOOLS = new Set<string>(AGENT_TOOL_NAMES);
export const CONTENT_LIMITED_TOOLS = new Set<string>(CONTENT_LIMITED_TOOL_NAMES);
export const CONSTRUCTIVE_TOOLS = new Set<string>(CONSTRUCTIVE_TOOL_NAMES);
export const EXPLORATORY_TOOLS = new Set<string>(EXPLORATORY_TOOL_NAMES);
export const WRITE_TOOLS = new Set<string>([
  ...LOW_RISK_WRITE_TOOL_NAMES,
]);

