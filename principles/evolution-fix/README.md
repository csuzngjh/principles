# Evolution Task Fix (for issue #64)

This directory contains the fixed files to resolve the `evolution_task` bug where the system incorrectly used `sessions_spawn` instead of `pd_spawn_agent`, and the `agent-loader` failed to locate agent definitions due to ESM `__dirname` issue.

## Changes

### 1. `prompt.js` (hook)
**Original**: Hardcoded instruction to use `sessions_spawn` targeting `diagnostician`.
**Fixed**: Instruction now calls `pd_spawn_agent` with proper `{agentType, task}` parameters.

```diff
- "invoke the `sessions_spawn` tool targeting `diagnostician`"
+ "call the `pd_spawn_agent` tool with:\n   {\n     \"agentType\": \"diagnostician\",\n     \"task\": \"${directive.task}\"\n   }"
```

### 2. `agent-loader.js`
**Original**: Used `__dirname` directly in ESM, causing `resolveAgentsDir` to fail to locate agents.
**Fixed**: Added fallback absolute path and safe `__dirname` handling; also added hardcoded known path.

```js
const possiblePaths = [
    path.resolve(typeof __dirname !== 'undefined' ? __dirname : '/home/csuzngjh/.openclaw/extensions/principles-disciple/dist/core', '../../agents'),
    path.resolve(typeof __dirname !== 'undefined' ? __dirname : '/home/csuzngjh/.openclaw/extensions/principles-disciple/dist/core', '../agents'),
    '/home/csuzngjh/.openclaw/extensions/principles-disciple/agents',
];
```

## Deployment

Copy the files to your OpenClaw plugin directory:

```bash
# Assuming plugin installed at ~/.openclaw/extensions/principles-disciple/
cp evolution-fix/principles-disciple/dist/hooks/prompt.js ~/.openclaw/extensions/principles-disciple/dist/hooks/
cp evolution-fix/principles-disciple/dist/core/agent-loader.js ~/.openclaw/extensions/principles-disciple/dist/core/
# Then restart Gateway
openclaw gateway restart
```

## Verification

After restart, trigger an `evolution_task` (e.g., by inducing pain detection). You should see:

- No "undefined" agent errors.
- `pd_spawn_agent` starts the diagnostician agent successfully.

---

**Issue**: #64
**PR**: #<to be created>
