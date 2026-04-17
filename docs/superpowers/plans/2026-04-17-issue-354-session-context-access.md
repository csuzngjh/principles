# Issue #354: Session Context Access for Diagnostician

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix session context access for diagnostician — bypass `visibility=tree` restriction, fix hardcoded `workspace-main`, and enhance context extraction quality.

**Architecture:** Three independent fixes targeting different root causes: (1) `event-log-auditor.ts` hardcoded `workspace-main` path check, (2) `pain-context-extractor.ts` context extraction quality, (3) optional new built-in tool for cross-session context access. Pain detection flow remains unchanged — only read-path fixes.

**Tech Stack:** TypeScript, Node.js, OpenClaw plugin architecture

---

## Task 1: Fix Hardcoded `workspace-main` in `event-log-auditor.ts`

**Files:**
- Modify: `packages/openclaw-plugin/src/service/event-log-auditor.ts:182-183`

- [ ] **Step 1: Read the current code around line 182**

Run: Read lines 170-200 of `event-log-auditor.ts`

- [ ] **Step 2: Identify the bug**

The current code:
```typescript
if (filePath.includes('workspace-main') || filePath.includes('workspace-main')) {
  primaryPath = filePath;
}
```
This checks the same condition twice and hardcodes `workspace-main`. It should use a dynamic primary workspace detection instead.

- [ ] **Step 3: Fix the primary path detection logic**

Replace the hardcoded check with dynamic detection using `findKnownEventLogPaths()` results — prefer the workspace configured in OpenClaw config (`agents.defaults.workspace`) over `workspace-main`.

```typescript
// Before: hardcoded workspace-main check
if (filePath.includes('workspace-main') || filePath.includes('workspace-main')) {
  primaryPath = filePath;
}

// After: dynamic primary detection
// Primary path should be the configured workspace, not hardcoded
const configuredWorkspace = ctx?.pluginConfig?.agents?.defaults?.workspace;
if (configuredWorkspace && filePath.includes(configuredWorkspace)) {
  primaryPath = filePath;
}
```

- [ ] **Step 4: Verify with git diff**

Run: `git diff packages/openclaw-plugin/src/service/event-log-auditor.ts`

---

## Task 2: Enhance `pain-context-extractor.ts` for Richer Context

**Files:**
- Modify: `packages/openclaw-plugin/src/core/pain-context-extractor.ts:200-280`

- [ ] **Step 1: Review current extraction logic**

Run: Read `pain-context-extractor.ts` lines 200-280

- [ ] **Step 2: Identify what context is currently extracted**

Current extraction is very minimal — only tool call summaries. The diagnostician needs more context including:
- User message text (before the pain event)
- Tool failure error messages
- Assistant reasoning/response previews
- Session metadata (timestamps, model info)

- [ ] **Step 3: Enhance extraction to capture more context**

The JSONL format stores entries with `message` field containing role + content. Improve extraction to capture:
- Full user messages (not just tool calls)
- Error messages from tool results
- Assistant response previews

```typescript
// Extract recent conversation with richer context
// Instead of just tool calls, also capture:
// - User messages
// - Error messages from failed tools
// - Assistant reasoning previews (truncated to 500 chars)
```

- [ ] **Step 4: Test with existing pain events**

Run: Check if `.state/.pain_flag` has recent entries and test extraction

---

## Task 3 (Optional): Built-in Session Context Tool

**Files:**
- Create: `packages/openclaw-plugin/src/tools/session-context.ts`
- Register: `packages/openclaw-plugin/src/index.ts` (tool registration section)
- Test: `packages/openclaw-plugin/tests/tools/session-context.test.ts`

- [ ] **Step 1: Design the tool interface**

The tool should:
- Input: `{ session_id: string, agent_id?: string, lines?: number }`
- Output: Structured JSON with conversation entries (bypasses `visibility=tree`)
- Bypass `sessions_history` API and read JSONL directly

```typescript
interface SessionContextTool {
  name: 'session_context';
  description: 'Get conversation context from a session JSONL file, bypassing visibility restrictions';
  input: {
    session_id: string;      // Target session ID
    agent_id?: string;      // Agent ID (defaults to 'main')
    lines?: number;         // Max lines to return (default 500)
    include_roles?: string[]; // Filter by role: user, assistant, system
  };
  output: {
    entries: Array<{
      type: string;
      timestamp: string;
      role?: string;
      content_preview: string;  // Truncated content
    }>;
    metadata: {
      session_id: string;
      total_entries: number;
      returned_entries: number;
    };
  };
}
```

- [ ] **Step 2: Implement the tool**

```typescript
// packages/openclaw-plugin/src/tools/session-context.ts
import * as fs from 'fs';
import * as path from 'path';
import { getAgentDir } from '@mariozechner/pi-coding-agent';

export async function sessionContextTool(input: {
  session_id: string;
  agent_id?: string;
  lines?: number;
  include_roles?: string[];
}): Promise<SessionContextToolOutput> {
  const agentId = input.agent_id || 'main';
  const maxLines = input.lines || 500;
  const agentDir = getAgentDir(agentId);
  const sessionPath = path.join(agentDir, 'sessions', `${input.session_id}.jsonl`);
  
  // Read and parse JSONL, filtering as needed
  // ...
}
```

- [ ] **Step 3: Register the tool in index.ts**

- [ ] **Step 4: Write tests**

---

## Verification

- [ ] All `git diff` changes reviewable in one output
- [ ] No new TypeScript errors (`npm run lint` passes)
- [ ] Existing tests pass (`npm test`)
- [ ] Pain pipeline still works end-to-end
