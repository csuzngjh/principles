/**
 * Console port contract (PRI-872 / SPEC `install-mjs-dev-prod-isolation-review`
 * §6.3). Production keeps the historical 3100; an experiment instance defaults
 * to 13100 so a bare dev start can never take the production port.
 *
 * The paired gateway ports are 18789 (production, read from
 * `<openclawHome>/openclaw.json`) and 19789 (experiment, foreground
 * `openclaw gateway run` owned by the experiment launcher).
 */
export const PRODUCTION_CONSOLE_PORT = 3100;
export const EXPERIMENT_CONSOLE_PORT = 13100;
export const EXPERIMENT_GATEWAY_PORT = 19789;

export function defaultConsolePort(mode: 'production' | 'experiment'): number {
  return mode === 'experiment' ? EXPERIMENT_CONSOLE_PORT : PRODUCTION_CONSOLE_PORT;
}
