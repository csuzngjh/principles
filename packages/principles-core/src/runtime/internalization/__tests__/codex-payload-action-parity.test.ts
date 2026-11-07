/**
 * SPEC-RULECODE-QUALITY-001 A2 / Q23 — original-payload consumer consistency.
 *
 * Desensitized payloads captured from the real Codex host shape (isolated
 * probe `REVIEW-RF01-RF03-PROBE.json`, source commit e2ecbdd0a) must flow
 * through the production action builder and the replay builder with
 * IDENTICAL action semantics — same normalizedPath, same paramsSummary, same
 * canonicalKind — because both consumers thread the same projectDir and
 * ToolSemanticRegistry into the one shared buildRuleHostAction.
 *
 * Pins the honest capability boundary (RF-03): normalizedPath may be COMMAND
 * TEXT when no file target can be extracted (never null on this contract —
 * the empty path is the empty string), so substring rules see the command,
 * and a read-only search quoting "git commit" is still command text. The
 * parity test forbids the two consumers from drifting apart.
 */
import { describe, expect, it } from 'vitest';
import { buildRuleHostAction, deriveToolHintsFromCanonicalKind } from '../rule-host-input-builder.js';
import { createSyntheticRuleHostInput } from '../../golden-trace.js';
import { buildToolSemanticRegistry } from '../tool-semantic-registry.js';

/**
 * Codex-shaped registry, mirroring the evidence-bound declaration in
 * codex-adapter's tool-semantics.ts (Bash→execute, apply_patch→write). Core
 * tests cannot import the codex-adapter package; the local mirror keeps the
 * payload shapes truthful (the probe that captured them resolved through the
 * real Codex registry) without a reverse dependency.
 */
const registryResult = buildToolSemanticRegistry([
  { rawToolName: 'Bash', canonicalKind: 'execute' },
  { rawToolName: 'apply_patch', canonicalKind: 'write' },
]);
if (!registryResult.ok) throw new Error('codex-shaped tool semantic registry failed to build');
const toolSemantics = registryResult.registry;

const PROJECT_DIR = 'C:/work/project';

interface DesensitizedPayload {
  case: string;
  toolName: string;
  params: Record<string, unknown>;
}

/** Desensitized real-shape Codex payloads (commands are synthetic; shapes are real). */
const PAYLOADS: readonly DesensitizedPayload[] = [
  { case: 'git-commit', toolName: 'Bash', params: { command: 'git commit -m "x"' } },
  { case: 'git-commit-with-C', toolName: 'Bash', params: { command: 'git -C . commit -m "x"' } },
  { case: 'readonly-rg-quoting-git', toolName: 'Bash', params: { command: 'rg "git commit" docs/' } },
  { case: 'pathless-unknown-tool', toolName: 'unknown_tool', params: {} },
  { case: 'write-file', toolName: 'write_file', params: { file_path: 'src/a.ts', content: 'x' } },
];

describe('SPEC-RULECODE-QUALITY-001 Q23 — production/replay action parity on desensitized Codex payloads', () => {
  for (const payload of PAYLOADS) {
    it(`production and replay derive the identical action for ${payload.case}`, () => {
      const canonicalKind = toolSemantics.resolve(payload.toolName);
      const { isBashTool: isBash, isWriteTool: isWrite } = deriveToolHintsFromCanonicalKind(canonicalKind);
      const productionAction = buildRuleHostAction(
        payload.toolName,
        payload.params,
        PROJECT_DIR,
        { isBashTool: isBash, isWriteTool: isWrite, ...(canonicalKind !== undefined ? { canonicalKind } : {}) },
      );

      const replayInput = createSyntheticRuleHostInput(
        { toolName: payload.toolName, params: payload.params },
        {},
        { projectDir: PROJECT_DIR, toolSemantics },
      );

      expect(replayInput.action).toEqual(productionAction);
    });
  }

  it('pins the honest semantics: command text stays command text; the pathless empty path is "" (never null)', () => {
    const canonicalKind = toolSemantics.resolve('Bash');
    const { isBashTool: isBash, isWriteTool: isWrite } = deriveToolHintsFromCanonicalKind(canonicalKind);
    const action = buildRuleHostAction('Bash', { command: 'git -C . commit -m "x"' }, PROJECT_DIR, { isBashTool: isBash, isWriteTool: isWrite, canonicalKind });
    // A rule matching on normalizedPath substrings sees the COMMAND — this is
    // exactly how the original bad artifact missed `git -C` variants when it
    // treated the field as a file path.
    expect(action.normalizedPath).toBe('git -C . commit -m "x"');
    expect(action.canonicalKind).toBe('execute');

    const search = buildRuleHostAction('Bash', { command: 'rg "git commit" docs/' }, PROJECT_DIR, { isBashTool: isBash, isWriteTool: isWrite, canonicalKind });
    // A read-only search whose TEXT contains "git commit" — a substring rule
    // keyed on 'git commit' misfires here; the parity contract keeps this
    // observable instead of pretending to parse shell.
    expect(search.normalizedPath).toContain('git commit');
    expect(search.canonicalKind).toBe('execute');

    const pathlessKind = toolSemantics.resolve('unknown_tool');
    const pathless = buildRuleHostAction('unknown_tool', {}, PROJECT_DIR, { ...(pathlessKind !== undefined ? { canonicalKind: pathlessKind } : {}) });
    expect(pathless.normalizedPath).toBe('');
    expect(pathless.canonicalKind).toBe('other');

    const writeKind = toolSemantics.resolve('write_file') ?? 'write';
    const write = buildRuleHostAction('write_file', { file_path: 'src/a.ts', content: 'x' }, PROJECT_DIR, { canonicalKind: writeKind });
    expect(write.normalizedPath).toContain('src');
    expect(write.canonicalKind).toBe('write');
  });
});
