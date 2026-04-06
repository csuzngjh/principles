/**
 * Contract Enforcement Module
 * 
 * Defines strict schemas for agent output and provides validation functions.
 * Orchestrator MUST validate reports against these contracts before consuming.
 */

// ============================================================================
// Schema Definitions
// ============================================================================

/**
 * Producer Report Schema
 * Required sections for a valid producer report.
 */
export const PRODUCER_SCHEMA = {
  requiredSections: ['SUMMARY', 'CHANGES', 'EVIDENCE', 'CODE_EVIDENCE', 'KEY_EVENTS', 'HYPOTHESIS_MATRIX', 'CHECKS', 'OPEN_RISKS'],
  optionalSections: ['CONTRACT'],
  requiredFields: {
    CHECKS: { format: 'key=value pairs', example: 'evidence=ok;tests=not-run;scope=pd-only' },
  },
};

/**
 * Reviewer Report Schema
 * Required sections for a valid reviewer report.
 */
export const REVIEWER_SCHEMA = {
  requiredSections: ['VERDICT', 'BLOCKERS', 'FINDINGS', 'CODE_EVIDENCE', 'HYPOTHESIS_MATRIX', 'NEXT_FOCUS', 'CHECKS'],
  optionalSections: ['DIMENSIONS'],
  requiredFields: {
    VERDICT: { allowedValues: ['APPROVE', 'REVISE', 'BLOCK'], format: 'exact match' },
    CHECKS: { format: 'key=value pairs', example: 'criteria=met;blockers=0' },
  },
};

/**
 * Global Reviewer Report Schema
 * Required sections for a valid global reviewer report.
 */
export const GLOBAL_REVIEWER_SCHEMA = {
  requiredSections: ['VERDICT', 'MACRO_ANSWERS', 'BLOCKERS', 'FINDINGS', 'CODE_EVIDENCE', 'NEXT_FOCUS', 'CHECKS'],
  optionalSections: [],
  requiredFields: {
    VERDICT: { allowedValues: ['APPROVE', 'REVISE', 'BLOCK'], format: 'exact match' },
  },
};

/**
 * Output Quality Levels
 */
export const OUTPUT_QUALITY = {
  SHADOW_COMPLETE: 'shadow_complete',
  PRODUCTION_READY: 'production_ready',
  NEEDS_WORK: 'needs_work',
};

// ============================================================================
// Validation Result Types
// ============================================================================

/**
 * @typedef {Object} ContractValidationResult
 * @property {boolean} valid - Whether the report satisfies the contract
 * @property {string[]} missingSections - Sections required but not found
 * @property {string[]} invalidFields - Fields that don't match expected format
 * @property {Object} extractedData - Successfully extracted structured data
 * @property {string} errorSummary - Human-readable error summary
 */

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Check if a section exists in the report text.
 * Supports both "SECTION:" and "## SECTION" markdown formats.
 * 
 * @param {string} text - Report text
 * @param {string} heading - Section heading to find
 * @returns {boolean}
 */
export function hasSectionStrict(text, heading) {
  const source = String(text ?? '');
  // Match "SECTION:" at start of line
  const colonPattern = new RegExp(`(^|\\n)${heading}\\s*:`, 'i');
  // Match "## SECTION" markdown heading (with optional colon after)
  const mdPattern = new RegExp(`(^|\\n)##\\s+${heading}\\b`, 'i');
  return colonPattern.test(source) || mdPattern.test(source);
}

/**
 * Extract section content between headings.
 * 
 * @param {string} text - Report text
 * @param {string} heading - Section heading
 * @returns {string|null} Section content or null if not found
 */
export function extractSectionContent(text, heading) {
  const source = String(text ?? '');
  // Match section start
  const startPattern = new RegExp(`(?:^|\n)(?:##\s+)?${heading}\s*:?\n`, 'i');
  const startMatch = source.match(startPattern);
  if (!startMatch) return null;

  const contentStart = startMatch.index + startMatch[0].length;
  const afterStart = source.slice(contentStart);

  // Match next section (## HEADING or HEADING:)
  const endPattern = /\n(?:##\s+)?[A-Z][A-Z_ ]+\s*(:|\n)/;
  const endMatch = afterStart.match(endPattern);

  return endMatch ? afterStart.slice(0, endMatch.index).trim() : afterStart.trim();
}

/**
 * Validate VERDICT field against allowed values.
 * 
 * @param {string} text - Report text
 * @returns {{valid: boolean, value: string|null, error: string|null}}
 */
export function validateVerdict(text) {
  const source = String(text ?? '');
  // Strict pattern: VERDICT: followed by exactly APPROVE, REVISE, or BLOCK
  const pattern = /(?:VERDICT:\s*\*{0,2}|##\s*VERDICT\s*\n+\*{0,2}\s*)(APPROVE|REVISE|BLOCK)\b/i;
  const match = source.match(pattern);

  if (!match) {
    // Check if VERDICT section exists but has invalid value
    const loosePattern = /(?:VERDICT:\s*|##\s*VERDICT\s*\n+)([A-Z_]+)/i;
    const looseMatch = source.match(loosePattern);
    if (looseMatch) {
      return {
        valid: false,
        value: looseMatch[1].toUpperCase(),
        error: `Invalid VERDICT value "${looseMatch[1]}". Must be one of: APPROVE, REVISE, BLOCK`,
      };
    }
    return {
      valid: false,
      value: null,
      error: 'VERDICT section not found or malformed',
    };
  }

  return {
    valid: true,
    value: match[1].toUpperCase(),
    error: null,
  };
}

/**
 * Validate CHECKS field format (key=value pairs).
 * 
 * @param {string} text - Report text
 * @returns {{valid: boolean, value: Object, error: string|null}}
 */
export function validateChecks(text) {
  const source = String(text ?? '');
  const pattern = /CHECKS:\s*(.+?)(?:\n|$)/i;
  const match = source.match(pattern);

  if (!match) {
    return {
      valid: false,
      value: {},
      error: 'CHECKS field not found',
    };
  }

  const checksStr = match[1].trim();
  const checks = {};
  const invalidParts = [];

  for (const pair of checksStr.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      invalidParts.push(pair.trim());
      continue;
    }
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key) {
      checks[key] = value;
    }
  }

  if (invalidParts.length > 0) {
    return {
      valid: false,
      value: checks,
      error: `Invalid CHECKS format: "${invalidParts.join(', ')}". Expected key=value pairs separated by semicolons`,
    };
  }

  return {
    valid: true,
    value: checks,
    error: null,
  };
}

/**
 * Validate a producer report against the producer schema.
 * 
 * @param {string} text - Producer report text
 * @param {Object} options - Additional options
 * @param {string[]} options.requiredDeliverables - Contract deliverables required for this stage
 * @returns {ContractValidationResult}
 */
export function validateProducerReport(text, options = {}) {
  const source = String(text ?? '');
  const missingSections = [];
  const invalidFields = [];
  const extractedData = {};

  // Check required sections
  for (const section of PRODUCER_SCHEMA.requiredSections) {
    if (!hasSectionStrict(source, section)) {
      missingSections.push(section);
    }
  }

  // Validate CHECKS field
  const checksResult = validateChecks(source);
  if (!checksResult.valid) {
    invalidFields.push(`CHECKS: ${checksResult.error}`);
  } else {
    extractedData.checks = checksResult.value;
  }

  // Extract CONTRACT if deliverables are required
  if (options.requiredDeliverables && options.requiredDeliverables.length > 0) {
    if (!hasSectionStrict(source, 'CONTRACT')) {
      missingSections.push('CONTRACT');
    } else {
      const contractContent = extractSectionContent(source, 'CONTRACT');
      if (contractContent) {
        extractedData.contractContent = contractContent;
      }
    }
  }

  const valid = missingSections.length === 0 && invalidFields.length === 0;

  return {
    valid,
    missingSections,
    invalidFields,
    extractedData,
    errorSummary: valid
      ? null
      : `Producer report contract violation: missing sections [${missingSections.join(', ')}], invalid fields [${invalidFields.join(', ')}]`,
  };
}

/**
 * Validate a reviewer report against the reviewer schema.
 * 
 * @param {string} text - Reviewer report text
 * @param {Object} options - Additional options
 * @param {string[]} options.scoringDimensions - Required scoring dimensions
 * @returns {ContractValidationResult}
 */
export function validateReviewerReport(text, options = {}) {
  const source = String(text ?? '');
  const missingSections = [];
  const invalidFields = [];
  const extractedData = {};

  // Check required sections
  for (const section of REVIEWER_SCHEMA.requiredSections) {
    if (!hasSectionStrict(source, section)) {
      missingSections.push(section);
    }
  }

  // Validate VERDICT field (strict)
  const verdictResult = validateVerdict(source);
  if (!verdictResult.valid) {
    invalidFields.push(`VERDICT: ${verdictResult.error}`);
  } else {
    extractedData.verdict = verdictResult.value;
  }

  // Validate CHECKS field
  const checksResult = validateChecks(source);
  if (!checksResult.valid) {
    invalidFields.push(`CHECKS: ${checksResult.error}`);
  } else {
    extractedData.checks = checksResult.value;
  }

  // Check DIMENSIONS if scoring dimensions are required
  if (options.scoringDimensions && options.scoringDimensions.length > 0) {
    const dimsContent = extractSectionContent(source, 'DIMENSIONS');
    if (!dimsContent && !hasSectionStrict(source, 'DIMENSIONS')) {
      missingSections.push('DIMENSIONS');
    } else if (dimsContent) {
      extractedData.dimensionsContent = dimsContent;
    }
  }

  const valid = missingSections.length === 0 && invalidFields.length === 0;

  return {
    valid,
    missingSections,
    invalidFields,
    extractedData,
    errorSummary: valid
      ? null
      : `Reviewer report contract violation: missing sections [${missingSections.join(', ')}], invalid fields [${invalidFields.join(', ')}]`,
  };
}

/**
 * Validate a global reviewer report against the global reviewer schema.
 * 
 * @param {string} text - Global reviewer report text
 * @param {Object} options - Additional options
 * @param {string[]} options.requiredMacroQuestions - Required macro questions (Q1, Q2, etc.)
 * @returns {ContractValidationResult}
 */
export function validateGlobalReviewerReport(text, options = {}) {
  const source = String(text ?? '');
  const missingSections = [];
  const invalidFields = [];
  const extractedData = {};

  // Check required sections
  for (const section of GLOBAL_REVIEWER_SCHEMA.requiredSections) {
    if (!hasSectionStrict(source, section)) {
      missingSections.push(section);
    }
  }

  // Validate VERDICT field (strict)
  const verdictResult = validateVerdict(source);
  if (!verdictResult.valid) {
    invalidFields.push(`VERDICT: ${verdictResult.error}`);
  } else {
    extractedData.verdict = verdictResult.value;
  }

  // Check MACRO_ANSWERS completeness
  if (options.requiredMacroQuestions && options.requiredMacroQuestions.length > 0) {
    const macroContent = extractSectionContent(source, 'MACRO_ANSWERS');
    if (!macroContent) {
      missingSections.push('MACRO_ANSWERS');
    } else {
      const missingQuestions = [];
      for (const q of options.requiredMacroQuestions) {
        const qPattern = new RegExp(`\\b${q}\\b[^\\n]*`, 'i');
        if (!qPattern.test(macroContent)) {
          missingQuestions.push(q);
        }
      }
      if (missingQuestions.length > 0) {
        invalidFields.push(`MACRO_ANSWERS: missing answers for [${missingQuestions.join(', ')}]`);
      } else {
        extractedData.macroAnswersContent = macroContent;
      }
    }
  }

  const valid = missingSections.length === 0 && invalidFields.length === 0;

  return {
    valid,
    missingSections,
    invalidFields,
    extractedData,
    errorSummary: valid
      ? null
      : `Global reviewer report contract violation: missing sections [${missingSections.join(', ')}], invalid fields [${invalidFields.join(', ')}]`,
  };
}

/**
 * Validate all reports for a stage.
 * Returns a consolidated validation result.
 * 
 * @param {Object} reports - All role reports
 * @param {string} reports.producer - Producer report text
 * @param {string} reports.reviewerA - Reviewer A report text
 * @param {string} reports.reviewerB - Reviewer B report text
 * @param {string} [reports.globalReviewer] - Global reviewer report text (optional)
 * @param {Object} options - Validation options
 * @param {string[]} options.requiredDeliverables - Required contract deliverables
 * @param {string[]} options.scoringDimensions - Required scoring dimensions
 * @param {string[]} options.requiredMacroQuestions - Required macro questions for global reviewer
 * @param {boolean} options.globalReviewerRequired - Whether global reviewer is required
 * @returns {{valid: boolean, producer: ContractValidationResult, reviewerA: ContractValidationResult, reviewerB: ContractValidationResult, globalReviewer: ContractValidationResult|null, errorSummary: string|null}}
 */
export function validateStageReports(reports, options = {}) {
  const producer = validateProducerReport(reports.producer, {
    requiredDeliverables: options.requiredDeliverables,
  });

  const reviewerA = validateReviewerReport(reports.reviewerA, {
    scoringDimensions: options.scoringDimensions,
  });

  const reviewerB = validateReviewerReport(reports.reviewerB, {
    scoringDimensions: options.scoringDimensions,
  });

  let globalReviewer = null;
  if (options.globalReviewerRequired || reports.globalReviewer) {
    globalReviewer = validateGlobalReviewerReport(reports.globalReviewer || '', {
      requiredMacroQuestions: options.requiredMacroQuestions,
    });
  }

  const allValid = producer.valid && reviewerA.valid && reviewerB.valid && (globalReviewer ? globalReviewer.valid : true);

  const errors = [];
  if (!producer.valid) errors.push(producer.errorSummary);
  if (!reviewerA.valid) errors.push(reviewerA.errorSummary);
  if (!reviewerB.valid) errors.push(reviewerB.errorSummary);
  if (globalReviewer && !globalReviewer.valid) errors.push(globalReviewer.errorSummary);

  return {
    valid: allValid,
    producer,
    reviewerA,
    reviewerB,
    globalReviewer,
    errorSummary: allValid ? null : errors.join('\n'),
  };
}

// ============================================================================
// Output Quality Determination
// ============================================================================

/**
 * Determine output quality level based on validation and metrics.
 * 
 * SHADOW_COMPLETE criteria:
 * - All reports pass contract validation
 * - All reviewers APPROVE
 * - No blockers
 * - All required sections present
 * - Dimensions meet threshold (if applicable)
 * - Contract fulfilled (if applicable)
 * 
 * PRODUCTION_READY criteria (in addition to SHADOW_COMPLETE):
 * - CODE_EVIDENCE includes evidence_scope: both (cross-repo verification)
 * - All scoring dimensions >= 4 (not just meeting threshold)
 * - No OPEN_RISKS or OPEN_RISKS explicitly marked as "acceptable"
 * - MACRO_ANSWERS all satisfied with concrete evidence references
 * 
 * @param {Object} validation - Stage reports validation result
 * @param {Object} metrics - Stage metrics from decideStage
 * @param {Object} options - Additional options
 * @param {number} options.productionThreshold - Minimum dimension score for production_ready (default: 4)
 * @returns {{quality: string, reasons: string[]}}
 */
export function determineOutputQuality(validation, metrics, options = {}) {
  const productionThreshold = options.productionThreshold ?? 4;
  const reasons = [];

  // Check basic contract validation
  if (!validation.valid) {
    reasons.push('Reports do not satisfy contract validation');
    return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
  }

  // Check approval status
  if (metrics.approvalCount < (metrics.requiredApprovals ?? 2)) {
    reasons.push(`Insufficient approvals: ${metrics.approvalCount}/${metrics.requiredApprovals ?? 2}`);
    return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
  }

  // Check blockers
  if (metrics.blockerCount > 0) {
    reasons.push(`Unresolved blockers: ${metrics.blockerCount}`);
    return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
  }

  // Check dimension failures
  if (metrics.dimensionFailures && metrics.dimensionFailures.length > 0) {
    reasons.push(`Dimension failures: ${metrics.dimensionFailures.join('; ')}`);
    return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
  }

  // Check contract fulfillment
  if (metrics.requiredDeliverables && metrics.requiredDeliverables.length > 0) {
    if (!metrics.contractCheck || !metrics.contractCheck.allDone) {
      reasons.push('Contract not fulfilled');
      return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
    }
  }

  // Check global reviewer requirements
  if (metrics.globalReviewerRequired) {
    if (!metrics.macroAnswersAllSatisfied) {
      reasons.push('Macro answers not satisfied');
      return { quality: OUTPUT_QUALITY.NEEDS_WORK, reasons };
    }
  }

  // === SHADOW_COMPLETE threshold reached ===
  // Now check for PRODUCTION_READY

  const productionBlockers = [];

  // Check CODE_EVIDENCE scope (production requires cross-repo verification)
  // Must explicitly have evidence_scope: both for production ready
  const producerScope = metrics.producerCodeEvidence?.evidenceScope;
  if (!producerScope) {
    productionBlockers.push('Producer CODE_EVIDENCE missing evidence_scope field (required: "both")');
  } else if (producerScope !== 'both') {
    productionBlockers.push(`Producer CODE_EVIDENCE scope is "${producerScope}", not "both"`);
  }

  // Check dimension scores for production threshold
  // Check each reviewer separately - production requires ALL reviewers to score >= threshold
  if (metrics.scoringDimensions && metrics.scoringDimensions.length > 0) {
    for (const dim of metrics.scoringDimensions) {
    const scoreA = metrics.reviewerADimensions?.[dim];
    const scoreB = metrics.reviewerBDimensions?.[dim];
    if (scoreA !== undefined && scoreA < productionThreshold) {
      productionBlockers.push(`Dimension "${dim}" reviewer A scored ${scoreA}/5, below production threshold ${productionThreshold}`);
    }
    if (scoreB !== undefined && scoreB < productionThreshold) {
      productionBlockers.push(`Dimension "${dim}" reviewer B scored ${scoreB}/5, below production threshold ${productionThreshold}`);
    }
  }
}

  // If no production blockers, it's production ready
  if (productionBlockers.length === 0) {
    return { quality: OUTPUT_QUALITY.PRODUCTION_READY, reasons: [] };
  }

  // Otherwise it's shadow complete
  return {
    quality: OUTPUT_QUALITY.SHADOW_COMPLETE,
    reasons: productionBlockers,
  };
}

// ============================================================================
// Next Run Recommendation System
// ============================================================================

/**
 * Next Run Types
 */
export const NEXT_RUN_TYPE = {
  NONE: 'none',               // No follow-up run needed (production_ready)
  CONTINUATION: 'continuation', // Continue work in same stage/spec
  VERIFY: 'verify',            // Verify the output meets higher standard
  HANDOFF: 'handoff',          // Hand off to different spec/team
};

/**
 * Determine the recommended next run based on output quality and spec configuration.
 *
 * This is a GENERIC recommendation system, not PR2-specific.
 * The spec can define:
 * - verificationSpec: A separate spec to run for verification
 * - continuationSpec: A separate spec to run for continuation
 * - requireVerify: Whether shadow_complete requires verification
 *
 * SEMANTICS:
 * - NEEDS_WORK + outcome=revise → CONTINUATION (continue current work)
 * - NEEDS_WORK + outcome=halt → CONTINUATION or HANDOFF (recover from failure)
 * - SHADOW_COMPLETE + spec.verificationSpec → VERIFY (run verification spec)
 * - SHADOW_COMPLETE + no verificationSpec → CONTINUATION (improve to production_ready)
 * - PRODUCTION_READY → NONE (no follow-up needed)
 *
 * @param {string} outputQuality - The output quality level
 * @param {string} outcome - The stage outcome (advance/revise/halt)
 * @param {Object} spec - The task spec
 * @param {Object} options - Additional options
 * @param {string[]} options.qualityReasons - Reasons for the quality level
 * @returns {{type: string, spec: string|null, reasons: string[]}}
 */
export function determineNextRunRecommendation(outputQuality, outcome, spec = {}, options = {}) {
  const { qualityReasons = [] } = options;

  // PRODUCTION_READY: No follow-up needed
  if (outputQuality === OUTPUT_QUALITY.PRODUCTION_READY) {
    return {
      type: NEXT_RUN_TYPE.NONE,
      spec: null,
      reasons: ['Output is production-ready. No follow-up run needed.'],
    };
  }

  // NEEDS_WORK: Requires continuation
  if (outputQuality === OUTPUT_QUALITY.NEEDS_WORK) {
    // If halted, might need handoff or fresh start
    if (outcome === 'halt') {
      // Check if spec defines a recovery spec
      if (spec?.recoverySpec) {
        return {
          type: NEXT_RUN_TYPE.HANDOFF,
          spec: spec.recoverySpec,
          reasons: [
            'Stage halted without completion.',
            ...qualityReasons,
            `Consider recovery spec: ${spec.recoverySpec}`,
          ],
        };
      }
      // Otherwise recommend continuation to retry
      return {
        type: NEXT_RUN_TYPE.CONTINUATION,
        spec: spec?.continuationSpec || null,
        reasons: [
          'Stage halted without completion.',
          ...qualityReasons,
          'Recommend retry with fresh context or adjusted parameters.',
        ],
      };
    }

    // revise or other: continue current work
    return {
      type: NEXT_RUN_TYPE.CONTINUATION,
      spec: spec?.continuationSpec || null,
      reasons: [
        'Output needs additional work.',
        ...qualityReasons,
        spec?.continuationSpec
          ? `Recommend continuation spec: ${spec.continuationSpec}`
          : 'Continue with current spec.',
      ],
    };
  }

  // SHADOW_COMPLETE: Check if verification is required
  if (outputQuality === OUTPUT_QUALITY.SHADOW_COMPLETE) {
    // If spec defines a verification spec, recommend verify
    if (spec?.verificationSpec) {
      return {
        type: NEXT_RUN_TYPE.VERIFY,
        spec: spec.verificationSpec,
        reasons: [
          'Output is shadow-complete but not production-ready.',
          ...qualityReasons,
          `Recommend verification spec: ${spec.verificationSpec}`,
        ],
      };
    }

    // If spec explicitly requires verification for shadow_complete
    if (spec?.requireVerify === true) {
      return {
        type: NEXT_RUN_TYPE.VERIFY,
        spec: null, // Use same spec but in verify mode
        reasons: [
          'Output is shadow-complete. Verification required by spec.',
          ...qualityReasons,
        ],
      };
    }

    // No verification defined: recommend continuation to reach production_ready
    return {
      type: NEXT_RUN_TYPE.CONTINUATION,
      spec: spec?.continuationSpec || null,
      reasons: [
        'Output is shadow-complete but not production-ready.',
        ...qualityReasons,
        'Recommend additional work to reach production-ready status.',
      ],
    };
  }

  // Fallback (should not reach here)
  return {
    type: NEXT_RUN_TYPE.NONE,
    spec: null,
    reasons: ['Unknown output quality level.'],
  };
}
