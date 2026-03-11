# Installation Guide & Troubleshooting

> Last Updated: 2026-03-11
> Current Version: v1.4.3

## Quick Install

```bash
git clone -b v1.4.3 https://github.com/csuzngjh/principles.git
cd principles
./install-openclaw.sh
```

## Installation Script Details

**Location**: `/install-openclaw.sh`

**Steps** (6 total):
1. **Environment Detection** - Check OpenClaw, Node.js, Python3
2. **Clean Old Version** - Remove `~/.openclaw/extensions/principles-disciple`
3. **Build Plugin** - Install deps + TypeScript compilation
4. **Clean Config** - Remove stale plugin entries using jq
5. **Install Plugin** - `openclaw plugins install`
6. **Install Dependencies** - micromatch, @sinclair/typebox
7. **Copy Skills** - 20 skills to workspace

## Verification

After installation, verify:

```bash
# Check version
cat ~/.openclaw/extensions/principles-disciple/package.json | grep version

# Should show: "version": "1.4.3"

# Check trust engine files (should ONLY have v2)
ls ~/.openclaw/extensions/principles-disciple/dist/core/ | grep trust-engine

# Should show:
# trust-engine-v2.d.ts
# trust-engine-v2.js

# Verify gate.js imports
grep "from.*trust-engine" ~/.openclaw/extensions/principles-disciple/dist/hooks/gate.js

# Should show:
# import { getAgentScorecard, TRUST_CONFIG } from '../core/trust-engine-v2.js';

# Check gateway is running
ps aux | grep "[o]penclaw-gateway"

# Should show running process
```

## Common Issues & Solutions

### Issue 1: "Invalid config: plugin not found: principles-disciple"

**Cause**: Stale plugin entries in `~/.openclaw/openclaw.json`

**Solution**: Installation script auto-cleans (step 4/6), or manual:
```bash
jq 'del(.plugins.allow[] | select(. == "principles-disciple"))' \
  ~/.openclaw/openclaw.json > /tmp/openclaw-clean.json && \
mv /tmp/openclaw-clean.json ~/.openclaw/openclaw.json
```

### Issue 2: Old trust-engine.js still in dist/

**Cause**: dist/ not cleaned before build

**Solution**: Clean build
```bash
cd packages/openclaw-plugin
rm -rf dist
npm run build
```

### Issue 3: Trust score stuck at 0

**Cause**: Old AGENT_SCORECARD.json with incompatible structure

**Solution**: Delete to allow re-initialization
```bash
rm /path/to/workspace/docs/AGENT_SCORECARD.json
# Will auto-initialize on next use with trust_score: 59
```

### Issue 4: Gateway fails to start after installation

**Cause**: Old gateway process still running

**Solution**: Stop and restart
```bash
openclaw gateway stop
sleep 2
openclaw gateway --force
```

### Issue 5: TypeScript compilation errors

**Cause**: Importing old trust-engine.ts

**Solution**: Verify all imports use trust-engine-v2.js
```bash
cd packages/openclaw-plugin/src
grep -r "from.*trust-engine" . | grep -v "trust-engine-v2"
# Should return nothing
```

## Development Workflow

### Making Changes

1. Edit source files in `packages/openclaw-plugin/src/`
2. Clean build: `rm -rf dist && npm run build`
3. Test installation: `./install-openclaw.sh --force`
4. Verify imports and files
5. Restart gateway

### Version Bump

```bash
cd packages/openclaw-plugin
# Edit package.json version
npm run build
cd ../..
git add -A
git commit -m "chore: bump version to X.Y.Z"
git push
git tag vX.Y.Z
git push origin vX.Y.Z
gh release create vX.Y.Z --notes "Release notes..."
```

## Testing Trust Engine

### Quick Test

```bash
# Start a new agent session
cd /tmp/test-workspace
openclaw skill init-strategy

# Check trust score
openclaw plugins list | grep Principles

# Try to write a file (should work with 59 trust score)
echo "test" > test.txt

# Check if trust score changed
cat docs/AGENT_SCORECARD.json | grep trust_score
```

### Expected Behavior

**New Agent** (cold start):
- Initial trust: 59
- Can edit small files (< 10 lines)
- 3 grace failures (no penalty)
- Stage 2 permissions

**After Grace Failures**:
- 4th failure: -8 penalty
- Trust score: 51 (still Stage 2)
- Further failures: adaptive penalties

**Success Pattern**:
- Each success: +1
- 5+ streak: +5 bonus
- Recovery boost: +3 after failures

## File Structure

```
~/.openclaw/
├── extensions/
│   └── principles-disciple/          # Installed plugin
│       ├── dist/
│       │   ├── core/
│       │   │   └── trust-engine-v2.js  # ✅ Only this file
│       │   └── hooks/
│       │       └── gate.js            # Must import v2
│       ├── package.json               # version: "1.4.3"
│       └── templates/
├── openclaw.json                      # Plugin config
└── agents/
    └── main/
        └── sessions/

Workspace (e.g., ~/clawd/)
├── docs/
│   ├── AGENT_SCORECARD.json          # Auto-created on first use
│   ├── PLAN.md
│   └── PROFILE.json
└── memory/
    └── .state/
        ├── logs/
        │   ├── events.jsonl
        │   └── daily-stats.json
        └── .pain_flag                 # Created on failures
```

## Post-Installation Checklist

- [ ] Gateway running without errors
- [ ] Plugin loaded (check `openclaw plugins list`)
- [ ] Only trust-engine-v2.js exists
- [ ] gate.js imports trust-engine-v2.js
- [ ] EvolutionWorker started (check logs)
- [ ] Can create new agent sessions
- [ ] Trust system initializes new agents at 59

## Log Locations

**Gateway Logs**:
- Latest: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- Plugin search: `grep "Principles Disciple" /tmp/openclaw/*.log`

**Plugin Logs**:
- Event log: `workspace/memory/.state/logs/events.jsonl`
- Daily stats: `workspace/memory/.state/logs/daily-stats.json`
- Plugin log: `workspace/memory/.state/logs/plugin.log`

## Getting Help

If issues persist:
1. Check gateway logs: `tail -100 /tmp/openclaw/openclaw-*.log | grep -i error`
2. Check plugin is loaded: `openclaw plugins list | grep Principles`
3. Verify imports: `grep "from.*trust-engine" ~/.openclaw/extensions/principles-disciple/dist/hooks/*.js`
4. Clean reinstall: `./install-openclaw.sh --force`
5. Report issue with: Gateway logs + Plugin version + OS info
