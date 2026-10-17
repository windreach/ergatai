/**
 * Stub types for source configuration.
 * Minimal declarations to satisfy credential-manager.ts type checking.
 */

export type GoogleService = string;
export type SlackService = string;
export type MicrosoftService = string;

export interface SourceApiConfig {
  authType?: string;
  baseUrl?: string;
  provider?: string;
  googleService?: GoogleService;
  googleScopes?: string[];
  slackService?: SlackService;
  slackUserScopes?: string[];
  microsoftService?: MicrosoftService;
  microsoftScopes?: string[];
}

export interface SourceMcpConfig {
  transport?: string;
  authType?: string;
  url?: string;
}

export interface SourceConfig {
  slug: string;
  type: string;
  enabled: boolean;
  isAuthenticated: boolean;
  provider?: string;
  mcp?: SourceMcpConfig;
  api?: SourceApiConfig;
  connectionStatus?: string;
  connectionError?: string;
}

export interface LoadedSource {
  workspaceId: string;
  workspaceRootPath: string;
  config: SourceConfig;
}

export declare function inferGoogleServiceFromUrl(baseUrl?: string): GoogleService | undefined;
export declare function inferSlackServiceFromUrl(baseUrl?: string): SlackService | undefined;
export declare function inferMicrosoftServiceFromUrl(baseUrl?: string): MicrosoftService | undefined;
export declare function isApiOAuthProvider(provider?: string): boolean;
