import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ThinkingModelsConsoleModel } from '../../src/server/models/ThinkingModelsConsoleModel.js';
import { createTestWorkspace, cleanupTestWorkspace, sampleThinkingOsMd } from '../test-utils.js';
import type { TestWorkspace } from '../test-utils.js';

describe('ThinkingModelsConsoleModel with real file data', () => {
  let ws: TestWorkspace;
  let model: ThinkingModelsConsoleModel;

  beforeEach(async () => {
    ws = await createTestWorkspace({
      tasks: [],
      candidates: [],
      principles: [],
      thinkingOs: sampleThinkingOsMd(),
    });
    model = new ThinkingModelsConsoleModel(ws.workspaceDir);
  });

  afterEach(() => {
    model.dispose();
    cleanupTestWorkspace(ws);
  });

  it('getOverview parses directives from THINKING_OS.md', () => {
    const overview = model.getOverview();

    expect(overview.totalModels).toBe(2);
    expect(overview.source).toBe('workspace');
    expect(overview.models.length).toBe(2);
  });

  it('getOverview extracts directive fields correctly', () => {
    const overview = model.getOverview();
    const errorPrevention = overview.models.find(m => m.id === 'error-prevention');

    expect(errorPrevention).toBeDefined();
    expect(errorPrevention!.name).toBe('Error Prevention');
    expect(errorPrevention!.trigger).toContain('tool call fails');
    expect(errorPrevention!.must).toContain('Analyze the error');
    expect(errorPrevention!.forbidden).toContain('Ignoring errors');
  });

  it('getModelDetail returns specific directive by id', () => {
    const detail = model.getModelDetail('user-alignment');

    expect(detail).not.toBeNull();
    expect(detail!.id).toBe('user-alignment');
    expect(detail!.name).toBe('User Alignment');
    expect(detail!.trigger).toContain('ambiguous');
  });

  it('getModelDetail returns null for unknown id', () => {
    const detail = model.getModelDetail('nonexistent');
    expect(detail).toBeNull();
  });

  it('caches overview within TTL', () => {
    const first = model.getOverview();
    const second = model.getOverview();
    expect(first).toBe(second);
  });

  it('returns empty when no THINKING_OS.md exists', async () => {
    const emptyWs = await createTestWorkspace();
    const emptyModel = new ThinkingModelsConsoleModel(emptyWs.workspaceDir);

    try {
      const overview = emptyModel.getOverview();
      expect(overview.totalModels).toBe(0);
      expect(overview.models).toEqual([]);
      expect(overview.source).toBe('none');
    } finally {
      emptyModel.dispose();
      cleanupTestWorkspace(emptyWs);
    }
  });

  it('reads from .state subdirectory if root file missing', async () => {
    const wsNoRoot = await createTestWorkspace();
    fs.writeFileSync(
      path.join(wsNoRoot.stateDir, 'THINKING_OS.md'),
      sampleThinkingOsMd(),
      'utf8',
    );
    const stateModel = new ThinkingModelsConsoleModel(wsNoRoot.workspaceDir);

    try {
      const overview = stateModel.getOverview();
      expect(overview.totalModels).toBe(2);
      expect(overview.source).toBe('workspace');
    } finally {
      stateModel.dispose();
      cleanupTestWorkspace(wsNoRoot);
    }
  });

  it('handles malformed THINKING_OS.md gracefully', async () => {
    const wsBad = await createTestWorkspace();
    fs.writeFileSync(
      path.join(wsBad.workspaceDir, 'THINKING_OS.md'),
      'This is not valid thinking OS content at all',
      'utf8',
    );
    const badModel = new ThinkingModelsConsoleModel(wsBad.workspaceDir);

    try {
      const overview = badModel.getOverview();
      expect(overview.totalModels).toBe(0);
      expect(overview.source).toBe('none');
    } finally {
      badModel.dispose();
      cleanupTestWorkspace(wsBad);
    }
  });
});
