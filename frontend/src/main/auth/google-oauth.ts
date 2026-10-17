/**
 * Stub Google OAuth module for credential-manager.ts
 */

import type { GoogleService } from '../lib/types';

export interface GoogleOAuthResult {
  success: boolean;
  error?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  email?: string;
}

export interface GoogleOAuthOptions {
  service?: GoogleService;
  scopes?: string[];
  appType?: string;
}

export async function startGoogleOAuth(options: GoogleOAuthOptions): Promise<GoogleOAuthResult> {
  throw new Error('Google OAuth not implemented in stub module');
}
export async function refreshGoogleToken(refreshToken: string): Promise<{ accessToken: string; expiresAt?: number }> {
  throw new Error('Google OAuth not implemented in stub module');
}
