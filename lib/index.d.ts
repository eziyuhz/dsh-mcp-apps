import Schema from "@deepseek-ai/schemastery";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import "@modelcontextprotocol/sdk/types.js";
import { Context } from "@deepseek-ai/cordis";

//#region src/config.d.ts
interface ReconnectOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
}
type AppToolCallsSetting = 'deny' | 'approve' | 'allow';
interface StdioServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  toolCallTimeoutMs?: number;
  reconnectOptions?: ReconnectOptions;
  allowAppToolCalls?: AppToolCallsSetting | boolean;
  allowedPermissions?: string[];
  /** Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read. */
  allowedVars?: string[];
  /** Maximum size in bytes of a single incoming stdio message (bytes buffered since the last newline). Default 16MB. */
  maxMessageBytes?: number;
}
interface OAuthOptions {
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
}
interface RemoteServerConfig {
  transport: 'sse' | 'streamable-http';
  url: string;
  headers?: Record<string, string>;
  toolCallTimeoutMs?: number;
  reconnectOptions?: ReconnectOptions;
  allowAppToolCalls?: AppToolCallsSetting | boolean;
  allowedPermissions?: string[];
  /** Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read. */
  allowedVars?: string[];
  /** Maximum size in bytes of a single incoming message (an SSE event or a streamable-http response body). Default 16MB. */
  maxMessageBytes?: number;
  /** Enables OAuth for this remote server. `true` uses dynamic client registration; an object statically configures a client. Remote-transport only — `stdio` servers use the `mcp-remote` workaround instead. */
  oauth?: true | OAuthOptions;
}
type ServerConfig = StdioServerConfig | RemoteServerConfig;
interface Config {
  servers: Record<string, ServerConfig>;
  defaultTimeoutMs?: number;
  /** This DSH host's own externally reachable base URL (e.g. `https://dsh.example.com`), used to build the OAuth `redirect_uri` for `oauth`-enabled servers. Required for OAuth — never derived from an inbound request (that value is caller-controlled and cannot be trusted for a redirect URI baked into dynamic client registration). */
  externalUrl?: string;
}
declare const Config: Schema<Config>;
//#endregion
//#region src/tool-manager.d.ts
interface ToolsService {
  register(definition: unknown): () => void;
}
//#endregion
//#region src/index.d.ts
declare const name = "mcp-apps";
declare const inject: string[];
declare module '@deepseek-ai/cordis' {
  interface Events {
    'ui-tools/changed': () => void;
  }
  interface Context {
    tools: ToolsService;
  }
}
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject, name };