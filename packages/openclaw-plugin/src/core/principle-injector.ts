/**
 * PrincipleInjector and DefaultPrincipleInjector -- re-exported from @principles/core.
 * @principles/core is the canonical source.
 *
 * DefaultPrincipleInjector is now in @principles/core since it uses only SDK types.
 * openclaw-plugin should use the exported DefaultPrincipleInjector from @principles/core.
 */
export { PrincipleInjector, DefaultPrincipleInjector, InjectionContext } from '@principles/core';
export type { InjectablePrinciple } from '@principles/core';
