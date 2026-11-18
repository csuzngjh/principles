import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
  PD_DIRS,
  PD_FILES,
  WORKSPACE_STATE_DB_RELATIVE_PATH,
  WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH,
  resolvePdPath,
  resolveStateDbDir,
  resolveStateDbPath,
  resolveTrajectoryDbPath,
  workspaceDirFromStateDbPath,
} from '../src/runtime/store/storage-paths.js';

describe('canonical PD workspace path contract', () => {
  it('keeps the accepted physical workspace layout unchanged', () => {
    expect(PD_DIRS.PD_CONFIG).toBe('.pd');
    expect(PD_DIRS.STATE).toBe('.state');
    expect(PD_DIRS.IDENTITY).toBe('.principles');
    expect(PD_DIRS.MEMORY).toBe('memory');
    expect(PD_FILES.CONFIG).toBe('.pd/config.yaml');
    expect(PD_FILES.STATE_DB).toBe('.pd/state.db');
    expect(PD_FILES.TRAJECTORY_DB).toBe('.state/trajectory.db');
    expect(PD_FILES.PRINCIPLE_TRAINING_STATE).toBe('.state/principle_training_state.json');
    expect(WORKSPACE_STATE_DB_RELATIVE_PATH).toBe('.pd/state.db');
    expect(WORKSPACE_TRAJECTORY_DB_RELATIVE_PATH).toBe('.state/trajectory.db');
  });

  it('resolves POSIX workspace paths through the canonical file map', () => {
    const workspace = '/tmp/pd-workspace';
    expect(resolvePdPath(workspace, 'CONFIG')).toBe(path.posix.join(workspace, '.pd', 'config.yaml'));
    expect(resolvePdPath(workspace, 'PRINCIPLES')).toBe(path.posix.join(workspace, '.principles', 'PRINCIPLES.md'));
    expect(resolveStateDbDir(workspace)).toBe(path.posix.join(workspace, '.pd'));
    expect(resolveStateDbPath(workspace)).toBe(path.posix.join(workspace, '.pd', 'state.db'));
    expect(resolveTrajectoryDbPath(workspace)).toBe(path.posix.join(workspace, '.state', 'trajectory.db'));
  });

  it('resolves Windows drive and UNC paths correctly on non-Windows runners', () => {
    const driveWorkspace = 'D:\\Owner Data\\PD';
    const uncWorkspace = '\\\\server\\share\\PD';
    expect(resolvePdPath(driveWorkspace, 'CONFIG')).toBe(path.win32.join(driveWorkspace, '.pd', 'config.yaml'));
    expect(resolveStateDbPath(driveWorkspace)).toBe(path.win32.join(driveWorkspace, '.pd', 'state.db'));
    expect(resolveTrajectoryDbPath(driveWorkspace)).toBe(path.win32.join(driveWorkspace, '.state', 'trajectory.db'));
    expect(resolvePdPath(uncWorkspace, 'PROFILE')).toBe(path.win32.join(uncWorkspace, '.principles', 'PROFILE.json'));
  });

  it('derives the workspace root from a Windows state DB path without POSIX separators', () => {
    const workspace = 'D:\\Owner Data\\PD';
    expect(workspaceDirFromStateDbPath(resolveStateDbPath(workspace))).toBe(workspace);
  });
});
