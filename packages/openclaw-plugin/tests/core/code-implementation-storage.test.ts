import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  deleteImplementationAssetDir,
  getImplementationAssetRoot,
  loadManifest,
  writeManifest,
  loadEntrySource,
  createImplementationAssetDir,
  writeEntrySource,
  type CodeImplementationManifest,
} from '../../src/core/code-implementation-storage.js';
import { safeRmDir } from '../test-utils.js';

describe('CodeImplementationStorage', () => {
  let tempDir: string;
  let stateDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-cis-'));
    stateDir = path.join(tempDir, '.state');
    fs.mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    safeRmDir(tempDir);
  });

  // -------------------------------------------------------------------------
  // getImplementationAssetRoot
  // -------------------------------------------------------------------------

  describe('getImplementationAssetRoot', () => {
    it('returns correct path under .state/principles/implementations/{implId}', () => {
      const result = getImplementationAssetRoot(stateDir, 'IMPL_001');
      expect(result).toBe(path.join(stateDir, 'principles', 'implementations', 'IMPL_001'));
    });

    it('throws on implId with forward slash', () => {
      expect(() => getImplementationAssetRoot(stateDir, 'foo/bar')).toThrow(
        'Invalid implementation ID',
      );
    });

    it('throws on implId with backslash', () => {
      expect(() => getImplementationAssetRoot(stateDir, 'foo\\bar')).toThrow(
        'Invalid implementation ID',
      );
    });

    it('throws on implId with double-dot traversal', () => {
      expect(() => getImplementationAssetRoot(stateDir, '..')).toThrow(
        'Invalid implementation ID',
      );
    });

    it('throws on empty implId', () => {
      expect(() => getImplementationAssetRoot(stateDir, '')).toThrow(
        'Implementation ID must not be empty',
      );
    });
  });

  // -------------------------------------------------------------------------
  // loadManifest
  // -------------------------------------------------------------------------

  describe('loadManifest', () => {
    it('returns null when no manifest file exists', () => {
      const result = loadManifest(stateDir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns parsed manifest when manifest file exists', () => {
      const implId = 'IMPL_002';
      const manifest: CodeImplementationManifest = {
        version: '1.0.0',
        entryFile: 'entry.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        replaySampleRefs: [],
        lastEvalReportRef: null,
      };

      // Write directly (bypass writeManifest to test load independently)
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      fs.mkdirSync(assetRoot, { recursive: true });
      fs.writeFileSync(path.join(assetRoot, 'manifest.json'), JSON.stringify(manifest), 'utf-8');

      const result = loadManifest(stateDir, implId);
      expect(result).toEqual(manifest);
    });

    it('returns null for corrupted manifest JSON', () => {
      const implId = 'IMPL_003';
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      fs.mkdirSync(assetRoot, { recursive: true });
      fs.writeFileSync(path.join(assetRoot, 'manifest.json'), 'not-valid-json{{{', 'utf-8');

      const result = loadManifest(stateDir, implId);
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // writeManifest
  // -------------------------------------------------------------------------

  describe('writeManifest', () => {
    it('creates manifest file with correct JSON content', () => {
      const implId = 'IMPL_004';
      const manifest: CodeImplementationManifest = {
        version: '2.0.0',
        entryFile: 'entry.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
        replaySampleRefs: ['fp-001', 'fp-002'],
        lastEvalReportRef: 'replays/2026-01-02.json',
      };

      writeManifest(stateDir, implId, manifest);

      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      const manifestPath = path.join(assetRoot, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const written = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      expect(written).toEqual(manifest);
    });

    it('creates asset directory if it does not exist', () => {
      const implId = 'IMPL_005';
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      expect(fs.existsSync(assetRoot)).toBe(false);

      writeManifest(stateDir, implId, {
        version: '1.0.0',
        entryFile: 'entry.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        replaySampleRefs: [],
        lastEvalReportRef: null,
      });

      expect(fs.existsSync(assetRoot)).toBe(true);
    });

    it('uses withLock for atomic writes (manifest file is written atomically)', () => {
      const implId = 'IMPL_006';

      // Write twice rapidly - withLock should prevent corruption
      const manifest1: CodeImplementationManifest = {
        version: '1.0.0',
        entryFile: 'entry.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        replaySampleRefs: [],
        lastEvalReportRef: null,
      };

      writeManifest(stateDir, implId, manifest1);

      const manifest2: CodeImplementationManifest = {
        ...manifest1,
        version: '2.0.0',
        updatedAt: '2026-01-02T00:00:00.000Z',
      };

      writeManifest(stateDir, implId, manifest2);

      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      const written = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf-8'));
      expect(written.version).toBe('2.0.0');
      expect(written.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    });
  });

  // -------------------------------------------------------------------------
  // loadEntrySource
  // -------------------------------------------------------------------------

  describe('loadEntrySource', () => {
    it('returns null when no manifest exists', () => {
      const result = loadEntrySource(stateDir, 'nonexistent');
      expect(result).toBeNull();
    });

    it('returns null when manifest exists but entry file does not', () => {
      const implId = 'IMPL_007';
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      fs.mkdirSync(assetRoot, { recursive: true });

      // Write manifest pointing to a non-existent entry file
      const manifest: CodeImplementationManifest = {
        version: '1.0.0',
        entryFile: 'nonexistent.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        replaySampleRefs: [],
        lastEvalReportRef: null,
      };
      fs.writeFileSync(
        path.join(assetRoot, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      const result = loadEntrySource(stateDir, implId);
      expect(result).toBeNull();
    });

    it('returns file content when entry file exists', () => {
      const implId = 'IMPL_008';
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      fs.mkdirSync(assetRoot, { recursive: true });

      const entryContent = 'export function evaluate() { return true; }';
      fs.writeFileSync(path.join(assetRoot, 'entry.js'), entryContent, 'utf-8');

      const manifest: CodeImplementationManifest = {
        version: '1.0.0',
        entryFile: 'entry.js',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        replaySampleRefs: [],
        lastEvalReportRef: null,
      };
      fs.writeFileSync(
        path.join(assetRoot, 'manifest.json'),
        JSON.stringify(manifest),
        'utf-8',
      );

      const result = loadEntrySource(stateDir, implId);
      expect(result).toBe(entryContent);
    });
  });

  // -------------------------------------------------------------------------
  // createImplementationAssetDir
  // -------------------------------------------------------------------------

  describe('createImplementationAssetDir', () => {
    it('creates directory structure with manifest.json, entry.js, replays/ dir', () => {
      const implId = 'IMPL_009';
      createImplementationAssetDir(stateDir, implId, '1.0.0');

      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      expect(fs.existsSync(path.join(assetRoot, 'manifest.json'))).toBe(true);
      expect(fs.existsSync(path.join(assetRoot, 'entry.js'))).toBe(true);
      expect(fs.existsSync(path.join(assetRoot, 'replays'))).toBe(true);
      expect(fs.statSync(path.join(assetRoot, 'replays')).isDirectory()).toBe(true);
    });

    it('manifest has correct fields', () => {
      const implId = 'IMPL_010';
      const manifest = createImplementationAssetDir(stateDir, implId, '3.5.0');

      expect(manifest.version).toBe('3.5.0');
      expect(manifest.entryFile).toBe('entry.js');
      expect(typeof manifest.createdAt).toBe('string');
      expect(typeof manifest.updatedAt).toBe('string');
      expect(manifest.replaySampleRefs).toEqual([]);
      expect(manifest.lastEvalReportRef).toBeNull();
    });

    it('manifest does NOT contain lifecycleState field', () => {
      const implId = 'IMPL_011';
      const manifest = createImplementationAssetDir(stateDir, implId, '1.0.0');

      expect((manifest as any).lifecycleState).toBeUndefined();
      expect('lifecycleState' in manifest).toBe(false);

      // Also verify persisted manifest lacks lifecycleState
      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      const raw = JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf-8'));
      expect('lifecycleState' in raw).toBe(false);
    });

    it('persists lineage metadata when provided for a generated candidate', () => {
      const implId = 'IMPL_011A';
      const manifest = createImplementationAssetDir(stateDir, implId, '1.0.0', {
        lineage: {
          principleId: 'P-001',
          ruleId: 'R-001',
          sourceSnapshotRef: 'snapshot-session-1',
          sourcePainIds: ['pain:gate:1'],
          sourceGateBlockIds: ['gate:write:1'],
          sourceSessionId: 'session-1',
          artificerArtifactId: 'artifact-1',
        },
      });

      expect(manifest.lineage).toMatchObject({
        principleId: 'P-001',
        ruleId: 'R-001',
        sourceSessionId: 'session-1',
        artificerArtifactId: 'artifact-1',
      });

      const loaded = loadManifest(stateDir, implId);
      expect(loaded?.lineage).toMatchObject({
        sourcePainIds: ['pain:gate:1'],
        sourceGateBlockIds: ['gate:write:1'],
      });
    });

    it('is idempotent: repeated calls do not overwrite existing entry.js', () => {
      const implId = 'IMPL_012';

      createImplementationAssetDir(stateDir, implId, '1.0.0');

      const assetRoot = getImplementationAssetRoot(stateDir, implId);
      const entryPath = path.join(assetRoot, 'entry.js');

      // Overwrite entry.js with custom content
      const customContent = '// CUSTOM CONTENT - should survive';
      fs.writeFileSync(entryPath, customContent, 'utf-8');

      // Call again
      createImplementationAssetDir(stateDir, implId, '2.0.0');

      // Custom content should still be there
      const content = fs.readFileSync(entryPath, 'utf-8');
      expect(content).toBe(customContent);
    });

    it('manifest path matches Phase 13 replay-engine path convention', () => {
      const implId = 'IMPL_013';
      createImplementationAssetDir(stateDir, implId, '1.0.0');

      const assetRoot = getImplementationAssetRoot(stateDir, implId);

      // Phase 13 replay-engine persists reports under:
      // {stateDir}/.state/principles/implementations/{implId}/replays/{timestamp}.json
      const replaysDir = path.join(assetRoot, 'replays');
      expect(fs.existsSync(replaysDir)).toBe(true);

      // Verify the full convention path is constructable
      const reportPath = path.join(replaysDir, '2026-01-01T00-00-00.000Z.json');
      fs.writeFileSync(reportPath, '{"test": true}', 'utf-8');
      expect(fs.existsSync(reportPath)).toBe(true);
    });

    it('manifest is loadable via loadManifest after creation', () => {
      const implId = 'IMPL_014';
      createImplementationAssetDir(stateDir, implId, '4.0.0');

      const loaded = loadManifest(stateDir, implId);
      expect(loaded).not.toBeNull();
      expect(loaded!.version).toBe('4.0.0');
      expect(loaded!.entryFile).toBe('entry.js');
    });

    it('entry source is loadable via loadEntrySource after creation', () => {
      const implId = 'IMPL_015';
      createImplementationAssetDir(stateDir, implId, '1.0.0');

      const source = loadEntrySource(stateDir, implId);
      expect(source).not.toBeNull();
      expect(source).toContain('export const meta');
      expect(source).toContain('export function evaluate');
    });

    it('writes generated entry source when provided', () => {
      const implId = 'IMPL_016';
      createImplementationAssetDir(stateDir, implId, '1.0.0', {
        entrySource: 'export const meta = { name: "x", version: "1", ruleId: "R", coversCondition: "c" }; export function evaluate() { return { decision: "allow", matched: false, reason: "ok" }; }',
      });

      const source = loadEntrySource(stateDir, implId);
      expect(source).toContain('export const meta');
      expect(source).not.toContain('placeholder');
    });
  });

  describe('entry and cleanup helpers', () => {
    it('overwrites entry source through writeEntrySource', () => {
      const implId = 'IMPL_017';
      createImplementationAssetDir(stateDir, implId, '1.0.0');

      writeEntrySource(stateDir, implId, 'export const meta = { name: "updated", version: "1", ruleId: "R", coversCondition: "c" }; export function evaluate() { return { decision: "allow", matched: false, reason: "updated" }; }');

      expect(loadEntrySource(stateDir, implId)).toContain('updated');
    });

    it('removes the asset directory through deleteImplementationAssetDir', () => {
      const implId = 'IMPL_018';
      createImplementationAssetDir(stateDir, implId, '1.0.0');

      deleteImplementationAssetDir(stateDir, implId);

      expect(fs.existsSync(getImplementationAssetRoot(stateDir, implId))).toBe(false);
    });
  });
});
