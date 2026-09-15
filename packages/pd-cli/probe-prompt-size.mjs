// Probe: measure the FULL artificer promptInput components against the 50k cap
import { readFileSync } from 'node:fs';
import { ArtificerPromptBuilder } from '@principles/core/runtime-v2';
import { RuntimeStateManager } from '@principles/core/runtime-v2';

const workspaceDir = 'D:/.openclaw/workspace';
const { BehaviorExamplePackAssembler, RuleHostEvidenceRegistry } = await import('principles-disciple/rulehost-evidence');
const examples = JSON.parse(readFileSync('D:/pd-labs/ep002r4-behavior/behavior-examples.json', 'utf8'));
try {
  const assembler = new BehaviorExamplePackAssembler({ workspaceDir, stateDir: workspaceDir + '/.state' });
  const pack = assembler.assemble({
    sourcePainId: 'pain_host_cffdcb9f5d02576d1e211436008f124778b4564fb1cf0230cc96ef03faf0c2f1',
    ownerDesiredOutcome: examples.ownerDesiredOutcome,
    sourceNegativeToolCallId: examples.sourceNegativeToolCallId,
    positiveToolCallIds: examples.positiveToolCallIds,
    projectDir: workspaceDir,
  });
  const sm = new RuntimeStateManager({ workspaceDir });
  await sm.initialize();
  // find the code-channel scribe task from the last successful run
  const tasks = await sm.listTasks();
  const scribeTask = tasks.filter(t => t.taskKind === 'scribe' && t.status === 'succeeded' && (t.taskId.includes('mu2q') || t.taskId.includes('mu2'))).pop();
  console.log('scribe task:', scribeTask?.taskId.slice(-30));
  const arts = await sm.piArtifactStore.listBySourceTaskId(scribeTask.taskId);
  const scribeArtifact = arts.find(a => a.artifactKind === 'principle');
  console.log('scribe contentJson chars:', scribeArtifact.contentJson.length);
  const parsedScribe = JSON.parse(scribeArtifact.contentJson);
  for (const [k, v] of Object.entries(parsedScribe)) console.log('  scribe.' + k.padEnd(28), String(JSON.stringify(v).length).padStart(7));
  await sm.close();

  const builder = new ArtificerPromptBuilder();
  try {
    const r = builder.buildPrompt({ behaviorExamplePack: pack, taskId: 'probe', contextHash: 'x', sourceScribeArtifactId: scribeArtifact.artifactId, scribeArtifact: parsedScribe });
    console.log('PROMPT OK, message chars:', r.message.length);
  } catch (err) {
    console.log('PROMPT THREW:', err instanceof Error ? err.message : String(err));
    // manual component measurement
    const boundedPack = JSON.stringify(pack).length;
    console.log('pack (unbounded input to builder):', boundedPack);
  }
} catch (err) {
  console.log('PROBE FAILED:', err instanceof Error ? err.message : String(err));
} finally {
  RuleHostEvidenceRegistry.dispose(workspaceDir);
}
