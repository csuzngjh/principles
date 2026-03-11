# Principles Disciple - Project Memory

> Last Updated: 2026-03-11
> Maintainer: Claude Code

**📚 Memory Index**: See [INDEX.md](./INDEX.md) for complete memory file listing and quick reference.

## Critical Issues & Solutions

### Trust System Migration (2026-03-11)

**Problem**: Trust score showing 0/100, agents unable to write files

**Root Cause**:
- `gate.ts` was importing old `trust-engine.js` instead of `trust-engine-v2.js`
- Multiple files (5 total) still using old version:
  - `src/hooks/gate.ts`
  - `src/hooks/prompt.ts`
  - `src/hooks/pain.ts`
  - `src/hooks/subagent.ts`
  - `src/commands/trust.ts`
- AGENT_SCORECARD.json had incompatible structure from old system
- dist/ directory contained compiled old version

**Solution**:
1. Updated all imports from `trust-engine.js` to `trust-engine-v2.js`
2. Deleted `src/core/trust-engine.ts` (old version)
3. Fixed constant names:
   - `TOOL_FAILURE` → `TOOL_FAILURE_BASE`
   - `RISKY_FAILURE` → `RISKY_FAILURE_BASE`
4. Cleaned dist/ directory and rebuilt
5. Reset AGENT_SCORECARD.json to allow re-initialization

**Release**: v1.4.3 - Trust Engine V2 Migration

## Project Architecture

### Trust Engine V2 Features

**Cold Start Support**:
- Initial trust score: 59 (Stage 2 upper bound)
- Grace failures: 3 mistakes with no penalty
- Cold start period: 24 hours with 50% penalty reduction

**Adaptive System**:
- Penalties scale with failure frequency
- Rewards scale with success consistency
- Recent history tracking (last 20 operations)
- Failure rate adjustment (70%+ = higher penalty, 30%- = lower)

**Stage Thresholds**:
- Stage 1 (Observer): 0-30 points
- Stage 2 (Editor): 30-60 points
- Stage 3 (Developer): 60-80 points
- Stage 4 (Architect): 80-100 points

### Installation Process

**Script**: `install-openclaw.sh` (root directory)

**Steps**:
1. Environment detection
2. Clean old version
3. Build plugin (TypeScript compilation)
4. Clean stale plugin config entries (jq-based)
5. Install plugin to OpenClaw
6. Install plugin dependencies
7. Copy Skills

**Verification**:
- Version should match release
- Only `trust-engine-v2.js` should exist (no old trust-engine.js)
- `gate.js` must import from `trust-engine-v2.js`

### Key Paths

**Source**:
- Plugin: `/home/csuzngjh/code/principles/packages/openclaw-plugin/`
- Source: `packages/openclaw-plugin/src/`
- Dist: `packages/openclaw-plugin/dist/`

**Installation**:
- OpenClaw Extensions: `~/.openclaw/extensions/principles-disciple/`
- Config: `~/.openclaw/openclaw.json`
- Workspace: `/home/csuzngjh/clawd/`

**State Files**:
- AGENT_SCORECARD: `workspace/docs/AGENT_SCORECARD.json`
- Event Logs: `workspace/memory/.state/logs/`
- Pain Flags: `workspace/memory/.state/.pain_flag`

## Version History

### v1.4.3 (2026-03-11)
- Migrate to Trust Engine V2
- Delete trust-engine.ts (old version)
- Fix all imports to use trust-engine-v2.js
- Add CLAUDE.md project documentation

### v1.4.2 (2026-03-10)
- Installation script improvements
- Auto-cleanup of stale config entries
- Fixed step numbering (4/6)

### v1.4.1 (2026-03-10)
- PLAN whitelist mechanism for Stage 1
- Trust Engine V2 implementation (but not activated)
- postinstall script for dependencies

## Development Workflow

**Build Process**:
```bash
cd packages/openclaw-plugin
npm run build  # TypeScript compilation
```

**Important**: Always clean dist/ when migrating between major versions
```bash
rm -rf dist && npm run build
```

**Testing Installation**:
```bash
# From project root
./install-openclaw.sh --force
```

**Verification Checklist**:
- [] Correct version in package.json
- [] Only trust-engine-v2.js exists (no trust-engine.js)
- [] gate.js imports from trust-engine-v2.js
- [] Gateway loads plugin without errors
- [] EvolutionWorker starts with correct workspaceDir

## Common Issues

**Issue**: "Invalid config: plugin not found: principles-disciple"
**Solution**: Clean stale config entries before installation
```bash
jq 'del(.plugins.allow[] | select(. == "principles-disciple"))' ~/.openclaw/openclaw.json
```

**Issue**: Old trust-engine.js still in dist/
**Solution**: Clean build
```bash
cd packages/openclaw-plugin
rm -rf dist && npm run build
```

**Issue**: Trust score still 0 after migration
**Solution**: Delete AGENT_SCORECARD.json to allow re-initialization
```bash
rm /path/to/workspace/docs/AGENT_SCORECARD.json
```

## Files Modified in v1.4.3 Migration

**Deleted**:
- `src/core/trust-engine.ts`

**Updated Imports** (5 files):
- `src/hooks/gate.ts`
- `src/hooks/prompt.ts`
- `src/hooks/pain.ts`
- `src/hooks/subagent.ts`
- `src/commands/trust.ts`

**Constant Names Updated**:
- `TRUST_CONFIG.PENALTIES.TOOL_FAILURE` → `TOOL_FAILURE_BASE`
- `TRUST_CONFIG.PENALTIES.RISKY_FAILURE` → `RISKY_FAILURE_BASE`

## Release Process

1. Update version in `package.json`
2. Clean build: `rm -rf dist && npm run build`
3. Test installation: `./install-openclaw.sh --force`
4. Verify all imports correct
5. Commit changes with detailed message
6. Push to remote
7. Create git tag: `git tag v1.4.3`
8. Push tag: `git push origin v1.4.3`
9. Create GitHub release with detailed changelog

## Documentation

**CLAUDE.md**: Comprehensive project documentation covering:
- Project overview and architecture
- Development commands and workflows
- Trust Engine system
- Thinking OS meta-cognitive layer
- Directory structure conventions
- Conductor framework integration
- Slash commands reference
- Testing strategy
- Build process

This documentation is critical for Claude Code to understand project structure.
