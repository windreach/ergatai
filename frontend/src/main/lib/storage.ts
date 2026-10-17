/**
 * Stub storage utilities for credential-manager.ts
 */

export interface SourceConfigData {
  isAuthenticated?: boolean;
  connectionStatus?: string;
  connectionError?: string;
  [key: string]: unknown;
}

export declare function markSourceAuthenticated(workspaceRootPath: string, slug: string): void;
export declare function loadSourceConfig(workspaceRootPath: string, slug: string): SourceConfigData | null;
export declare function saveSourceConfig(workspaceRootPath: string, config: SourceConfigData): void;
