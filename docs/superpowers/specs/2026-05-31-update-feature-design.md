# PD Update Feature Design

> **Date**: 2026-05-31
> **Status**: Draft
> **Scope**: Complete version upgrade for PD (plugin + workspace config + database migration + breaking changes)

## 1. Overview

This document describes the design for adding an update feature to Principles Disciple (PD). The update feature will allow users to update PD components through the pd-console Web UI, with support for:

- Checking for available updates from npm registry
- Updating all PD components (plugin, CLI, console, core)
- Handling workspace file changes (smart merge, overwrite, or keep)
- Database schema migration with rollback on failure
- Backup before update (optional)

## 2. Requirements

| Requirement | Priority | Description |
|-------------|----------|-------------|
| Update scope | P0 | Complete version upgrade (plugin + workspace config + database migration + breaking changes) |
| Update source | P0 | npm registry |
| Trigger method | P0 | Manual command via Web UI |
| Workspace file handling | P1 | User choice: smart merge, overwrite, or keep |
| Database migration | P0 | Automatic migration with rollback on failure |
| Backup mechanism | P1 | Optional backup before update (`--backup` flag) |
| Confirmation | P0 | Default requires confirmation, `--yes` skips (for automation) |

## 3. Architecture

### 3.1 Component Overview

```
┌─────────────────────────────────────────────────────────────┐
│  pd-console (Web UI + HTTP Server)                          │
├─────────────────────────────────────────────────────────────┤
│  GET /api/update/check     → Check for available updates    │
│  POST /api/update/apply    → Execute update                 │
│  GET /api/update/status    → Get update status              │
│  POST /api/update/rollback → Rollback to backup             │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  create-principles-disciple (Update Logic)                  │
├─────────────────────────────────────────────────────────────┤
│  updater.ts           → Version comparison, diff calculation│
│  installer.ts         → Backup, rollback, file operations   │
│  uninstaller.ts       → Cleanup logic                       │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│  npm registry                                               │
├─────────────────────────────────────────────────────────────┤
│  create-principles-disciple (latest version)                │
└─────────────────────────────────────────────────────────────┘
```

### 3.2 Package Structure

The update logic will be implemented in the `create-principles-disciple` package:

```
packages/create-principles-disciple/
├── src/
│   ├── index.ts              # CLI entry (existing)
│   ├── installer.ts          # Install logic (existing)
│   ├── uninstaller.ts        # Uninstall logic (existing)
│   ├── updater.ts            # NEW: Update logic
│   │   ├── checkForUpdates()     # Check npm registry
│   │   ├── fetchChangelog()      # Get changelog
│   │   ├── computeDiff()         # Calculate file differences
│   │   ├── applyUpdate()         # Apply update
│   │   └── rollbackUpdate()      # Rollback on failure
│   ├── mvp-config.ts         # Path configuration (existing)
│   └── ...
```

The HTTP API will be added to `pd-console`:

```
packages/pd-console/
├── src/
│   ├── server/
│   │   ├── index.ts          # HTTP server (existing)
│   │   └── routes/
│   │       └── update.ts     # NEW: Update API routes
│   └── ...
```

## 4. API Design

### 4.1 Check for Updates

```
GET /api/update/check
```

**Response:**

```typescript
interface UpdateCheckResponse {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion?: string;
  changelog?: string;
  packages?: {
    name: string;
    currentVersion: string;
    latestVersion: string;
  }[];
}
```

**Implementation:**

1. Read current version from `create-principles-disciple/package.json`
2. Query npm registry for latest version: `https://registry.npmjs.org/create-principles-disciple/latest`
3. Compare versions using semver
4. Return update availability and details

### 4.2 Apply Update

```
POST /api/update/apply
```

**Request:**

```typescript
interface UpdateApplyRequest {
  backup?: boolean;           // Create backup before update (default: false)
  mergeStrategy?: 'smart' | 'overwrite' | 'keep';  // Workspace file handling (default: 'interactive')
  packages?: string[];        // Specific packages to update (empty = all)
}
```

**Response:**

```typescript
interface UpdateApplyResponse {
  success: boolean;
  message: string;
  updatedPackages?: string[];
  backupPath?: string;
  errors?: string[];
}
```

**Implementation:**

1. Validate request parameters
2. Check if update is already in progress
3. Create backup if requested
4. Download latest package from npm
5. Extract and compute diff
6. Apply workspace file changes based on merge strategy
7. Update plugin files
8. Update CLI
9. Update console
10. Execute database schema migration
11. Verify update
12. Rollback on failure
13. Return result

### 4.3 Get Update Status

```
GET /api/update/status
```

**Response:**

```typescript
interface UpdateStatusResponse {
  checking: boolean;
  updating: boolean;
  lastCheckTime?: string;
  lastUpdateTime?: string;
  currentVersion: string;
}
```

### 4.4 Rollback

```
POST /api/update/rollback
```

**Request:**

```typescript
interface UpdateRollbackRequest {
  backupPath: string;
}
```

**Response:**

```typescript
interface UpdateRollbackResponse {
  success: boolean;
  message: string;
}
```

## 5. Update Flow

### 5.1 Complete Update Flow

```
1. User clicks "Check for Updates" in Web UI
2. Frontend calls GET /api/update/check
3. Backend queries npm registry
4. Backend returns update availability
5. User clicks "Update" button
6. Frontend shows update confirmation dialog
7. User confirms update
8. Frontend calls POST /api/update/apply
9. Backend executes update:
   a. Create backup (if requested)
   b. Download latest package
   c. Extract and compute diff
   d. Apply workspace file changes
   e. Update plugin files
   f. Update CLI
   g. Update console
   h. Execute database migration
   i. Verify update
   j. Rollback on failure
10. Backend returns result
11. Frontend shows update result
12. If successful, prompt user to restart OpenClaw Gateway
```

### 5.2 Workspace File Handling

When updating workspace files (AGENTS.md, SOUL.md, etc.), the system will:

1. Compare current workspace files with new templates
2. If user chose `smart`:
   - Generate `.update` files for modified templates
   - User manually merges changes
3. If user chose `overwrite`:
   - Force overwrite workspace files
4. If user chose `keep`:
   - Keep existing workspace files unchanged

### 5.3 Database Migration

1. Check current schema version from `state.db`
2. Compare with target schema version
3. If migration needed:
   a. Create database backup
   b. Execute migration scripts in order
   c. Verify migration success
   d. Rollback on failure
4. Update schema version

## 6. UI Design

### 6.1 Update Banner

Display update notification in console header:

```
┌─────────────────────────────────────────────────────────────┐
│ 🔄 PD 1.74.0 available (current: 1.73.0)    [Details] [Update] │
└─────────────────────────────────────────────────────────────┘
```

### 6.2 Update Settings Page

New page at `/settings/update`:

```
┌─────────────────────────────────────────────────────────────┐
│  PD Update Settings                                         │
├─────────────────────────────────────────────────────────────┤
│  Current Version: 1.73.0                                    │
│  Latest Version: 1.74.0                                     │
│                                                             │
│  ☑ Auto-check for updates (every 24 hours)                 │
│  ☑ Create backup before update                             │
│  Workspace file handling: ○ Smart merge  ○ Overwrite  ○ Keep │
│                                                             │
│  [Check for Updates]  [Update Now]                          │
└─────────────────────────────────────────────────────────────┘
```

### 6.3 Update Progress Dialog

Show progress during update:

```
┌─────────────────────────────────────────────────────────────┐
│  Updating PD...                                             │
├─────────────────────────────────────────────────────────────┤
│  [████████████████░░░░░░░░░░░░░░░░░░░░░░░░] 40%             │
│                                                             │
│  ✓ Check for updates complete                               │
│  ✓ Create backup complete                                   │
│  ↓ Downloading update package...                            │
│  ○ Applying update...                                       │
│  ○ Migrating database...                                    │
│  ○ Verifying...                                             │
│                                                             │
│  [Cancel]                                                   │
└─────────────────────────────────────────────────────────────┘
```

## 7. Error Handling

### 7.1 Update Failures

| Error | Handling |
|-------|----------|
| Network error | Retry 3 times, then fail with error message |
| Download failed | Retry 3 times, then fail with error message |
| Extract failed | Fail with error message |
| File write failed | Rollback to backup |
| Database migration failed | Rollback to backup |
| Verification failed | Rollback to backup |

### 7.2 Rollback Mechanism

1. Before update, create backup at `~/.openclaw/extensions/principles-disciple.backup.{timestamp}`
2. If any step fails, automatically rollback:
   a. Restore files from backup
   b. Restore database from backup
   c. Clean up partial update files
3. Return error message to user

## 8. Security Considerations

1. **Authentication**: All update API endpoints require authentication (same as other API routes)
2. **Authorization**: Only operators can trigger updates
3. **Input Validation**: Validate all request parameters
4. **File Path Validation**: Ensure all file operations are within allowed directories
5. **Backup Integrity**: Verify backup integrity before rollback

## 9. Testing Strategy

### 9.1 Unit Tests

- `checkForUpdates()` - version comparison logic
- `computeDiff()` - file diff calculation
- `applyUpdate()` - update application logic
- `rollbackUpdate()` - rollback logic

### 9.2 Integration Tests

- Full update flow (check → apply → verify)
- Rollback on failure
- Workspace file handling (smart merge, overwrite, keep)
- Database migration

### 9.3 E2E Tests

- Update via Web UI
- Update progress display
- Error handling and user feedback

## 10. Implementation Plan

### Phase 1: Core Update Logic

1. Create `updater.ts` in `create-principles-disciple`
2. Implement `checkForUpdates()`
3. Implement `computeDiff()`
4. Implement `applyUpdate()`
5. Implement `rollbackUpdate()`

### Phase 2: HTTP API

1. Create `update.ts` routes in `pd-console`
2. Implement `/api/update/check`
3. Implement `/api/update/apply`
4. Implement `/api/update/status`
5. Implement `/api/update/rollback`

### Phase 3: Web UI

1. Add update banner component
2. Add update settings page
3. Add update progress dialog
4. Add update history page

### Phase 4: Testing

1. Unit tests for core logic
2. Integration tests for API
3. E2E tests for UI

## 11. Dependencies

- `npm` - for querying registry and downloading packages
- `semver` - for version comparison (may need to add dependency)
- `better-sqlite3` - for database operations (existing)

## 12. Open Questions

1. Should we add a `pd update` CLI command in addition to the Web UI?
2. How often should we auto-check for updates? (24 hours recommended)
3. Should we support updating specific packages only?
4. Should we add update notifications to the agent context (via `before_prompt_build` hook)?

## 13. References

- [PRODUCT_IDENTITY.md](../../PRODUCT_IDENTITY.md) - Product definition
- [AGENTS.md](../../AGENTS.md) - Project guidelines
- [ADR-0014](../adr/0014-mvp-first-strategy-and-product-pivot.md) - MVP-First strategy
