// Probe: measure behavior-pack case ruleContext/history sizes against the prompt budget
import { readFileSync } from 'node:fs';
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
  const measure = (label, v) => console.log(label.padEnd(34), String(JSON.stringify(v).length).padStart(7));
  measure('neg.params', pack.sourceNegativeCase.params);
  measure('neg.ruleContext', pack.sourceNegativeCase.ruleContext);
  const h = pack.sourceNegativeCase.ruleContext?.history;
  if (h && Array.isArray(h.calls)) {
    console.log('   neg.history.calls:', h.calls.length);
    h.calls.forEach((c, i) => measure('   call[' + i + ']', c));
  }
  pack.positiveCounterexamples.forEach((p, i) => {
    measure('pos[' + i + '].params', p.params);
    measure('pos[' + i + '].ruleContext', p.ruleContext);
    const hh = p.ruleContext?.history;
    if (hh && Array.isArray(hh.calls)) {
      console.log('   pos[' + i + '].calls:', hh.calls.length);
      hh.calls.forEach((c, j) => measure('   pcall[' + j + ']', c));
    }
  });
} finally { RuleHostEvidenceRegistry.dispose(workspaceDir); }
