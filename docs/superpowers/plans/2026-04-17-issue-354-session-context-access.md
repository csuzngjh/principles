# Issue #354: Session Context Access for Diagnostician

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix session context access for diagnostician — bypass `visibility=tree` restriction, fix hardcoded `workspace-main`, and enhance context extraction quality.

**Architecture:** Three independent fixes targeting different root causes. (1) `event-log-auditor.ts` hardcoded `workspace-main` path check → use dynamic workspace detection. (2) `pain-context-extractor.ts` minimal context → enhance extraction quality. (3) Optional built-in tool for cross-session context access. Pain detection flow unchanged — only read-path fixes.

**Tech Stack:** TypeScript, Node.js, OpenClaw plugin architecture, pi-coding-agent

---

## Task 1: Fix Hardcoded `workspace-main` in `event-log-auditor.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/service/event-log-auditor.ts:182-183`
- Test: `packages/openclaw-plugin/tests/service/event-log-auditor.test.ts`

- [ ] **Step 1: Read the current buggy code**

Run: Read lines 170-200 of `event-log-auditor.ts`

- [ ] **Step 2: Create test that reproduces the bug**

```typescript
// packages/openclaw-plugin/tests/service/event-log-auditor.test.ts

import { describe, it, expect } from 'vitest';
import * as path from 'path';

describe('findPrimaryEventLogPath', () => {
  it('should prefer configured workspace over workspace-main', () => {
    // Given: two event log paths, one is workspace-main, one is configured workspace
    const configuredWorkspace = 'my-custom-workspace';
    const paths = [
      '/home/user/.openclaw/workspace-main/.state/logs/events.jsonl',
      `/home/user/.openclaw/workspaces/${configuredWorkspace}/.state/logs/events.jsonl`,
    ];
    
    // When: finding primary path with configured workspace
    const primary = findPrimaryEventLogPath(paths, configuredWorkspace);
    
    // Then: should return configured workspace, not workspace-main
    expect(primary).toContain(configuredWorkspace);
    expect(primary).not.toContain('workspace-main');
  });
});
```

- [ ] **Step 3: Run test to verify it fails with current code**

Run: `npm test -- --grep "should prefer configured workspace"`
Expected: FAIL — current code always chooses `workspace-main`

- [ ] **Step 4: Fix the primary path detection logic**

Replace lines 182-183 in `event-log-auditor.ts`:

```typescript
// BEFORE (buggy):
if (filePath.includes('workspace-main') || filePath.includes('workspace-main')) {
  primaryPath = filePath;
}

// AFTER (fixed):
// Primary path should be the configured workspace, determined dynamically
const configuredWorkspace = wctx?.pluginConfig?.agents?.defaults?.workspace;
if (configuredWorkspace && filePath.includes(configuredWorkspace)) {
  primaryPath = filePath;
}
```

Note: `wctx` is the `WorkspaceContext` already available in the function scope. The fix uses the configured workspace from plugin config instead of hardcoded string.

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- --grep "should prefer configured workspace"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/openclaw-plugin/src/service/event-log-auditor.ts packages/openclaw-plugin/tests/service/event-log-auditor.test.ts
git commit -m "fix: use dynamic workspace detection instead of hardcoded workspace-main"
```

---

## Task 2: Enhance `pain-context-extractor.ts` for Richer Context

**Files:**
- Modify: `packages/openclaw-plugin/src/core/pain-context-extractor.ts:200-280`
- Test: `packages/openclaw-plugin/tests/core/pain-context-extractor.test.ts`

- [ ] **Step 1: Review current extraction logic**

Run: Read `pain-context-extractor.ts` lines 200-280

- [ ] **Step 2: Identify what context is missing**

Current extraction only captures tool call summaries. Missing:
- User message text (before the pain event)
- Error messages from failed tools
- Assistant response previews

- [ ] **Step 3: Create test for enhanced extraction**

```typescript
// packages/openclaw-plugin/tests/core/pain-context-extractor.test.ts

import { describe, it, expect } from 'vitest';

describe('extractRecentConversation', () => {
  it('should include user messages in extracted context', async () => {
    // Given: a session with user message → tool call → failure
    const sessionId = 'test-session-123';
    const agentId = 'main';
    
    // When: extracting conversation context
    const context = await extractRecentConversation(sessionId, agentId, 5);
    
    // Then: context should include user message text
    expect(context).toContain('user');
    expect(context.length).toBeGreaterThan(100); // substantial content
  });
  
  it('should include error messages from failed tools', async () => {
    // Given: a session with a failed tool call
    const sessionId = 'test-session-456';
    const agentId = 'main';
    
    // When: extracting conversation context
    const context = await extractRecentConversation(sessionId, agentId, 5);
    
    // Then: context should include error details
    expect(context).toMatch(/error|failed|ENOENT/i);
  });
});
```

- [ ] **Step 4: Run test to verify current behavior is inadequate**

Run: `npm test -- --grep "should include user messages"`
Expected: FAIL — current extraction doesn't capture user messages

- [ ] **Step 5: Enhance extraction to capture more context**

Modify `pain-context-extractor.ts` to extract:
- Full user messages (role === 'user')
- Error messages from tool results
- Assistant response previews (truncated to 500 chars)

Key changes in the `extractRecentConversation` function:
```typescript
// Instead of only extracting tool calls, also extract:
// - message.role === 'user': full text content
// - message.role === 'assistant': reasoning/response preview
// - tool result errors: extract error strings

function extractMessageContent(entry: any): string {
  if (entry.type !== 'message') return '';
  const msg = entry.message;
  if (!msg) return '';
  
  if (msg.role === 'user') {
    // Extract user message text
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content.map(c => c.type === 'text' ? c.text : '').join(' ');
    }
  }
  
  if (msg.role === 'assistant') {
    // Truncated preview of assistant reasoning
    const content = msg.content;
    if (typeof content === 'string') {
      return content.slice(0, 500) + (content.length > 500 ? '...' : '');
    }
  }
  
  return '';
}
```

- [ ] **Step 6: Run test to verify enhancement works**

Run: `npm test -- --grep "should include user messages"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-plugin/src/core/pain-context-extractor.ts packages/openclaw-plugin/tests/core/pain-context-extractor.test.ts
git commit -m "feat: enhance pain context extraction with user messages and error details"
```

---

## Task 3 (Optional): Built-in Session Context Tool

**Files:**
- Create: `packages/openclaw-plugin/src/tools/session-context.ts`
- Modify: `packages/openclaw-plugin/src/index.ts` (tool registration)
- Test: `packages/openclaw-plugin/tests/tools/session-context.test.ts`

- [ ] **Step 1: Design the tool interface**

```typescript
// packages/openclaw-plugin/src/tools/session-context.ts

export interface SessionContextToolInput {
  session_id: string;
  agent_id?: string;      // defaults to 'main'
  lines?: number;         // max lines to return, default 500
  include_roles?: string[]; // filter: user, assistant, system
}

export interface SessionContextToolOutput {
  entries: Array<{
    type: string;
    timestamp: string;
    role?: string;
    content_preview: string;
  }>;
  metadata: {
    session_id: string;
    total_entries: number;
    returned_entries: number;
  };
}

export async function sessionContextTool(input: SessionContextToolInput): Promise<SessionContextToolOutput> {
  // Implementation reads JSONL directly, bypassing visibility=tree restriction
}
```

- [ ] **Step 2: Create test**

```typescript
// packages/openclaw-plugin/tests/tools/session-context.test.ts

import { describe, it, expect } from 'vitest';

describe('sessionContextTool', () => {
  it('should read session JSONL bypassing visibility restrictions', async () => {
    // Given: a known session ID with messages
    const sessionId = 'test-session-123';
    
    // When: calling the tool
    const result = await sessionContextTool({ session_id: sessionId });
    
    // Then: should return entries without visibility restriction
    expect(result.entries).toBeDefined();
    expect(result.metadata.session_id).toBe(sessionId);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -- --grep "should read session JSONL"`
Expected: FAIL — tool doesn't exist yet

- [ ] **Step 4: Implement the tool**

Read JSONL file directly using `getAgentDir` from `@mariozechner/pi-coding-agent`:

```typescript
import { getAgentDir } from '@mariozechner/pi-coding-agent';
import * as fs from 'fs';
import * as path from 'path';

export async function sessionContextTool(input: SessionContextToolInput): Promise<SessionContextToolOutput> {
  const agentId = input.agent_id || 'main';
  const maxLines = input.lines || 500;
  const agentDir = getAgentDir(agentId);
  const sessionPath = path.join(agentDir, 'sessions', `${input.session_id}.jsonl`);
  
  const content = await fs.promises.readFile(sessionPath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim()).slice(0, maxLines);
  
  const entries = lines.map(line => {
    const entry = JSON.parse(line);
    return {
      type: entry.type,
      timestamp: entry.timestamp || '',
      role: entry.message?.role,
      content_preview: truncateContent(entry.message?.content),
    };
  }).filter(e => {
    if (!input.include_roles) return true;
    return input.include_roles.includes(e.role || '');
  });
  
  return {
    entries,
    metadata: {
      session_id: input.session_id,
      total_entries: lines.length,
      returned_entries: entries.length,
    },
  };
}

function truncateContent(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') {
    return content.slice(0, 500) + (content.length > 500 ? '...' : '');
  }
  if (Array.isArray(content)) {
    return content.map(c => c.text || '').join(' ').slice(0, 500);
  }
  return String(content).slice(0, 500);
}
```

- [ ] **Step 5: Register tool in index.ts**

Add to tool registration section in `packages/openclaw-plugin/src/index.ts`:

```typescript
import { sessionContextTool } from './tools/session-context.js';

// In tool registration:
session_context: {
  description: 'Get conversation context from session JSONL, bypasses visibility=tree',
  inputSchema: { ... },
  handler: sessionContextTool,
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- --grep "should read session JSONL"`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/openclaw-plugin/src/tools/session-context.ts packages/openclaw-plugin/src/index.ts packages/openclaw-plugin/tests/tools/session-context.test.ts
git commit -m "feat: add session-context tool for cross-session visibility bypass"
```

---

## Verification

- [ ] All git diffs reviewable in one output
- [ ] `npm run lint` passes (0 errors)
- [ ] `npm test` passes (all existing + new tests)
- [ ] Pain pipeline end-to-end works
