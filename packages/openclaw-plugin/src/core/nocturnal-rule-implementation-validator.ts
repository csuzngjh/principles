import { createRuleHostHelpers, type RuleHostHelpers } from './rule-host-helpers.js';
import { loadRuleImplementationModule } from './rule-implementation-runtime.js';
import type {
  RuleHostDecision,
  RuleHostInput,
  RuleHostMeta,
  RuleHostResult,
} from './rule-host-types.js';

export interface RuleImplementationValidationFailure {
  code:
    | 'forbidden-api'
    | 'compile-error'
    | 'missing-meta'
    | 'invalid-meta'
    | 'missing-evaluate'
    | 'invalid-result';
  message: string;
  detail?: string;
}

export interface RuleImplementationValidationResult {
  passed: boolean;
  failures: RuleImplementationValidationFailure[];
  helperUsage: string[];
  normalizedSource?: string;
  meta?: RuleHostMeta;
}

const FORBIDDEN_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\beval\s*\(/, label: 'eval' },
  { pattern: /\bFunction\s*\(/, label: 'Function' },
  { pattern: /\bimport\s*\(/, label: 'dynamic import' },
  { pattern: /\brequire\s*\(/, label: 'require' },
  { pattern: /\bfetch\s*\(/, label: 'fetch' },
  { pattern: /\bXMLHttpRequest\b/, label: 'XMLHttpRequest' },
  { pattern: /\bchild_process\b/, label: 'child_process' },
  { pattern: /\bprocess\b/, label: 'process' },
  { pattern: /\bfs\b/, label: 'fs' },
  { pattern: /\bhttp\b/, label: 'http' },
  { pattern: /\bhttps\b/, label: 'https' },
  { pattern: /\bnet\b/, label: 'net' },
];

const HELPER_NAMES: (keyof RuleHostHelpers)[] = [
  'isRiskPath',
  'getToolName',
  'getEstimatedLineChanges',
  'getBashRisk',
  'hasPlanFile',
  'getPlanStatus',
  'getCurrentEpiTier',
];

function createValidationInput(): RuleHostInput {
  return {
    action: {
      toolName: 'write',
      normalizedPath: 'src/risk.ts',
      paramsSummary: {},
    },
    workspace: {
      isRiskPath: true,
      planStatus: 'DRAFT',
      hasPlanFile: true,
    },
    session: {
      sessionId: 'validator-session',
      currentGfi: 3,
      recentThinking: false,
    },
    evolution: {
      epTier: 2,
    },
    derived: {
      estimatedLineChanges: 42,
      bashRisk: 'normal',
    },
  };
}

function extractHelperUsage(sourceCode: string): string[] {
  return HELPER_NAMES.filter((helperName) =>
    new RegExp(`\\bhelpers\\.${helperName}\\b|\\b${helperName}\\s*\\(`).test(sourceCode)
  );
}

function validateMeta(meta: unknown): RuleImplementationValidationFailure[] {
  if (!meta || typeof meta !== 'object') {
    return [
      {
        code: 'missing-meta',
        message: 'Candidate must export a meta object.',
      },
    ];
  }

  const candidate = meta as Partial<RuleHostMeta>;
  const failures: RuleImplementationValidationFailure[] = [];

  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    failures.push({
      code: 'invalid-meta',
      message: 'meta.name must be a non-empty string.',
      detail: 'name',
    });
  }
  if (typeof candidate.version !== 'string' || candidate.version.trim().length === 0) {
    failures.push({
      code: 'invalid-meta',
      message: 'meta.version must be a non-empty string.',
      detail: 'version',
    });
  }
  if (typeof candidate.ruleId !== 'string' || candidate.ruleId.trim().length === 0) {
    failures.push({
      code: 'invalid-meta',
      message: 'meta.ruleId must be a non-empty string.',
      detail: 'ruleId',
    });
  }
  if (
    typeof candidate.coversCondition !== 'string' ||
    candidate.coversCondition.trim().length === 0
  ) {
    failures.push({
      code: 'invalid-meta',
      message: 'meta.coversCondition must be a non-empty string.',
      detail: 'coversCondition',
    });
  }

  return failures;
}

function validateResult(result: unknown): RuleImplementationValidationFailure[] {
  if (!result || typeof result !== 'object') {
    return [
      {
        code: 'invalid-result',
        message: 'evaluate must return a RuleHostResult object.',
      },
    ];
  }

  const candidate = result as Partial<RuleHostResult>;
  const failures: RuleImplementationValidationFailure[] = [];
  const allowedDecisions: RuleHostDecision[] = ['allow', 'block', 'requireApproval'];

  if (!allowedDecisions.includes(candidate.decision as RuleHostDecision)) {
    failures.push({
      code: 'invalid-result',
      message: 'evaluate.decision must be allow, block, or requireApproval.',
      detail: 'decision',
    });
  }
  if (typeof candidate.matched !== 'boolean') {
    failures.push({
      code: 'invalid-result',
      message: 'evaluate.matched must be a boolean.',
      detail: 'matched',
    });
  }
  if (typeof candidate.reason !== 'string') {
    failures.push({
      code: 'invalid-result',
      message: 'evaluate.reason must be a string.',
      detail: 'reason',
    });
  }

  return failures;
}

export function validateRuleImplementationCandidate(
  sourceCode: string
): RuleImplementationValidationResult {
  const helperUsage = extractHelperUsage(sourceCode);
  const failures: RuleImplementationValidationFailure[] = [];

  for (const forbidden of FORBIDDEN_PATTERNS) {
    if (forbidden.pattern.test(sourceCode)) {
      failures.push({
        code: 'forbidden-api',
        message: `Candidate uses forbidden API: ${forbidden.label}.`,
        detail: forbidden.label,
      });
    }
  }

  if (failures.length > 0) {
    return {
      passed: false,
      failures,
      helperUsage,
    };
  }

  const normalizedSource = sourceCode;

  try {
    const moduleExports = loadRuleImplementationModule(normalizedSource, 'nocturnal-candidate.js') as {
      meta?: unknown;
      /* eslint-disable no-unused-vars -- Reason: type signature parameters, unused by design in function type definition */
      evaluate?: (_input: RuleHostInput, _helpers: RuleHostHelpers) => unknown;
    };

    const metaFailures = validateMeta(moduleExports.meta);
    failures.push(...metaFailures);

    if (typeof moduleExports.evaluate !== 'function') {
      failures.push({
        code: 'missing-evaluate',
        message: 'Candidate must export an evaluate function.',
      });
    } else {
      const result = moduleExports.evaluate(
        createValidationInput(),
        createRuleHostHelpers(createValidationInput())
      );
      failures.push(...validateResult(result));
    }

    return {
      passed: failures.length === 0,
      failures,
      helperUsage,
      normalizedSource,
      meta: metaFailures.length === 0 ? (moduleExports.meta as RuleHostMeta) : undefined,
    };
  } catch (error: unknown) {
    return {
      passed: false,
      failures: [
        {
          code: 'compile-error',
          message: 'Candidate could not be compiled with RuleHost-compatible semantics.',
          detail: String(error),
        },
      ],
      helperUsage,
      normalizedSource,
    };
  }
}
