import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { WorkspaceEntry, WorkspaceConfig } from '../types/index.js';

const CONFIG_DIR_NAME = '.pd-console';
const WORKSPACES_FILE = 'workspaces.json';

export class WorkspaceConfigStore {
  private readonly configDir: string;
  private readonly configPath: string;
  private readonly entries: WorkspaceEntry[];

  constructor(configDir?: string) {
    this.configDir = configDir ?? path.join(os.homedir(), CONFIG_DIR_NAME);
    this.configPath = path.join(this.configDir, WORKSPACES_FILE);
    this.entries = this.load();
  }

  getWorkspaces(): WorkspaceEntry[] {
    return this.entries;
  }

  getWorkspace(name: string): WorkspaceEntry | null {
    return this.entries.find(e => e.name === name) ?? null;
  }

  addWorkspace(name: string, workspacePath: string): void {
    if (!name || name.length > 128) {
      throw new Error('Workspace name must be between 1 and 128 characters');
    }
    if (name.includes('/') || name.includes('\\')) {
      throw new Error('Workspace name cannot contain slashes');
    }
    if (this.entries.some(e => e.name === name)) {
      throw new Error(`Workspace "${name}" already exists`);
    }
    this.entries.push({
      name,
      path: path.resolve(workspacePath),
      lastSync: null,
      config: {
        workspaceName: name,
        enabled: true,
        displayName: null,
        syncEnabled: true,
      },
    });
    this.save();
  }

  updateWorkspace(name: string, updates: Partial<WorkspaceConfig>): void {
    const entry = this.entries.find(e => e.name === name);
    if (!entry) {
      throw new Error(`Workspace "${name}" not found`);
    }
    if (entry.config) {
      entry.config = { ...entry.config, ...updates };
    } else {
      entry.config = {
        workspaceName: name,
        enabled: true,
        displayName: null,
        syncEnabled: true,
        ...updates,
      };
    }
    this.save();
  }

  removeWorkspace(name: string): void {
    const index = this.entries.findIndex(e => e.name === name);
    if (index === -1) {
      throw new Error(`Workspace "${name}" not found`);
    }
    this.entries.splice(index, 1);
    this.save();
  }

  updateSyncTime(name: string): void {
    const entry = this.entries.find(e => e.name === name);
    if (entry) {
      entry.lastSync = new Date().toISOString();
      this.save();
    }
  }

  private load(): WorkspaceEntry[] {
    if (!fs.existsSync(this.configPath)) {
      return [];
    }
    try {
      const raw = fs.readFileSync(this.configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed as WorkspaceEntry[];
    } catch (e) {
      console.warn('WorkspaceConfigStore: failed to parse workspaces.json, returning empty list:', e);
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(this.configDir, { recursive: true });
    const tmpPath = this.configPath + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(this.entries, null, 2), 'utf8');
    fs.renameSync(tmpPath, this.configPath);
  }
}
