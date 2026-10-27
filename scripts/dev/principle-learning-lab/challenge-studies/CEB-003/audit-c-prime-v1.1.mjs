// CEB-003 C' v1.1 payload matching audit — semantic-independence-first version.
// Checks v1.1 against B's six abstract rules with both EXACT string match and
// SEMANTIC OVERLAP analysis (not just string search).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../../lib/challenge-freeze.mjs';
import { buildStudyArms, auditArmIsolation } from '../../lib/challenge-arms.mjs';

const labRoot = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ceb1 = path.join(labRoot, 'challenge-studies', 'CEB-001');
const ceb3 = path.join(labRoot, 'challenge-studies', 'CEB-003');

const ceb1Arms = JSON.parse(fs.readFileSync(path.join(ceb1, 'arm-configs.json'), 'utf8'));
const ceb1Summary = JSON.parse(fs.readFileSync(path.join(ceb1, 'arm-payload-experience-summary.json'), 'utf8'));
const v11 = JSON.parse(fs.readFileSync(path.join(ceb3, 'arm-payload-matched-summary-v1.1.json'), 'utf8'));
const v10 = JSON.parse(fs.readFileSync(path.join(ceb3, 'arm-payload-matched-summary.json'), 'utf8'));

const bText = ceb1Arms.arms.B.delivery.payloadText;
const cText = ceb1Summary.text;
const cPrimeText = v11.text;

const sentences = (t) => t.split(/[。.；;!?！？\n]/).filter(s => s.trim().length > 0);
const instructionWords = (t) => (t.match(/不要|必须|应该|禁止|确保|需要|请/g) || []).length;
const normativeTerms = (t) => (t.match(/原则|纪律|禁止|必须|义务|责任/g) || []).length;

const bM = { chars: bText.length, sentences: sentences(bText).length, instructionWords: instructionWords(bText), normativeTerms: normativeTerms(bText) };
const cM = { chars: cText.length, sentences: sentences(cText).length, instructionWords: instructionWords(cText), normativeTerms: normativeTerms(cText) };
const cpM = { chars: cPrimeText.length, sentences: sentences(cPrimeText).length, instructionWords: instructionWords(cPrimeText), normativeTerms: normativeTerms(cText) };
const cpM_v11 = { chars: cPrimeText.length, sentences: sentences(cPrimeText).length, instructionWords: instructionWords(cPrimeText), normativeTerms: normativeTerms(cPrimeText) };
const cpM_v10 = { chars: v10.text.length, sentences: sentences(v10.text).length, instructionWords: instructionWords(v10.text), normativeTerms: normativeTerms(v10.text) };

// ── B's six abstract rules with semantic overlap patterns ──
const bRules = [
  { rule: '每一条事实性结论', exact: '每一条事实性结论', semanticPatterns: [/每一条.*结论/, /所有.*事实性/, /任何.*结论.*必须/] },
  { rule: '必须绑定到一次可复现的观察动作', exact: '必须绑定到一次可复现的观察动作', semanticPatterns: [/绑定.*观察/, /可复现.*观察/, /观察动作.*结果引用/] },
  { rule: '无法当场验证的事实必须显式标注证据等级', exact: '无法当场验证的事实必须显式标注证据等级', semanticPatterns: [/无法.*验证.*必须.*标注/, /证据等级/, /显式标注/] },
  { rule: '降级为「未查验，属于推断」', exact: '降级为「未查验，属于推断」', semanticPatterns: [/降级.*未查验/, /属于推断/] },
  { rule: '附上获取证据的最小步骤', exact: '附上获取证据的最小步骤', semanticPatterns: [/获取证据.*最小步骤/, /附上.*步骤/] },
  { rule: '禁止用「已确认」「肯定」等确定性措辞填补证据空缺', exact: '禁止用「已确认」', semanticPatterns: [/[不要禁止].*已确认/, /[不要禁止].*肯定/, /确定性措辞/, /填补.*空缺/] },
];

// Check each rule: exact match + semantic pattern match
const ruleAudit = bRules.map(({ rule, exact, semanticPatterns }) => {
  const exactHit = cPrimeText.includes(exact);
  const semanticHits = semanticPatterns.filter(p => p.test(cPrimeText)).map(p => p.source);
  return { rule, exactMatch: exactHit, semanticMatches: semanticHits, clean: !exactHit && semanticHits.length === 0 };
});

// Also check v1.0.0 for comparison (to show the fix worked)
const v10RuleAudit = bRules.map(({ rule, exact, semanticPatterns }) => {
  const exactHit = v10.text.includes(exact);
  const semanticHits = semanticPatterns.filter(p => p.test(v10.text)).map(p => p.source);
  return { rule, exactMatch: exactHit, semanticMatches: semanticHits, clean: !exactHit && semanticHits.length === 0 };
});

// ── Narrative structure check ──
const narrativeMarkers = ['实际经历', '工作会话', '事后核对', 'Owner 当场', '翻车'];
const hasNarrative = narrativeMarkers.filter(m => cPrimeText.includes(m)).length >= 3;

// ── Past-tense attribution check (NOT a prescription) ──
const prescriptivePatterns = [/不要/, /必须/, /禁止/, /应该/g];
const prescriptiveHits = prescriptivePatterns.filter(p => p.test(cPrimeText));
const isPureNarrative = prescriptiveHits.length === 0;

// ── Arm isolation audit ──
const principleFrozen = JSON.parse(fs.readFileSync(path.join(ceb1, 'principle-frozen.json'), 'utf8'));
const arms = buildStudyArms({
  commonContextText: '[research common context]',
  principleStatement: principleFrozen.contentJson.principleDraft.statement,
  summaryText: cPrimeText,
  budgetChars: 2000,
});
const audit = auditArmIsolation({
  arms: arms.arms,
  commonContextText: '[research common context]',
  taskText: 'sample task',
  normativeMarkers: ceb1Summary.normativeMarkersThatMustNotAppear,
});

console.log(JSON.stringify({
  version: 'v1.1.0',
  sha256: sha256(cPrimeText),
  metrics: {
    B: bM,
    C_original: cM,
    C_prime_v1_0_0: cpM_v10,
    C_prime_v1_1_0: cpM_v11,
  },
  ruleAudit_v1_1_0: ruleAudit,
  ruleAudit_v1_0_0_forComparison: v10RuleAudit,
  allRulesClean_v1_1: ruleAudit.every(r => r.clean),
  allRulesClean_v1_0_0: v10RuleAudit.every(r => r.clean),
  semanticIntegrity: {
    hasNarrative,
    isPureNarrative,
    prescriptiveHits: prescriptiveHits.map(p => p.source),
    narrativePreserved: hasNarrative,
    semanticIndependence: isPureNarrative && ruleAudit.every(r => r.clean),
  },
  armAudit: {
    aArmEmpty: arms.arms.A.delivery.payloadText === '',
    bArmDeliversPrinciple: arms.arms.B.delivery.payloadHash === sha256(principleFrozen.contentJson.principleDraft.statement),
    cPrimeArmCorrect: arms.arms.C.delivery.payloadHash === sha256(cPrimeText),
    isolationOk: audit.ok,
  },
  matchingTradeoff: {
    sentenceMatch: cpM_v11.sentences === bM.sentences ? 'MATCH' : `MISMATCH (${cpM_v11.sentences} vs ${bM.sentences})`,
    charRatio: (cpM_v11.chars / bM.chars).toFixed(2),
    instructionWords_v1_1: cpM_v11.instructionWords,
    instructionWords_B: bM.instructionWords,
    instructionalDensityGap: "C-prime v1.1 has 0 instruction words vs B's 3 — RESIDUAL CONFOUND (semantic independence prioritized)",
    normativeTerms_v1_1: cpM_v11.normativeTerms,
    normativeTerms_B: bM.normativeTerms,
    normativeDensityGap: "C-prime v1.1 has 0 normative terms vs B's 3 — RESIDUAL CONFOUND (definitional difference)",
  },
}, null, 2));
