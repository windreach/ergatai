/**
 * Stub Slack OAuth module for credential-manager.ts
 */

import type { SlackService } from '../lib/types';

export interface SlackOAuthResult {
  success: boolean;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  teamName?: string;
}

export interface SlackOAuthOptions {
  service?: SlackService;
  userScopes?: string[];
  appType?: string;
}

export async function startSlackOAuth(options: SlackOAuthOptions): Promise<SlackOAuthResult> {
  throw new Error('Slack OAuth not implemented in stub module');
}
export async function refreshSlackToken(refreshToken: string, clientId?: string, clientSecret?: string): Promise<{ accessToken: string; expiresAt?: number }> {
  throw new Error('Slack OAuth not implemented in stub module');
}
