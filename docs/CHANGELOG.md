# Principles Disciple - Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added (PR #4: Configuration Migration + Documentation)

#### Migration Script
- `scripts/migrate-to-evolution-points.ts` - Automated migration from Trust Engine to Evolution Points v2.0
  - Converts trust scores (0-100) to EP tiers and points
  - Preserves existing capabilities through conservative migration
  - Archives old configuration files (non-destructive)
  - Updates PROFILE.json to enable EP system

#### Documentation
- `docs/EVOLUTION_POINTS_GUIDE.md` - Comprehensive user guide
  - Core philosophy and 5-stage growth path explanation
  - Point rules and double reward mechanics
  - Monitoring progress and checking status
  - Configuration options and examples
  - Troubleshooting common issues
  - Tips for fast growth

- `docs/MIGRATION_GUIDE.md` - Trust Engine to EP migration guide
  - Step-by-step migration instructions
  - Trust score → tier mapping logic
  - Backup and rollback procedures
  - Common issues and solutions
  - Post-migration checklist

- `docs/ADVANCED_EVOLUTION_CONFIG.md` - Advanced configuration guide
  - All configuration options explained
  - Tuning strategies for different use cases
  - Monitoring and debugging commands
  - Performance impact analysis
  - Common pitfalls and solutions

- `README.md` - Updated with links to new documentation

## [1.5.6] - 2026-03-17

### Changed
- Refactored empathy pipeline from prompt-level strong coupling to async observer sidecar mode (v3.0):
  - Added `EmpathyObserverManager` singleton service for spawn/reap/lock lifecycle.
  - Prompt hook now triggers observer subagent spawn instead of injecting `<system_override:empathy_engine>` directives.
  - Subagent ended hook now intercepts observer sessions and reaps JSON result to update GFI.

---

## [1.5.0] - 2026-03-13

### Added (PR #21: Core Data Structure + Storage System)

#### Core Features
- Evolution Points v2.0 system implementation
  - 5-tier growth path: Seed → Sprout → Sapling → Tree → Forest
  - Double reward mechanism (failure → success = 2x points, 1h cooldown)
  - Difficulty-based rewards: trivial (1pt), normal (3pt), hard (8pt)
  - Anti-grind protection: high-tier agents earn fewer points for low-tier tasks
  - Only-increase point model: failures record lessons, not penalties

- Data structures (`packages/openclaw-plugin/src/core/evolution-types.ts`)
  - `EvolutionTier` enum (5 levels)
  - `TierDefinition` interface (permissions and requirements)
  - `EvolutionScorecard` interface (points and stats)
  - `EvolutionEvent` interface (task tracking)

- Evolution Engine (`packages/openclaw-plugin/src/core/evolution-engine.ts`)
  - Single-instance isolation (Map-based)
  - Point calculation with difficulty decay
  - Tier promotion logic
  - Double reward cooldown management

- Storage System
  - Atomic writes with file locks
  - Deadlock detection (10s timeout)
  - Snapshot + recent 50 events storage
  - Retry queue for failed writes

- Gate Integration
  - Before-tool-call permission checks
  - After-tool-call point awards
  - Tier-based permission enforcement

#### Testing
- Unit tests: 39 core use cases (`evolution-engine.test.ts`)
- Integration tests: 25 use cases (`evolution-engine-gate-integration.test.ts`)
  - Tier promotion flow testing
  - Block recovery testing
  - Multi-tool consistency testing
  - Boundary condition testing
  - Persistence testing
  - Real-world scenario testing
- Test coverage: 69.63% (>60% target)
  - Overall: 69.63% statements, 57.44% branches, 71.89% functions
  - evolution-engine.ts: 75.66% statements, 79.12% branches

### Changed
- Trust Engine replaced by Evolution Points (single-track migration)
- Gate logic updated to use EP system for permission checks

---

## [1.4.0] - 2026-03-12

### Added
- Trust Engine v1.0 implementation
- Penalty-based scoring system
- Three-stage trust levels: Observer → Editor → Developer
- Gatekeeper system for risk path protection
- Progressive gate with plan approvals

### Changed
- Initial trust set to 85 (Developer) by default
- Enhanced pain dictionary with 50+ patterns

---

## [1.0.0] - 2026-03-10

### Added
- Initial release of Principles Disciple
- Core philosophy: "Fuel the evolution with pain"
- Basic pain capture and distillation system
- OpenClaw plugin integration
- Identity layer (SOUL.md, AGENTS.md, IDENTITY.md)
- State management (.state/ directory)
- Memory system (memory/ logs)

---

## Version Format

- **[Unreleased]** - Features planned for next release
- **[X.Y.Z]** - Released versions (follows Semantic Versioning)
  - X: Major version (breaking changes)
  - Y: Minor version (new features, backward compatible)
  - Z: Patch version (bug fixes, backward compatible)

---

*Last updated: 2026-03-14*
