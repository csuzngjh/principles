export const READ_ONLY_TOOL_NAMES = [
  'read', 'read_file', 'read_many_files', 'image_read',
  'search_file_content', 'grep', 'grep_search', 'list_directory', 'ls', 'glob',
  'lsp_hover', 'lsp_goto_definition', 'lsp_find_references',
  'web_fetch', 'web_search', 'ref_search_documentation', 'ref_read_url',
  'resolve-library-id', 'get-library-docs',
  'memory_recall', 'save_memory', 'todo_read', 'todo_write',
  'ask_user', 'ask_user_question',
  'deep_reflect',
  'pd-status', 'trust', 'report',
] as const;

export const LOW_RISK_WRITE_TOOL_NAMES = [
  'write', 'write_file',
  'edit', 'edit_file', 'replace', 'apply_patch', 'insert', 'patch',
] as const;

// BASH aliases must be defined before HIGH_RISK_TOOL_NAMES
export const BASH_TOOL_NAMES = [
  'bash', 'run_shell_command', 'exec', 'execute', 'shell', 'cmd',
] as const;

export const HIGH_RISK_TOOL_NAMES = [
  'delete_file', 'move_file',
  // Include all BASH aliases for consistent high-risk classification
  ...BASH_TOOL_NAMES,
] as const;

export const AGENT_TOOL_NAMES = [
  'pd_run_worker', 'sessions_spawn',
] as const;

export const CONTENT_LIMITED_TOOL_NAMES = [
  ...LOW_RISK_WRITE_TOOL_NAMES,
] as const;

export const CONSTRUCTIVE_TOOL_NAMES = [
  ...LOW_RISK_WRITE_TOOL_NAMES,
  'delete_file', 'move_file',
  // Include all BASH aliases for consistent constructive classification
  ...BASH_TOOL_NAMES,
  ...AGENT_TOOL_NAMES,
  'evolve-task', 'init-strategy',
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
  'delete_file',
  'move_file',
]);