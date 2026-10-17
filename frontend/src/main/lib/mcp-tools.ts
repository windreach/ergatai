/**
 * Generic MCP tool fetching using the official MCP SDK
 *
 * These functions are not tied to Claude or any specific agent.
 * They use the standard MCP protocol to discover tools from MCP servers.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { getClaudeShellEnvironment } from './claude/env';

/**
 * Sensitive env vars to filter out when spawning MCP subprocesses
 */
const BLOCKED_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
];

export interface McpToolInfo {
  name: string;
  description?: string;
}

/**
 * Fetch tools from an HTTP/SSE-based MCP server
 * @param serverUrl The MCP server URL
 * @param headers Optional headers (e.g., for authentication)
 */
export async function fetchMcpTools(
  serverUrl: string,
  headers?: Record<string, string>
): Promise<McpToolInfo[]> {
  let transport: StreamableHTTPClientTransport | null = null;

  try {
    const client = new Client({
      name: 'ergatai-ui',
      version: '1.0.0',
    });

    const requestInit: RequestInit = {};
    if (headers && Object.keys(headers).length > 0) {
      requestInit.headers = { ...headers };
    }

    transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
      requestInit,
    });

    await client.connect(transport);
    const result = await client.listTools();
    const tools = result.tools || [];

    console.log(`[MCP] Fetched ${tools.length} tools via SDK`);
    return tools.map(t => ({ name: t.name, description: t.description }));
  } catch (error) {
    console.error('[MCP] Failed to fetch tools:', error);
    return [];
  } finally {
    try {
      if (transport) {
        await transport.close();
      }
    } catch {
      // Ignore close errors
    }
  }
}

/**
 * Fetch tools from a stdio-based MCP server
 * Uses shell environment to ensure proper PATH (homebrew, nvm, etc.) in production
 */
export async function fetchMcpToolsStdio(config: {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}): Promise<McpToolInfo[]> {
  let transport: StdioClientTransport | null = null;

  try {
    const client = new Client({
      name: 'ergatai-ui',
      version: '1.0.0',
    });

    // Get shell environment with proper PATH (includes homebrew, nvm, etc.)
    const shellEnv = getClaudeShellEnvironment();

    // Filter sensitive env vars
    const safeEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(shellEnv)) {
      if (!BLOCKED_ENV_VARS.includes(key)) {
        safeEnv[key] = value;
      }
    }

    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: { ...safeEnv, ...config.env },
    });

    await client.connect(transport);
    const result = await client.listTools();
    const tools = result.tools || [];

    console.log(`[MCP] Fetched ${tools.length} tools via stdio`);
    return tools.map(t => ({ name: t.name, description: t.description }));
  } catch (error) {
    console.error('[MCP] Failed to fetch tools via stdio:', error);
    return [];
  } finally {
    try {
      if (transport) {
        await transport.close();
      }
    } catch {
      // Ignore close errors
    }
  }
}
