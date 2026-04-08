import {
  PrincipleLifecycleService,
  type RecomputedPrincipleLifecycle,
} from './principle-lifecycle-service.js';

export function refreshPrincipleLifecycle(
  workspaceDir: string,
  stateDir: string,
): RecomputedPrincipleLifecycle[] {
  return new PrincipleLifecycleService(workspaceDir, stateDir).recomputeAll();
}
