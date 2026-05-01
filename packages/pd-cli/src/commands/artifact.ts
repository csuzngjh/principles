/**
 * pd artifact show command — Artifact registry inspection.
 *
 * Usage:
 *   pd artifact show <artifactId> --workspace <path> [--json]
 */
import {
  RuntimeStateManager,
  artifactShow,
} from '@principles/core/runtime-v2';
import { resolveWorkspaceDir } from '../resolve-workspace.js';

interface ArtifactShowOptions {
  artifactId: string;
  workspace?: string;
  json?: boolean;
}

/**
 * pd artifact show <artifactId> [--workspace <path>] [--json]
 *
 * Shows artifact content and its associated principle candidates.
 * Returns: artifactId, runId, taskId, artifactKind, contentJson, createdAt, candidates[].
 */
export async function handleArtifactShow(opts: ArtifactShowOptions): Promise<void> {
  const workspaceDir: string = resolveWorkspaceDir(opts.workspace);
  const stateManager = new RuntimeStateManager({ workspaceDir });

  try {
    await stateManager.initialize();

    const result = await artifactShow({
      artifactId: opts.artifactId,
      stateManager,
    });

    if (!result) {
      console.error(`Artifact not found: ${opts.artifactId}`);
      process.exit(1);
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`\nArtifact: ${result.artifactId}\n`);
    console.log(`  Kind:       ${result.artifactKind}`);
    console.log(`  Run:        ${result.runId}`);
    console.log(`  Task:       ${result.taskId}`);
    console.log(`  Created:    ${result.createdAt}`);
    console.log(`  Candidates: ${result.candidates.length}`);

    // Pretty-print the JSON content
    try {
      const parsed = JSON.parse(result.contentJson);
      console.log(`\n  Content (parsed):`);
      console.log(`    diagnosisId: ${parsed.diagnosisId ?? 'N/A'}`);
      console.log(`    summary:     ${parsed.summary ?? 'N/A'}`);
      if (parsed.recommendations) {
        console.log(`    recommendations: ${parsed.recommendations.length}`);
        const principles = parsed.recommendations.filter((r: { kind: string }) => r.kind === 'principle');
        if (principles.length > 0) {
          console.log(`      (${principles.length} principle candidates)`);
        }
      }
    } catch {
      console.log(`  Content:    ${result.contentJson.substring(0, 200)}...`);
    }

    if (result.candidates.length > 0) {
      console.log(`\n  Candidate Details:`);
      for (const c of result.candidates) {
        console.log(`    - ${c.candidateId} | ${c.title} | ${c.status}`);
      }
    }

    console.log('');
  } finally {
    await stateManager.close();
  }
}