/**
 * Test-only harness for the Pi 1.2 compat stubs shared by the
 * `pi12-spike-*.test.ts` files (SPEC-PD-PI12-COMPAT-001 Phase 0).
 *
 * PD's adapters resolve models through the compat catalog (`getModel` /
 * `getProviders`). The spikes register the REAL Pi 1.2 faux provider, so only
 * those two lookups are redirected; every other compat export stays the real
 * one (`...actual`). Vitest hoists `vi.mock` factories above the test file's
 * imports, which is why the model handle lives in this module rather than in a
 * `vi.hoisted` binding of each test file.
 *
 * Test-only: not exported from the package entry, not imported by production.
 */
import { vi } from 'vitest';

export interface FauxCompatState {
  /** Handle returned by the real `registerFauxProvider(...).getModel(id)`. */
  fauxModel: unknown;
}

export const fauxCompatState: FauxCompatState = { fauxModel: undefined };

/** Point the stubbed catalog at the currently registered faux model. */
export function setFauxCompatModel(model: unknown): void {
  fauxCompatState.fauxModel = model;
}

/**
 * `vi.mock('@earendil-works/pi-ai/compat', ...)` factory: keep the real compat
 * module and redirect only the catalog lookups to the faux provider.
 */
export async function fauxCompatMockFactory(
  importActual: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const actual = await importActual();
  const actualGetModel = actual.getModel as (provider: unknown, id: unknown) => unknown;
  const actualGetProviders = actual.getProviders as () => unknown[];
  return {
    ...actual,
    getModel: vi.fn((provider: unknown, id: unknown) =>
      provider === 'faux' ? fauxCompatState.fauxModel : actualGetModel(provider, id)),
    getProviders: vi.fn(() => ['faux', ...actualGetProviders()]),
  };
}
