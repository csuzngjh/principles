import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceService } from '../models/WorkspaceService.js';
import { sendSuccess, sendError, sendNotFound } from '../utils/response.js';

export function createCentralRoutes(workspaceService: WorkspaceService) {
  async function handleCentralRoute(
    req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
  ): Promise<void> {
    if (req.method !== 'GET') {
      sendNotFound(res, 'Method not allowed');
      return;
    }

    if (subPath === '/overview') {
      try {
        const overview = await workspaceService.getCentralOverview();
        sendSuccess(res, overview);
      } catch (err: unknown) {
        sendError(res, 500, 'central_overview_error', (err as Error).message);
      }
      return;
    }

    if (subPath === '/health') {
      try {
        const health = await workspaceService.getCentralHealth();
        sendSuccess(res, health);
      } catch (err: unknown) {
        sendError(res, 500, 'central_health_error', (err as Error).message);
      }
      return;
    }

    sendNotFound(res, `Route /api/central${subPath} not found`);
  }

  return { handleCentralRoute };
}
