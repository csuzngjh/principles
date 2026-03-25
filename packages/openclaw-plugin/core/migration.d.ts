import type { OpenClawPluginApi } from '../openclaw-sdk.js';
/**
 * Handles migration of Principles Disciple files from legacy directories
 * (docs/ and memory/.state/) to the new hidden directory structure (.principles/ and .state/).
 */
export declare function migrateDirectoryStructure(api: OpenClawPluginApi, workspaceDir: string): void;
