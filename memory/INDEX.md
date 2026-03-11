# Memory Index

> Principles Disciple Project Memory
> Last Updated: 2026-03-11

## Memory Files

### [MEMORY.md](./MEMORY.md)
**Main project memory** - Critical issues, solutions, and key learnings

Contents:
- Trust System Migration (2026-03-11)
- Project Architecture overview
- Installation Process
- Key Paths
- Version History
- Development Workflow
- Common Issues & Solutions
- Files Modified in v1.4.3
- Release Process

**When to read**: Starting new session, troubleshooting issues

---

### [trust-system.md](./trust-system.md)
**Trust Engine V2 complete reference**

Contents:
- Architecture (V1 vs V2 comparison)
- Configuration (TRUST_CONFIG)
- AgentScorecard interface
- Functions (getAgentScorecard, recordSuccess, recordFailure)
- Cold Start Behavior
- Grace Failures
- Adaptive Penalties & Rewards
- Migration Path
- Testing procedures
- Usage in Hooks

**When to read**:
- Working with trust system
- Modifying gate/pain/subagent hooks
- Debugging trust score issues
- Planning trust system enhancements

---

### [installation-guide.md](./installation-guide.md)
**Installation & troubleshooting guide**

Contents:
- Quick Install instructions
- Installation Script Details (6 steps)
- Verification procedures
- Common Issues & Solutions (5 issues)
- Development Workflow
- Testing Trust Engine
- File Structure reference
- Post-Installation Checklist
- Log Locations

**When to read**:
- Installing plugin
- Debugging installation issues
- Verifying installation success
- Helping new users install

---

## Quick Reference

### Most Critical Information

**Trust System Issue (2026-03-11)**:
- Problem: gate.ts imported old trust-engine.js
- Fix: All imports now use trust-engine-v2.js
- Result: New agents start at 59 trust score with 3 grace failures

**Key Files**:
- Plugin: `/home/csuzngjh/code/principles/packages/openclaw-plugin/`
- Installed: `~/.openclaw/extensions/principles-disciple/`
- Workspace: `/home/csuzngjh/clawd/`

**Version History**:
- v1.4.3 (2026-03-11): Trust Engine V2 Migration ✅
- v1.4.2 (2026-03-10): Installation improvements
- v1.4.1 (2026-03-10): PLAN whitelist + Trust V2 (inactive)

### Common Commands

```bash
# Build plugin
cd packages/openclaw-plugin
npm run build

# Clean build (important!)
rm -rf dist && npm run build

# Install plugin
./install-openclaw.sh --force

# Verify installation
cat ~/.openclaw/extensions/principles-disciple/package.json | grep version

# Check gateway logs
tail -100 /tmp/openclaw/openclaw-*.log | grep Principles

# Restart gateway
openclaw gateway stop && openclaw gateway --force
```

## Session Start Checklist

When starting a new session:

1. **Read MEMORY.md** for project context
2. **Check installed version**: Should be 1.4.3
3. **Verify trust engine**: Only trust-engine-v2.js should exist
4. **Check gateway status**: Should be running without errors
5. **Review recent issues**: Check if any problems from last session

## Memory Update Guidelines

**When to update memory**:
- After resolving critical issues
- After major version releases
- When discovering new patterns/conventions
- After architectural decisions
- When documenting new workflows

**How to update**:
1. Choose appropriate memory file
2. Add clear, concise information
3. Include date and context
4. Update this INDEX if adding new files
5. Commit memory changes with descriptive message

**Memory organization principles**:
- **MEMORY.md**: High-level, cross-cutting concerns
- **trust-system.md**: Deep dive on specific component
- **installation-guide.md**: Procedural, troubleshooting
- **Create new files** for other major components

## Links to External Documentation

- **CLAUDE.md**: Project documentation for Claude Code
- **GitHub Releases**: https://github.com/csuzngjh/principles/releases
- **Project README**: /home/csuzngjh/code/principles/README.md

## Search Tags

For finding information quickly:
- `#trust-system` - Trust Engine V2
- `#installation` - Installation and setup
- `#migration` - V1 to V2 migration
- `#troubleshooting` - Common issues
- `#architecture` - System design
- `#workflow` - Development process
