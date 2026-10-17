/**
 * Stub Microsoft OAuth module for credential-manager.ts
 */

import type { MicrosoftService } from '../lib/types';

export interface MicrosoftOAuthResult {
  success: boolean;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
}

export interface MicrosoftOAuthOptions {
  service?: MicrosoftService;
  scopes?: string[];
  appType?: string;
}

export async function startMicrosoftOAuth(options: MicrosoftOAuthOptions): Promise<MicrosoftOAuthResult> {
  throw new Error('Microsoft OAuth not implemented in stub module');
}

export async function refreshMicrosoftToken(refreshToken: string): Promise<{ accessToken: string; refreshToken?: string; expiresAt?: number }> {
  throw new Error('Microsoft OAuth not implemented in stub module');
}
