import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { HygieneTracker } from '../src/core/hygiene/tracker.js';

vi.mock('fs');

describe('HygieneTracker', () => {
  const stateDir = '/tmp/pd-state';
  const statsFile = path.join(stateDir, 'hygiene-stats.json');

  beforeEach(() => {
    vi.clearAllMocks();
    (fs.existsSync as any).mockImplementation((p: string) => false);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-11T12:00:00Z'));
  });

  it('should initialize with empty stats if file does not exist', () => {
    const tracker = new HygieneTracker(stateDir);
    const stats = tracker.getStats();
    expect(stats.date).toBe('2026-03-11');
    expect(stats.persistenceCount).toBe(0);
    expect(fs.mkdirSync).toHaveBeenCalledWith(stateDir, { recursive: true });
  });

  it('should record and verify JSON content on persistence', () => {
    const tracker = new HygieneTracker(stateDir);
    tracker.recordPersistence({
      ts: '2026-03-11T12:05:00Z',
      tool: 'write_file',
      path: 'memory/notes.md',
      type: 'memory',
      contentLength: 500
    });

    const stats = tracker.getStats();
    expect(stats.persistenceCount).toBe(1);
    expect(stats.totalCharsPersisted).toBe(500);
    expect(stats.persistenceByFile['notes.md']).toBe(1);

    // Verify write content
    expect(fs.writeFileSync).toHaveBeenCalled();
    const lastWriteCall = vi.mocked(fs.writeFileSync).mock.calls[0];
    const writtenData = JSON.parse(lastWriteCall[1] as string);
    expect(writtenData['2026-03-11'].persistenceCount).toBe(1);
  });

  it('should reset stats when date changes', () => {
    const tracker = new HygieneTracker(stateDir);
    tracker.recordPersistence({
      ts: '2026-03-11T12:00:00Z',
      tool: 'write_file',
      path: 'memory/old.md',
      type: 'memory',
      contentLength: 100
    });

    expect(tracker.getStats().persistenceCount).toBe(1);

    // Move to next day
    vi.setSystemTime(new Date('2026-03-12T09:00:00Z'));
    
    const newStats = tracker.getStats();
    expect(newStats.date).toBe('2026-03-12');
    expect(newStats.persistenceCount).toBe(0); // Should be reset
  });

  it('should handle corrupted JSON gracefully', () => {
    (fs.existsSync as any).mockImplementation((p: string) => p === statsFile);
    (fs.readFileSync as any).mockReturnValue('invalid json {');
    
    const tracker = new HygieneTracker(stateDir);
    expect(tracker.getStats().persistenceCount).toBe(0);
    expect(fs.renameSync).toHaveBeenCalled(); // Should backup corrupted file
  });
});
