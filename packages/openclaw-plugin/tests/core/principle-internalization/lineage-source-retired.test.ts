import { describe, expect, it } from 'vitest';
import { FilesystemLifecycleDatasource, LineageSourceRetiredError } from '../../../src/core/principle-internalization/filesystem-lifecycle-datasource.js';
import { buildLifecycleReadModel } from '@principles/core/runtime-v2';

describe('LineageSourceRetiredError regression guard (PRI-230)', () => {
  it('listLineageRecords throws LineageSourceRetiredError, not return []', () => {
    const ds = new FilesystemLifecycleDatasource('/tmp/nonexistent', '/tmp/nonexistent');
    expect(() => ds.listLineageRecords('rule-implementation-candidate')).toThrow(LineageSourceRetiredError);
  });

  it('LineageSourceRetiredError message mentions PRI-230 and nocturnal-artifact-lineage', () => {
    const ds = new FilesystemLifecycleDatasource('/tmp/nonexistent', '/tmp/nonexistent');
    try {
      ds.listLineageRecords('rule-implementation-candidate');
      expect.unreachable('Should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(LineageSourceRetiredError);
      const message = (err as LineageSourceRetiredError).message;
      expect(message).toContain('PRI-230');
      expect(message).toContain('nocturnal-artifact-lineage');
    }
  });

  it('LineageSourceRetiredError has correct name property', () => {
    const err = new LineageSourceRetiredError();
    expect(err.name).toBe('LineageSourceRetiredError');
  });

  it('retired datasource does not return empty array that could be misinterpreted as "no lineage"', () => {
    const ds = new FilesystemLifecycleDatasource('/tmp/nonexistent', '/tmp/nonexistent');
    let returnedEmptyArray = false;
    try {
      const result = ds.listLineageRecords('rule-implementation-candidate');
      returnedEmptyArray = Array.isArray(result) && result.length === 0;
    } catch {
      // expected
    }
    expect(returnedEmptyArray).toBe(false);
  });
});

describe('buildLifecycleReadModel with retired lineage source (PRI-230)', () => {
  it('produces lineageEvidence with sourceRetired=true when datasource throws LineageSourceRetiredError', () => {
    const ds = new FilesystemLifecycleDatasource('/tmp/nonexistent', '/tmp/nonexistent');
    let model: ReturnType<typeof buildLifecycleReadModel>;
    expect(() => {
      model = buildLifecycleReadModel(ds);
    }).not.toThrow();

    const rules = model!.principles.flatMap((p) => p.rules);
    for (const rule of rules) {
      expect(rule.lineageEvidence.sourceRetired).toBe(true);
      expect(rule.lineageEvidence.records).toEqual([]);
    }
  });
});
