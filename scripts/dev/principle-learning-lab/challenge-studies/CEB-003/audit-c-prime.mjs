// CEB-003 C' payload matching audit — read-only analysis of B vs C vs C'.
// Runs all §2 checks from the Owner instruction. Zero network, zero model calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../lib/challenge-freeze.mjs';
import { buildStudyArms, auditArmIsolation } from '../../lib/challenge-arms.mjs';

const labRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ceb1 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const ceb3 = path.join(labRoot, 'challenge-studies', 'CEB-003');

// Load all three payloads
const ceb1Arms = JSON.parse(fs.readFileSync(path.join(ceb1, 'arm-configs.json'), 'utf8'));
const ceb1Summary = JSON.parse(fs.readFileSync(path.join(ceb1, 'arm-payload-experience-summary.json'), 'utf8'));
const ceb3Payload = JSON.parse(fs.readFileSync(path.join(ceb3, 'arm-payload-matched-summary.json'), 'utf8'));

const bText = ceb1Arms.arms.B.delivery.payloadText;
const cText = ceb1Summary.text;
const cPrimeText = ceb3Payload.text;

// ── Analysis helpers ──
const sentences = (t) => t.split(/[。.；;!?！？\n]/).filter(s => s.trim().length > 0);
const instructionWords = (t) => (t.match(/不要|必须|应该|禁止|确保|需要|请/g) || []).length;
const normativeTerms = (t) => (t.match(/原则|纪律|禁止|必须|义务|责任/g) || []).length;
const conditionals = (t) => (t.match(/如果|若|当.*时|一旦|因为/g) || []).length;
const digits = (t) => (t.match(/\d/g) || []).length;
const certaintyWords = (t) => (t.match(/已确认|肯定|绝对|一定|肯定/g) || []).length;

// ── 1. Basic matching metrics ──
const metrics = (label, text) => ({
  label,
  chars: text.length,
  sentences: sentences(text).length,
  instructionWords: instructionWords(text),
  normativeTerms: normativeTerms(text),
  conditionals: conditionals(text),
  digits: digits(text),
  sha256: sha256(text),
});

const bM = metrics('B (principle)', bText);
const cM = metrics('C (original summary)', cText);
const cpM = metrics("C' (matched summary)", cPrimeText);

// ── 2. Matching ratios ──
const ratio = (a, b, label) => ({
  label,
  B: b,
  C_prime: a,
  ratio: b === 0 ? 'N/A' : (a / b).toFixed(2),
  acceptable: label === 'chars' ? Math.abs(a / b - 1) <= 0.20 : Math.abs(a / b - 1) <= 0.50,
});

const matching = [
  ratio(cpM.chars, bM.chars, 'chars'),
  ratio(cpM.sentences, bM.sentences, 'sentences'),
  ratio(cpM.instructionWords, bM.instructionWords, 'instructionWords'),
  ratio(cpM.normativeTerms, bM.normativeTerms, 'normativeTerms'),
];

// ── 3. B's abstract rules must NOT appear in C' ──
const bRules = [
  '每一条事实性结论',
  '必须绑定到一次可复现的观察动作',
  '无法当场验证的事实必须显式标注证据等级',
  '降级为「未查验，属于推断」',
  '附上获取证据的最小步骤',
  '禁止用「已确认」',
];
const ruleLeaks = bRules.filter(rule => cPrimeText.includes(rule));

// ── 4. Normative markers from C must NOT appear (they define B's semantics) ──
const normativeMarkers = ceb1Summary.normativeMarkersThatMustNotAppear;
const markerLeaks = normativeMarkers.filter(m => cPrimeText.includes(m));

// ── 5. Semantic distinction check ──
// C' should still be recognizably a narrative/experience summary, not an abstract principle
const narrativeMarkers = ['实际经历', '工作会话', '事后核对', 'Owner 当场', '翻车'];
const hasNarrativeStructure = narrativeMarkers.filter(m => cPrimeText.includes(m)).length >= 3;

// C' should NOT be a rule list (no "每一条/所有/任何…必须…" pattern)
const isRuleList = /每一条|所有.*必须|任何.*应当/.test(cPrimeText);

// ── 6. Arm isolation audit (build arms with C' as the C arm) ──
const principleFrozen = JSON.parse(fs.readFileSync(path.join(ceb1, 'principle-frozen.json'), 'utf8'));
const arms = buildStudyArms({
  commonContextText: '[research common context]', // simplified for audit
  principleStatement: principleFrozen.contentJson.principleDraft.statement,
  summaryText: cPrimeText,
  budgetChars: 2000,
});
// Check A arm is empty (no payload)
const aIsEmpty = arms.arms.A.delivery.payloadText === '';
// Check B arm delivers the exact frozen principle statement
const bDeliversPrinciple = arms.arms.B.delivery.payloadHash === sha256(principleFrozen.contentJson.principleDraft.statement);
// Check C' arm has the matched summary
const cPrimeHash = arms.arms.C.delivery.payloadHash === sha256(cPrimeText);

// Run the static isolation audit
let isolationAudit;
try {
  const audit = auditArmIsolation({
    arms: arms.arms,
    commonContextText: '[research common context]',
    taskText: 'sample task text for audit purposes',
    normativeMarkers,
  });
  isolationAudit = audit;
} catch (e) {
  isolationAudit = { ok: false, problems: [e.message] };
}

// ── Output ──
console.log(JSON.stringify({
  metrics: { B: bM, C: cM, C_prime: cpM },
  matching,
  originalCRatio: {
    sentences: (cM.sentences / bM.sentences).toFixed(2),
    chars: (cM.chars / bM.chars).toFixed(2),
  },
  cPrimeVsB: {
    sentenceRatio: (cpM.sentences / bM.sentences).toFixed(2),
    charRatio: (cpM.chars / bM.chars).toFixed(2),
    instructionRatio: cpM.instructionWords === bM.instructionWords ? 'MATCH' : (cpM.instructionWords / bM.instructionWords).toFixed(2),
  },
  semanticIntegrity: {
    ruleLeaks: ruleLeaks.length === 0 ? 'PASS (no B abstract rules found in C\')' : `FAIL: ${ruleLeaks.join(', ')}`,
    normativeMarkerLeaks: markerLeaks.length === 0 ? 'PASS' : `WARNING: ${markerLeaks.join(', ')}`,
    hasNarrativeStructure,
    isRuleList,
    narrativePreserved: hasNarrativeStructure && !isRuleList,
  },
  armAudit: {
    aArmEmpty: aIsEmpty,
    bArmDeliversPrinciple: bDeliversPrinciple,
    cPrimeArmCorrect: cPrimeHash,
    isolationAudit,
  },
  verdict: {
    charMatch: Math.abs(cpM.chars / bM.chars - 1) <= 0.20 ? 'PASS' : 'FAIL',
    sentenceMatch: Math.abs(cpM.sentences / bM.sentences - 1) <= 0.50 ? 'PASS' : 'FAIL',
    instructionMatch: Math.abs(cpM.instructionWords - bM.instructionWords) <= 1 ? 'PASS' : 'PARTIAL',
    noRuleLeak: ruleLeaks.length === 0 ? 'PASS' : 'FAIL',
    narrativePreserved: hasNarrativeStructure && !isRuleList ? 'PASS' : 'FAIL',
    isolation: isolationAudit.ok ? 'PASS' : 'FAIL',
  },
}, null, 2));
