import {
  execSync
} from "node:child_process";
import {
  existsSync,
  readFileSync
} from "node:fs";
import {
  homedir
} from "node:os";
import {
  join
} from "node:path";

interface ClaudeCredentials {
  claudeAiOauth?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
  };
}

export interface ClaudeOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
}

/**
 * Read Claude OAuth credentials from system credential store
 */
function readFromKeychain(): ClaudeOAuthCredential | null {
  if (process.platform === 'darwin') {
    return readFromMacOSKeychain();
  } else if (process.platform === 'win32') {
    return readFromWindowsCredentialManager();
  } else if (process.platform === 'linux') {
    return readFromLinuxSecretService();
  }
  return null;
}

function readFromMacOSKeychain(): ClaudeOAuthCredential | null {
  try {
    const result = execSync(
      'security find-generic-password -s "Claude Code-credentials" -w',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (result) {
      const credentials: ClaudeCredentials = JSON.parse(result);
      if (credentials.claudeAiOauth) {
        return {
          accessToken: credentials.claudeAiOauth.accessToken,
          refreshToken: credentials.claudeAiOauth.refreshToken,
          expiresAt: credentials.claudeAiOauth.expiresAt,
          scopes: credentials.claudeAiOauth.scopes,
        };
      }
    }
  } catch {
    // Keychain entry not found
  }
  return null;
}

function readFromWindowsCredentialManager(): ClaudeOAuthCredential | null {
  try {
    const credentialsPath = join(homedir(), '.claude', '.credentials.json');
    if (existsSync(credentialsPath)) {
      const content = readFileSync(credentialsPath, 'utf-8');
      const credentials: ClaudeCredentials = JSON.parse(content);
      if (credentials.claudeAiOauth) {
        return {
          accessToken: credentials.claudeAiOauth.accessToken,
          refreshToken: credentials.claudeAiOauth.refreshToken,
          expiresAt: credentials.claudeAiOauth.expiresAt,
          scopes: credentials.claudeAiOauth.scopes,
        };
      }
    }
  } catch {
    // Credential Manager read failed
  }
  return null;
}

function readFromLinuxSecretService(): ClaudeOAuthCredential | null {
  try {
    const result = execSync(
      'secret-tool lookup service "Claude Code" account "credentials" 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (result) {
      const credentials: ClaudeCredentials = JSON.parse(result);
      if (credentials.claudeAiOauth) {
        return {
          accessToken: credentials.claudeAiOauth.accessToken,
          refreshToken: credentials.claudeAiOauth.refreshToken,
          expiresAt: credentials.claudeAiOauth.expiresAt,
          scopes: credentials.claudeAiOauth.scopes,
        };
      }
    }
  } catch {
    // secret-tool not available
  }

  try {
    const result = execSync(
      'pass show claude-code/credentials 2>/dev/null',
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (result) {
      const credentials: ClaudeCredentials = JSON.parse(result);
      if (credentials.claudeAiOauth) {
        return {
          accessToken: credentials.claudeAiOauth.accessToken,
          refreshToken: credentials.claudeAiOauth.refreshToken,
          expiresAt: credentials.claudeAiOauth.expiresAt,
          scopes: credentials.claudeAiOauth.scopes,
        };
      }
    }
  } catch {
    // pass not available
  }

  return null;
}

function readFromCredentialsFile(): ClaudeOAuthCredential | null {
  const credentialsPath = join(homedir(), '.claude', '.credentials.json');
  try {
    if (existsSync(credentialsPath)) {
      const content = readFileSync(credentialsPath, 'utf-8');
      const credentials: ClaudeCredentials = JSON.parse(content);
      if (credentials.claudeAiOauth) {
        return {
          accessToken: credentials.claudeAiOauth.accessToken,
          refreshToken: credentials.claudeAiOauth.refreshToken,
          expiresAt: credentials.claudeAiOauth.expiresAt,
          scopes: credentials.claudeAiOauth.scopes,
        };
      }
    }
  } catch {
    // File not found
  }
  return null;
}

function getExistingClaudeCredentials(): ClaudeOAuthCredential | null {
  const keychainCreds = readFromKeychain();
  if (keychainCreds) {
    return keychainCreds;
  }
  return readFromCredentialsFile();
}

/**
 * Get existing Claude OAuth token from keychain or credentials file
 */
export function getExistingClaudeToken(): string | null {
  const creds = getExistingClaudeCredentials();
  return creds?.accessToken || null;
}
