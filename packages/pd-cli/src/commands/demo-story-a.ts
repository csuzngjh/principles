import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { runStoryADemo } from '../services/demo-story-a-runner.js';
import type { MvpChannel } from '@principles/core/runtime-v2';

interface DemoStoryAOptions {
  workspace?: string;
  json?: boolean;
  channels?: string;
  /** Developer override for the demo-isolation guard (default false). */
  allowDemoWriteToExistingWorkspace?: boolean;
}

/**
 * Demo isolation guard (2026-08-19): a demo run writes task/artifact/approval/
 * activation rows into its target workspace. Refuse by default when the target
 * already contains real PD state so demo data can never masquerade as
 * owner-generated history. Detection = any marker of initialized PD state.
 */
function workspaceHasPdState(workspaceDir: string): boolean {
  return fs.existsSync(path.join(workspaceDir, '.pd', 'state.db'))
    || fs.existsSync(path.join(workspaceDir, '.pd', 'config.yaml'))
    || fs.existsSync(path.join(workspaceDir, '.principles', 'PROFILE.json'));
}

function formatStage(stage: { name: string; status: string; reason?: string; evidenceRef?: string }): string {
  const icon = stage.status === 'passed' ? '✓' : stage.status === 'degraded' ? '⚠' : '✗';
  let line = `  ${icon} ${stage.name}: ${stage.status}`;
  if (stage.evidenceRef) line += ` (ref: ${stage.evidenceRef})`;
  if (stage.reason) line += `\n    reason: ${stage.reason}`;
  return line;
}

function formatChannelOutcome(ch: { channel: string; status: string; failureReason?: string; evidenceSource: string }): string {
  const icon = ch.status === 'passed' ? '✓' : ch.status === 'degraded' ? '⚠' : '✗';
  const lines: string[] = [];
  lines.push(`  ${icon} ${ch.channel}: ${ch.status}`);
  lines.push(`    source: ${ch.evidenceSource}`);
  if (ch.failureReason) {
    lines.push(`    reason: ${ch.failureReason}`);
  }
  return lines.join('\n');
}

function formatTextOutput(result: Record<string, unknown>): string {
  const lines: string[] = [];
  const status = result.status as string;
  const icon = status === 'passed' ? '✓' : status === 'degraded' ? '⚠' : '✗';

  lines.push('PD Story A\' Demo (PRI-246)');
  lines.push(`generatedAt: ${result.generatedAt as string}`);
  lines.push(`OVERALL: ${icon} ${status.toUpperCase()}`);
  lines.push('');

  if (result.inputValidationFailure) {
    const ivf = result.inputValidationFailure as Record<string, unknown>;
    lines.push('Input Validation Failure:');
    lines.push(`  reason: ${ivf.reason as string}`);
    lines.push(`  message: ${ivf.message as string}`);
    lines.push(`  nextAction: ${ivf.nextAction as string}`);
    lines.push('');
  }

  lines.push('Stages:');
  for (const stage of result.stages as Record<string, unknown>[]) {
    lines.push(formatStage(stage as { name: string; status: string; reason?: string; evidenceRef?: string }));
  }

  lines.push('');
  lines.push('Channel Outcomes:');
  for (const ch of result.channelOutcomes as Record<string, unknown>[]) {
    lines.push(formatChannelOutcome(ch as { channel: string; status: string; failureReason?: string; evidenceSource: string }));
  }

  lines.push('');
  lines.push(`Runtime V2 Exclusive: ${result.isRuntimeV2Exclusive ? 'Yes' : 'No'}`);

  lines.push('');
  lines.push('--- Narrative ---');
  lines.push(result.narrative as string);

  return lines.join('\n');
}

export function cleanupTempWorkspace(workspaceDir: string, rmSyncImpl: (dir: string, opts: { recursive: boolean; force: boolean }) => void = fs.rmSync.bind(fs)): void {
  try {
    rmSyncImpl(workspaceDir, { recursive: true, force: true });
  } catch (cleanupErr) {
    const cleanupMsg = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
    console.error(`[pd-cli] cleanup warning: failed to remove temp workspace ${workspaceDir}: ${cleanupMsg}`);
  }
}

interface ParseChannelResult {
  channels: MvpChannel[] | undefined;
  unknowns: string[];
}

function parseChannelList(raw: string | undefined): ParseChannelResult {
  if (!raw || raw.trim().length === 0) {
    // Empty string means user explicitly passed --channels "" → treat as empty request
    if (raw !== undefined) return { channels: [], unknowns: [] };
    return { channels: undefined, unknowns: [] };
  }
  const parts = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length === 0) return { channels: [], unknowns: [] };
  const valid: MvpChannel[] = [];
  const unknowns: string[] = [];
  const mvpSet = new Set<string>(['prompt', 'code_tool_hook', 'defer_archive']);
  for (const part of parts) {
    if (mvpSet.has(part)) {
      valid.push(part as MvpChannel);
    } else {
      unknowns.push(part);
    }
  }
  return { channels: valid.length > 0 ? valid : undefined, unknowns };
}

export async function handleDemoStoryA(opts: DemoStoryAOptions): Promise<void> {
  const workspaceDir = opts.workspace
    ? path.resolve(opts.workspace)
    : fs.mkdtempSync(path.join(os.tmpdir(), 'pd-story-a-'));

  // Demo isolation (cli-5: failure must not mutate): refuse BEFORE creating
  // the RuntimeStateManager or writing anything when the target workspace
  // already carries PD state and the developer override was not passed.
  if (opts.workspace && !opts.allowDemoWriteToExistingWorkspace && workspaceHasPdState(workspaceDir)) {
    const errorResult = {
      status: 'refused' as const,
      generatedAt: new Date().toISOString(),
      narrative: 'Refused: demo would write into an existing PD workspace.',
      storyDescription: 'Demo isolation guard',
      stages: [],
      channelOutcomes: [],
      isRuntimeV2Exclusive: true,
      refusal: {
        reason: 'demo_write_to_existing_workspace',
        message: 'This command would write demo artifacts into an existing PD workspace.',
        nextAction: 'Use a temporary workspace (omit --workspace), or pass --allow-demo-write-to-existing-workspace to explicitly opt in (developer only).',
        targetWorkspace: workspaceDir,
      },
    };
    if (opts.json) {
      console.log(JSON.stringify(errorResult, null, 2));
    } else {
      console.error('Refused: this command would write demo artifacts into an existing PD workspace.');
      console.error(`Target: ${workspaceDir}`);
      console.error('Use a temporary workspace (omit --workspace), or pass --allow-demo-write-to-existing-workspace to explicitly opt in (developer only).');
    }
    process.exitCode = 1;
    return;
  }

  const parsed = parseChannelList(opts.channels);

  // Fail loud on empty channels before workspace creation (ERR-029)
  if (parsed.channels?.length === 0) {
    const errorResult = {
      status: 'failed' as const,
      generatedAt: new Date().toISOString(),
      narrative: 'No channels specified.',
      storyDescription: 'Input validation failed',
      stages: [],
      channelOutcomes: [],
      isRuntimeV2Exclusive: true,
      inputValidationFailure: {
        reason: 'empty_channels',
        message: 'No channels specified. At least one MVP channel required.',
        nextAction: 'Provide channels: prompt, code_tool_hook, defer_archive',
      },
    };
    if (opts.json) {
      console.log(JSON.stringify(errorResult, null, 2));
    } else {
      console.error('Error: No channels specified. At least one MVP channel required.');
      console.error('Valid channels: prompt, code_tool_hook, defer_archive');
    }
    process.exitCode = 1;
    if (!opts.workspace) {
      cleanupTempWorkspace(workspaceDir);
    }
    return;
  }

  // Fail loud on unknown channels (ERR-029)
  if (parsed.unknowns.length > 0) {
    const errorResult = {
      status: 'failed' as const,
      generatedAt: new Date().toISOString(),
      narrative: `Unknown channels: ${parsed.unknowns.join(', ')}`,
      storyDescription: 'Input validation failed',
      stages: [],
      channelOutcomes: [],
      isRuntimeV2Exclusive: true,
      inputValidationFailure: {
        reason: 'unknown_channels',
        message: `Unknown channels: ${parsed.unknowns.join(', ')}. Valid: prompt, code_tool_hook, defer_archive`,
        nextAction: 'Use only valid MVP channels: prompt, code_tool_hook, defer_archive',
        unknownChannels: parsed.unknowns,
      },
    };
    if (opts.json) {
      console.log(JSON.stringify(errorResult, null, 2));
    } else {
      console.error(`Error: Unknown channels: ${parsed.unknowns.join(', ')}`);
      console.error('Valid channels: prompt, code_tool_hook, defer_archive');
    }
    process.exitCode = 1;
    if (!opts.workspace) {
      cleanupTempWorkspace(workspaceDir);
    }
    return;
  }

  try {
    const result = await runStoryADemo({
      channels: parsed.channels,
      workspaceDir,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatTextOutput(result as unknown as Record<string, unknown>));
    }

    if (result.status !== 'passed') {
      if (!opts.json) {
        console.error('');
        console.error(`FAIL: status=${result.status}`);
      }
      process.exitCode = 1;
    }
  } finally {
    if (!opts.workspace) {
      cleanupTempWorkspace(workspaceDir);
    }
  }
}
