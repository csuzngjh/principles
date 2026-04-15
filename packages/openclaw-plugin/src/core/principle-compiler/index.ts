/**
 * Principle Compiler — Barrel Export
 *
 * Re-exports all principle-compiler components for convenient importing.
 */

export { PrincipleCompiler, type CompileResult } from './compiler.js';
export { validateGeneratedCode, type ValidationResult } from './code-validator.js';
export { generateFromTemplate, type PainPattern } from './template-generator.js';
export { registerCompiledRule, type RegisterInput, type RegisterResult } from './ledger-registrar.js';
