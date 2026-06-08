/**
 * Tests for config-reader — readOutputLanguageFromWorkspace (PRI-336).
 *
 * Validates:
 * - No config file → legitimate default, no warning
 * - No principles section → legitimate default, no warning
 * - No outputLanguage key → legitimate default, no warning
 * - Read error → degraded with read_error reason + nextAction (ERR-002/009)
 * - YAML parse error → degraded with yaml_parse_error reason + nextAction
 * - Invalid config root → degraded with invalid_config_root reason + nextAction
 * - Invalid principles structure → degraded with invalid_principles_structure reason + nextAction
 * - Valid outputLanguage → resolved value
 * - Invalid outputLanguage value → degraded with invalid value warning
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readOutputLanguageFromWorkspace } from '../../src/config-reader.js';

// Mock fs and yaml
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('js-yaml', () => ({
  default: {
    load: vi.fn(),
    JSON_SCHEMA: 'JSON_SCHEMA',
  },
}));

import * as fs from 'fs';
import yaml from 'js-yaml';

const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockYamlLoad = vi.mocked(yaml.load);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readOutputLanguageFromWorkspace', () => {
  it('returns default with no warning when config file does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns default with no warning when principles section is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('version: 1\n');
    mockYamlLoad.mockReturnValue({ version: 1 });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns default with no warning when outputLanguage key is missing', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('version: 1\nprinciples: {}\n');
    mockYamlLoad.mockReturnValue({ version: 1, principles: {} });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns valid outputLanguage when configured', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('version: 1\nprinciples:\n  outputLanguage: en\n');
    mockYamlLoad.mockReturnValue({ version: 1, principles: { outputLanguage: 'en' } });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('en');
    expect(result.degradationWarning).toBeUndefined();
  });

  it('returns degraded with read_error when readFileSync throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockImplementation(() => { throw new Error('EACCES: permission denied'); });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('Failed to read .pd/config.yaml');
    expect(result.degradationWarning).toContain('nextAction');
    expect(result.degradationWarning).toContain('Check file permissions');
  });

  it('returns degraded with yaml_parse_error when yaml.load throws', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('invalid: yaml: [broken');
    mockYamlLoad.mockImplementation(() => { throw new Error('YAML syntax error'); });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('Failed to parse .pd/config.yaml');
    expect(result.degradationWarning).toContain('nextAction');
    expect(result.degradationWarning).toContain('Fix YAML syntax');
  });

  it('returns degraded with invalid_config_root when parsed YAML is not an object', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('"just a string"');
    mockYamlLoad.mockReturnValue('just a string');
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('root is not an object');
    expect(result.degradationWarning).toContain('nextAction');
  });

  it('returns degraded with invalid_config_root when parsed YAML is an array', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('- item1\n- item2\n');
    mockYamlLoad.mockReturnValue(['item1', 'item2']);
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('root is not an object');
  });

  it('returns degraded with invalid_principles_structure when principles is not an object', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('version: 1\nprinciples: "not an object"\n');
    mockYamlLoad.mockReturnValue({ version: 1, principles: 'not an object' });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('principles field is not an object');
    expect(result.degradationWarning).toContain('nextAction');
  });

  it('returns degraded with invalid value warning when outputLanguage is invalid', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('version: 1\nprinciples:\n  outputLanguage: fr\n');
    mockYamlLoad.mockReturnValue({ version: 1, principles: { outputLanguage: 'fr' } });
    const result = readOutputLanguageFromWorkspace('/workspace');
    expect(result.outputLanguage).toBe('zh-CN');
    expect(result.degradationWarning).toContain('invalid');
    expect(result.degradationWarning).toContain('fr');
    expect(result.degradationWarning).toContain('nextAction');
  });
});
