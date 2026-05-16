/**
 * Error categories unit tests.
 *
 * Tests the canonical error category system added in PRI-137:
 * - workspace_dirty error category
 * - isPDErrorCategory type guard
 * - FAILURE_CATEGORY_MAP mappings
 * - mapFailureCategory utility
 * - PDRuntimeError class
 */
import { describe, it, expect } from 'vitest';
import {
  PD_ERROR_CATEGORIES,
  isPDErrorCategory,
  FAILURE_CATEGORY_MAP,
  mapFailureCategory,
  PDRuntimeError,
  PDErrorCategorySchema,
} from '../error-categories.js';

describe('PD_ERROR_CATEGORIES', () => {
  it('contains all expected error categories', () => {
    const expected = [
      'runtime_unavailable',
      'capability_missing',
      'input_invalid',
      'lease_conflict',
      'lease_expired',
      'execution_failed',
      'timeout',
      'cancelled',
      'output_invalid',
      'artifact_commit_failed',
      'max_attempts_exceeded',
      'context_assembly_failed',
      'history_not_found',
      'trajectory_ambiguous',
      'storage_unavailable',
      'workspace_invalid',
      'workspace_dirty',
      'query_invalid',
    ];
    expect(PD_ERROR_CATEGORIES).toEqual(expected);
  });

  it('includes workspace_dirty category (added in PRI-137)', () => {
    expect(PD_ERROR_CATEGORIES).toContain('workspace_dirty');
  });
});

describe('isPDErrorCategory', () => {
  it('returns true for valid error categories', () => {
    expect(isPDErrorCategory('runtime_unavailable')).toBe(true);
    expect(isPDErrorCategory('workspace_dirty')).toBe(true);
    expect(isPDErrorCategory('timeout')).toBe(true);
    expect(isPDErrorCategory('execution_failed')).toBe(true);
  });

  it('returns false for invalid error categories', () => {
    expect(isPDErrorCategory('invalid_category')).toBe(false);
    expect(isPDErrorCategory('')).toBe(false);
    expect(isPDErrorCategory('WORKSPACE_DIRTY')).toBe(false);
    expect(isPDErrorCategory('workspace-dirty')).toBe(false);
    expect(isPDErrorCategory(null as unknown as string)).toBe(false);
    expect(isPDErrorCategory(undefined as unknown as string)).toBe(false);
  });
});

describe('FAILURE_CATEGORY_MAP', () => {
  it('maps workspace_dirty to artifact_missing (critical for PRI-137)', () => {
    expect(FAILURE_CATEGORY_MAP['workspace_dirty']).toBe('artifact_missing');
  });

  it('maps all PD_ERROR_CATEGORIES to failure categories', () => {
    for (const category of PD_ERROR_CATEGORIES) {
      expect(FAILURE_CATEGORY_MAP[category]).toBeDefined();
      expect(typeof FAILURE_CATEGORY_MAP[category]).toBe('string');
    }
  });

  it('maps runtime_unavailable errors correctly', () => {
    expect(FAILURE_CATEGORY_MAP['runtime_unavailable']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['lease_conflict']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['lease_expired']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['execution_failed']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['history_not_found']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['trajectory_ambiguous']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['context_assembly_failed']).toBe('runtime_unavailable');
    expect(FAILURE_CATEGORY_MAP['query_invalid']).toBe('runtime_unavailable');
  });

  it('maps timeout errors correctly', () => {
    expect(FAILURE_CATEGORY_MAP['timeout']).toBe('runtime_timeout');
    expect(FAILURE_CATEGORY_MAP['cancelled']).toBe('runtime_timeout');
    expect(FAILURE_CATEGORY_MAP['max_attempts_exceeded']).toBe('runtime_timeout');
  });

  it('maps config errors correctly', () => {
    expect(FAILURE_CATEGORY_MAP['capability_missing']).toBe('config_missing');
    expect(FAILURE_CATEGORY_MAP['input_invalid']).toBe('config_missing');
    expect(FAILURE_CATEGORY_MAP['workspace_invalid']).toBe('config_missing');
  });

  it('maps ledger errors correctly', () => {
    expect(FAILURE_CATEGORY_MAP['storage_unavailable']).toBe('ledger_write_failed');
  });
});

describe('mapFailureCategory', () => {
  it('returns correct failure category for valid input', () => {
    expect(mapFailureCategory('workspace_dirty')).toBe('artifact_missing');
    expect(mapFailureCategory('timeout')).toBe('runtime_timeout');
    expect(mapFailureCategory('runtime_unavailable')).toBe('runtime_unavailable');
  });

  it('returns null for null/undefined input', () => {
    expect(mapFailureCategory(null)).toBeNull();
    expect(mapFailureCategory(undefined)).toBeNull();
  });

  it('returns null for empty string (falsy value)', () => {
    expect(mapFailureCategory('')).toBeNull();
  });

  it('returns runtime_unavailable for invalid error category', () => {
    expect(mapFailureCategory('invalid_error')).toBe('runtime_unavailable');
  });

  it('handles workspace_dirty as critical case for PRI-137', () => {
    expect(mapFailureCategory('workspace_dirty')).not.toBe('runtime_unavailable');
    expect(mapFailureCategory('workspace_dirty')).toBe('artifact_missing');
  });
});

describe('PDRuntimeError', () => {
  it('creates error with category and message', () => {
    const error = new PDRuntimeError('workspace_dirty', 'Workspace contains uncommitted changes');
    expect(error.category).toBe('workspace_dirty');
    expect(error.message).toBe('[workspace_dirty] Workspace contains uncommitted changes');
    expect(error.name).toBe('PDRuntimeError');
  });

  it('includes optional details', () => {
    const error = new PDRuntimeError('workspace_dirty', 'Workspace dirty', {
      dirtyFiles: ['file1.ts', 'file2.ts'],
      workspaceDir: '/path/to/workspace',
    });
    expect(error.details).toEqual({
      dirtyFiles: ['file1.ts', 'file2.ts'],
      workspaceDir: '/path/to/workspace',
    });
  });

  it('is instanceof Error', () => {
    const error = new PDRuntimeError('execution_failed', 'Test error');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof PDRuntimeError).toBe(true);
  });

  it('supports all error categories', () => {
    for (const category of PD_ERROR_CATEGORIES) {
      const error = new PDRuntimeError(category, `Test for ${category}`);
      expect(error.category).toBe(category);
    }
  });
});

describe('PDErrorCategorySchema (TypeBox)', () => {
  it('is defined and can be used with isPDErrorCategory', () => {
    expect(PDErrorCategorySchema).toBeDefined();
    expect(typeof PDErrorCategorySchema).toBe('object');
    expect(isPDErrorCategory('workspace_dirty')).toBe(true);
    expect(isPDErrorCategory('timeout')).toBe(true);
  });
});
