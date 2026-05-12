import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceConfigStore } from '../config/WorkspaceConfigStore.js';
import type { WorkspaceService } from '../models/WorkspaceService.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../utils/response.js';

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function createWorkspacesRoutes(configStore: WorkspaceConfigStore, workspaceService: WorkspaceService) {
  async function handleWorkspacesRoute(
    req: IncomingMessage,
    res: ServerResponse,
    subPath: string,
  ): Promise<void> {
    if (req.method === 'GET' && (subPath === '' || subPath === '/')) {
      const workspaces = configStore.getWorkspaces();
      sendSuccess(res, workspaces);
      return;
    }

    if (req.method === 'POST' && (subPath === '' || subPath === '/')) {
      const body = await readBody(req);
      const parsed = safeParse(body);
      if (!parsed.name || !parsed.path) {
        sendBadRequest(res, 'name and path are required');
        return;
      }
      if (typeof parsed.name !== 'string' || parsed.name.length > 128 || /[\/\\]/.test(parsed.name)) {
        sendBadRequest(res, 'name must be a non-empty string without slashes (max 128 chars)');
        return;
      }
      if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
        sendBadRequest(res, 'path must be a non-empty string');
        return;
      }
      try {
        configStore.addWorkspace(parsed.name, parsed.path);
        const entry = configStore.getWorkspace(parsed.name);
        sendSuccess(res, entry);
      } catch (err: unknown) {
        sendError(res, 409, 'workspace_exists', getErrorMessage(err));
      }
      return;
    }

    const nameMatch = /^\/([^/]+)(.*)$/.exec(subPath);
    if (!nameMatch) {
      sendNotFound(res, `Route /api/workspaces${subPath} not found`);
      return;
    }

    const wsName = decodeURIComponent(nameMatch[1]);
    const rest = nameMatch[2];

    if (req.method === 'GET' && (rest === '' || rest === '/')) {
      const entry = configStore.getWorkspace(wsName);
      if (!entry) {
        sendNotFound(res, `Workspace "${wsName}" not found`);
        return;
      }
      sendSuccess(res, entry);
      return;
    }

    if (req.method === 'PATCH' && (rest === '' || rest === '/')) {
      const body = await readBody(req);
      const updates = safeParse(body);
      try {
        configStore.updateWorkspace(wsName, updates);
        const entry = configStore.getWorkspace(wsName);
        sendSuccess(res, entry);
      } catch (err: unknown) {
        sendError(res, 404, 'workspace_not_found', getErrorMessage(err));
      }
      return;
    }

    if (req.method === 'DELETE' && (rest === '' || rest === '/')) {
      try {
        configStore.removeWorkspace(wsName);
        sendSuccess(res, { removed: wsName });
      } catch (err: unknown) {
        sendError(res, 404, 'workspace_not_found', getErrorMessage(err));
      }
      return;
    }

    if (req.method === 'POST' && rest === '/sync') {
      try {
        const result = await workspaceService.syncWorkspace(wsName);
        sendSuccess(res, result);
      } catch (err: unknown) {
        sendError(res, 404, 'workspace_not_found', getErrorMessage(err));
      }
      return;
    }

    sendNotFound(res, `Route /api/workspaces${subPath} not found`);
  }

  return { handleWorkspacesRoute };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function safeParse(text: string): Record<string, any> {
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    return {};
  }
}
