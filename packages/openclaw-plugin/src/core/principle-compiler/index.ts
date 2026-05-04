/**
 * Principle Compiler — Barrel Export
 *
 * Re-exports all principle-compiler components for convenient importing.
 * PRI-44: Types and pure logic re-exported from @principles/core.
 */

export { PrincipleCompiler } from './compiler.js';
export type { CompileResult } from './compiler.js';
export { validateGeneratedCode } from './code-validator.js';
export type { ValidationResult } from './code-validator.js';
export { generateFromTemplate, type PainPattern } from './template-generator.js';
export { registerCompiledRule, type RegisterInput, type RegisterResult } from './ledger-registrar.js';
