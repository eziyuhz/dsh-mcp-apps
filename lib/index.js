import { clientRequestSchema } from "@deepseek-ai/dsh-client-connection";
import Schema from "@deepseek-ai/schemastery";
import { DSH_ENV_PREFIX, SENSITIVE_ENV_PATTERN, scrubbedParentEnv } from "@deepseek-ai/dsh-subprocess";
import crypto$1, { randomUUID } from "node:crypto";
import { RESOURCE_MIME_TYPE, getToolUiResourceUri, isToolVisibilityAppOnly, isToolVisibilityModelOnly } from "@modelcontextprotocol/ext-apps/app-bridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { UnauthorizedError, discoverOAuthServerInfo, exchangeAuthorization, registerClient, startAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

//#region src/constants.ts
/**
* Default maximum size, in bytes, of a single incoming protocol message
* (a stdio line, an SSE event, or a streamable-http response body) before
* the transport is treated as misbehaving and closed. Shared by every
* transport so the default never drifts between stdio and remote configs.
*/
const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

//#endregion
//#region src/frame.ts
const DEFAULT_FRAME_HEIGHT = 360;
const DEFAULT_FRAME_MIN_HEIGHT = 160;
const DEFAULT_FRAME_MAX_HEIGHT = 1200;
function finitePositive(value, fallback) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return fallback;
	return Math.round(value);
}
function clampFrameHeight(height, minHeight, maxHeight) {
	if (!Number.isFinite(height)) return minHeight;
	return Math.max(minHeight, Math.min(Math.round(height), maxHeight));
}
function resolveFrameConfig(input) {
	const minHeight = finitePositive(input?.minHeight, DEFAULT_FRAME_MIN_HEIGHT);
	const maxHeight = Math.max(minHeight, finitePositive(input?.maxHeight, DEFAULT_FRAME_MAX_HEIGHT));
	return {
		defaultHeight: clampFrameHeight(finitePositive(input?.defaultHeight, DEFAULT_FRAME_HEIGHT), minHeight, maxHeight),
		minHeight,
		maxHeight
	};
}
function parsePreferredHeight(value, minHeight, maxHeight) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return clampFrameHeight(value, minHeight, maxHeight);
}

//#endregion
//#region src/config.ts
const REMOTE_URL_PATTERN = /^https?:\/\/\S+$/;
const AppToolCallsSchema = Schema.union([
	Schema.const("deny"),
	Schema.const("approve"),
	Schema.const("allow"),
	Schema.boolean()
]).default(false).description("Whether MCP Apps served by this server may invoke tools back on the host: \"deny\"/false blocks it, \"approve\" requires per-call approval, \"allow\"/true permits it outright.");
const ReconnectSchema = Schema.object({
	maxRetries: Schema.number().default(5).description("Maximum number of reconnect attempts after the connection closes before giving up."),
	initialDelayMs: Schema.number().default(1e3).role("ms").description("Delay before the first reconnect attempt, in milliseconds."),
	maxDelayMs: Schema.number().default(3e4).role("ms").description("Upper bound on the reconnect delay after exponential backoff, in milliseconds."),
	backoffFactor: Schema.number().default(1.5).description("Multiplier applied to the delay after each failed reconnect attempt.")
}).description("Reconnection behavior applied after this server's connection closes unexpectedly.");
const StdioSchema = Schema.object({
	transport: Schema.const("stdio").default("stdio").description("Transport kind: a locally spawned process speaking MCP over stdio."),
	command: Schema.string().required().description("Executable to spawn for this MCP server."),
	args: Schema.array(String).default([]).description("Command-line arguments passed to the spawned process."),
	env: Schema.dict(Schema.string().role("secret")).default({}).description("Extra environment variables for the spawned process. Supports `${VAR}` expansion; values are treated as secrets and never returned to clients."),
	cwd: Schema.string().description("Working directory for the spawned process. Defaults to the host process's own working directory."),
	toolCallTimeoutMs: Schema.number().min(1).default(3e4).role("ms").description("Maximum time to wait for a tool call to this server to complete, in milliseconds."),
	reconnectOptions: ReconnectSchema.default({}),
	allowAppToolCalls: AppToolCallsSchema,
	allowedPermissions: Schema.array(String).default([]).description("Iframe permissions (e.g. \"camera\", \"microphone\", \"geolocation\") this server's MCP Apps may request."),
	allowedVars: Schema.array(String).default([]).description("Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read."),
	maxMessageBytes: Schema.number().min(1).default(DEFAULT_MAX_MESSAGE_BYTES).description("Maximum size in bytes of a single incoming stdio message (bytes buffered since the last newline). Default 16MB.")
}).description("Local process (stdio)");
const OAuthOptionsSchema = Schema.object({
	clientId: Schema.string().description("Statically registered OAuth client ID. Omit to use dynamic client registration (RFC 7591)."),
	clientSecret: Schema.string().role("secret").description("Statically registered OAuth client secret, if the authorization server issued one. Never returned to clients."),
	scopes: Schema.array(String).description("OAuth scopes to request during authorization.")
}).description("Static OAuth client configuration.");
const OAuthSchema = Schema.union([Schema.const(true), OAuthOptionsSchema]).description("Enables OAuth for this remote server. `true` uses dynamic client registration; an object statically configures a client ID/secret/scopes.");
const RemoteSchema = Schema.object({
	transport: Schema.union([Schema.const("sse"), Schema.const("streamable-http")]).required().description("Transport kind: a remote MCP server reached over HTTP, either as SSE or streamable HTTP."),
	url: Schema.string().required().pattern(REMOTE_URL_PATTERN).description("HTTP(S) endpoint of the remote MCP server."),
	headers: Schema.dict(Schema.string().role("secret")).default({}).description("Extra HTTP headers sent with every request to this server. Supports `${VAR}` expansion; values are treated as secrets and never returned to clients."),
	toolCallTimeoutMs: Schema.number().min(1).default(3e4).role("ms").description("Maximum time to wait for a tool call to this server to complete, in milliseconds."),
	reconnectOptions: ReconnectSchema.default({}),
	allowAppToolCalls: AppToolCallsSchema,
	allowedPermissions: Schema.array(String).default([]).description("Iframe permissions (e.g. \"camera\", \"microphone\", \"geolocation\") this server's MCP Apps may request."),
	allowedVars: Schema.array(String).default([]).description("Names normally blocked from `${VAR}` expansion (DSH_*, secret-shaped, agent sockets) that this server may read."),
	maxMessageBytes: Schema.number().min(1).default(DEFAULT_MAX_MESSAGE_BYTES).description("Maximum size in bytes of a single incoming message (an SSE event or a streamable-http response body). Default 16MB."),
	oauth: OAuthSchema
}).description("Remote server (SSE / streamable HTTP)");
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 3e4;
/**
* Resolves the effective tool-call timeout for a server: the server's own
* override, falling back to the plugin-wide default, falling back to the
* hard-coded default. Shared by every call site (forward tool execution,
* app-initiated reverse tool calls, and resource reads) so the resolution
* order never drifts between them.
*/
function resolveToolCallTimeoutMs(serverConfig, defaultTimeoutMs) {
	return serverConfig?.toolCallTimeoutMs ?? defaultTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS;
}
const SERVER_NAME_REGEX = /^(?!.*__)(?!.*_$)[a-zA-Z0-9_-]+$/;
const ServerNameSchema = Schema.string().pattern(SERVER_NAME_REGEX).description("Server name cannot contain consecutive underscores or end with an underscore");
const FrameSchema = Schema.object({
	defaultHeight: Schema.number().min(1).default(DEFAULT_FRAME_HEIGHT).description("Initial iframe height in pixels before a resource preferredHeight or size-changed update."),
	minHeight: Schema.number().min(1).default(DEFAULT_FRAME_MIN_HEIGHT).description("Minimum iframe height in pixels."),
	maxHeight: Schema.number().min(1).default(DEFAULT_FRAME_MAX_HEIGHT).description("Maximum iframe height in pixels; size-changed values are clamped to this.")
}).description("Inline MCP App iframe height clamp. Apps may still pass preferredHeight on the UI resource and resize via size-changed.");
const Config = Schema.object({
	servers: Schema.dict(Schema.union([StdioSchema, RemoteSchema]).required(), ServerNameSchema).default({}).description("MCP servers to host, keyed by a name unique within this plugin."),
	defaultTimeoutMs: Schema.number().min(1).default(3e4).role("ms").description("Fallback tool-call timeout, in milliseconds, used by any server that does not set its own `toolCallTimeoutMs`."),
	externalUrl: Schema.string().pattern(REMOTE_URL_PATTERN).description("This DSH host's own externally reachable base URL, used to build the OAuth `redirect_uri` for any `oauth`-enabled server. Required for OAuth; never derived from an inbound request."),
	frame: FrameSchema.default({
		defaultHeight: DEFAULT_FRAME_HEIGHT,
		minHeight: DEFAULT_FRAME_MIN_HEIGHT,
		maxHeight: DEFAULT_FRAME_MAX_HEIGHT
	})
});
const DOLLAR_ESCAPE_SENTINEL = "\0DSH_MCP_APPS_DOLLAR\0";
/**
* Agent-socket style variables that `scrubbedParentEnv()` does not strip
* (they don't match DSH_* or the KEY/PASSWORD/SECRET/TOKEN pattern) but that
* still grant access to a live credential agent if leaked to a spawned MCP
* server or forwarded remote header. Blocked from `${VAR}` expansion here,
* and stripped from the inherited environment before spawning (see
* `createStdioTransport`), unless explicitly allow-listed.
*/
const EXTRA_BLOCKED_ENV_VARS = new Set(["SSH_AUTH_SOCK", "GPG_AGENT_INFO"]);
/**
* Expands environment variable expressions like `${FOO}` or `${FOO:-default}`
* using the provided environment (defaulting to process.env).
* Blocks reading DSH_* and sensitive secret patterns unless explicitly included in allowedVars.
*
* `$$` is treated as an escaped literal `$` and is never treated as the start
* of a variable expansion.
*
* Only applies to `StdioServerConfig.env` and `RemoteServerConfig.headers`
* values (via `expandEnvVars`) — it is NOT applied to `url`, `args`, or `cwd`.
*
* Known limitation: the default-value branch (`:-default`) matches up to the
* first unescaped `}`, so a default that itself contains a nested `${...}`
* expansion (e.g. `${MISSING:-${PORT}}`) is not parsed as nested — the inner
* `${PORT}` is taken as a literal, unexpanded string. This is intentional
* (not a bug to be fixed here); write a flat default instead.
*/
function expandEnvString(value, env = process.env, allowedVars) {
	return value.replace(/\$\$/g, DOLLAR_ESCAPE_SENTINEL).replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-([^}]*))?\}/g, (_, varName, defaultValue) => {
		if ((varName.startsWith(DSH_ENV_PREFIX) || SENSITIVE_ENV_PATTERN.test(varName) || EXTRA_BLOCKED_ENV_VARS.has(varName)) && !allowedVars?.has(varName)) return defaultValue ?? "";
		const val = env[varName];
		if (val !== void 0 && val !== "") return val;
		return defaultValue ?? "";
	}).replaceAll(DOLLAR_ESCAPE_SENTINEL, "$");
}
/**
* Recursively expands environment variables in dictionary values.
*/
function expandEnvVars(dict, env = process.env, allowedVars) {
	if (!dict) return {};
	const result = {};
	for (const [key, val] of Object.entries(dict)) result[key] = expandEnvString(val, env, allowedVars);
	return result;
}

//#endregion
//#region src/session-store.ts
var AppSessionStore = class {
	sessions = /* @__PURE__ */ new Map();
	ttlMs;
	maxSessions;
	pruneTimer;
	constructor(ttlMs = 3600 * 1e3, maxSessions = 1e3, pruneIntervalMs = 60 * 1e3) {
		this.ttlMs = ttlMs;
		this.maxSessions = maxSessions;
		if (pruneIntervalMs > 0) {
			this.pruneTimer = setInterval(() => this.prune(), pruneIntervalMs);
			this.pruneTimer.unref?.();
		}
	}
	createSession(serverName, rawToolName, resourceUri, allowedReverseTools = [], options) {
		this.prune();
		while (this.sessions.size >= this.maxSessions) {
			const oldestKey = this.sessions.keys().next().value;
			if (oldestKey === void 0) break;
			this.sessions.delete(oldestKey);
		}
		const sessionToken = crypto$1.randomBytes(32).toString("hex");
		const now = Date.now();
		const session = {
			sessionToken,
			serverName,
			rawToolName,
			resourceUri,
			allowedReverseTools: new Set(allowedReverseTools),
			agentId: options?.agentId,
			callId: options?.callId,
			createdAt: now,
			expiresAt: now + this.ttlMs
		};
		this.sessions.set(sessionToken, session);
		return session;
	}
	get(token) {
		if (!token) return void 0;
		const session = this.sessions.get(token);
		if (!session) return void 0;
		if (Date.now() > session.expiresAt) {
			this.sessions.delete(token);
			return;
		}
		this.sessions.delete(token);
		this.sessions.set(token, session);
		return session;
	}
	delete(token) {
		return this.sessions.delete(token);
	}
	prune() {
		const now = Date.now();
		for (const [token, session] of this.sessions.entries()) if (now > session.expiresAt) this.sessions.delete(token);
	}
	clear() {
		this.sessions.clear();
	}
	dispose() {
		if (this.pruneTimer) {
			clearInterval(this.pruneTimer);
			this.pruneTimer = void 0;
		}
		this.sessions.clear();
	}
	get size() {
		return this.sessions.size;
	}
};

//#endregion
//#region src/setup-hint.ts
const SETUP_TOOL_NAME = "mcp_apps_setup";
const SETUP_HINT = `还没有配置 MCP 服务器，所以没有任何 MCP App 工具。

在 DSH profile 的 cordis.patch.yml 里追加下面这一段。不要使用 insert:，那会再创建一行 mcp-apps。

- id: mcp-apps
  config:
    servers:
      my-server:
        transport: streamable-http
        url: https://example.com/mcp

把 url 换成你自己的 MCP 地址。保存后重新打开 DeepSeek Harness。`;

//#endregion
//#region src/tool-manager.ts
const MAX_PUBLIC_NAME_LENGTH = 64;
const INVALID_NAME_CHARS = /[^A-Za-z0-9_-]/g;
const HASH_LENGTH = 12;
function publicToolName(serverName, rawName) {
	const joined = `mcp__${serverName}__${rawName}`;
	const normalized = joined.replace(INVALID_NAME_CHARS, "_");
	if (normalized === joined && normalized.length <= MAX_PUBLIC_NAME_LENGTH) return normalized;
	const hash = crypto$1.createHash("sha256").update(`${serverName}\0${rawName}`).digest("hex").slice(0, HASH_LENGTH);
	return `${normalized.slice(0, MAX_PUBLIC_NAME_LENGTH - HASH_LENGTH - 1)}_${hash}`;
}
function computeToolFingerprint(tool, resourceUri) {
	const content = JSON.stringify({
		description: tool.description ?? "",
		parameters: tool.inputSchema ?? {},
		resourceUri: resourceUri ?? ""
	});
	return crypto$1.createHash("sha256").update(content).digest("hex");
}
var ServerToolManager = class {
	toolsService;
	sessionStore;
	disposers = /* @__PURE__ */ new Map();
	fingerprints = /* @__PURE__ */ new Map();
	uiTools = /* @__PURE__ */ new Map();
	/** Count of every tool seen for a server in its last sync (model + app-only), for `getToolCounts`. Cleared on eviction. */
	toolCounts = /* @__PURE__ */ new Map();
	/** Name/visibility/hasUi summary of every tool seen for a server in its last sync, for `getToolSummaries`. Cleared on eviction, alongside `toolCounts`. */
	toolSummaries = /* @__PURE__ */ new Map();
	onUiToolsChanged;
	defaultTimeoutMs;
	constructor(toolsService, sessionStore, onUiToolsChanged, defaultTimeoutMs) {
		this.toolsService = toolsService;
		this.sessionStore = sessionStore;
		this.onUiToolsChanged = onUiToolsChanged;
		this.defaultTimeoutMs = defaultTimeoutMs;
	}
	syncServerTools(serverName, client, tools, serverConfig) {
		const existingServerDisposers = new Map(this.disposers.get(serverName) ?? []);
		const existingServerFingerprints = this.fingerprints.get(serverName) ?? /* @__PURE__ */ new Map();
		const nextServerDisposers = /* @__PURE__ */ new Map();
		const nextServerFingerprints = /* @__PURE__ */ new Map();
		const nextServerUiTools = /* @__PURE__ */ new Map();
		const otherRegisteredPublicNames = /* @__PURE__ */ new Set();
		for (const [srv, serverDisposers] of this.disposers.entries()) if (srv !== serverName) for (const name$1 of serverDisposers.keys()) otherRegisteredPublicNames.add(name$1);
		const assignedPublicNames = /* @__PURE__ */ new Set();
		let nextServerToolCount = 0;
		const nextServerToolSummaries = [];
		const allowedReverseTools = serverConfig?.allowAppToolCalls === true || serverConfig?.allowAppToolCalls === "allow" || serverConfig?.allowAppToolCalls === "approve" ? new Set(tools.filter((t) => !isToolVisibilityModelOnly(t)).map((t) => t.name)) : /* @__PURE__ */ new Set();
		try {
			for (const tool of tools) try {
				let resourceUri;
				try {
					resourceUri = getToolUiResourceUri(tool) ?? tool._meta?.ui?.resourceUri;
				} catch (err) {
					console.error(`mcp-apps: invalid UI metadata for tool "${tool.name}", skipping:`, err);
					continue;
				}
				if (resourceUri && !resourceUri.startsWith("ui://")) {
					console.error(`mcp-apps: invalid UI resource URI scheme "${resourceUri}" for tool "${tool.name}", skipping`);
					continue;
				}
				let publicName = publicToolName(serverName, tool.name);
				if (assignedPublicNames.has(publicName) || otherRegisteredPublicNames.has(publicName)) {
					const disambigHash = crypto$1.createHash("sha256").update(`${serverName}\0${tool.name}\0${assignedPublicNames.size}`).digest("hex").slice(0, 8);
					publicName = `${publicName.slice(0, 55)}_${disambigHash}`;
				}
				assignedPublicNames.add(publicName);
				nextServerToolCount++;
				if (resourceUri) nextServerUiTools.set(publicName, {
					serverName,
					rawName: tool.name,
					publicName,
					resourceUri
				});
				const isAppOnly = isToolVisibilityAppOnly(tool);
				const visibility = isAppOnly ? "app" : isToolVisibilityModelOnly(tool) ? "model" : "both";
				nextServerToolSummaries.push({
					rawName: tool.name,
					publicName,
					visibility,
					hasUi: Boolean(resourceUri)
				});
				if (isAppOnly) continue;
				const fingerprint = computeToolFingerprint(tool, resourceUri);
				const existingFingerprint = existingServerFingerprints.get(publicName);
				const existingDisposer = existingServerDisposers.get(publicName);
				if (existingDisposer && existingFingerprint === fingerprint) {
					nextServerDisposers.set(publicName, existingDisposer);
					nextServerFingerprints.set(publicName, fingerprint);
					existingServerDisposers.delete(publicName);
					continue;
				}
				if (existingDisposer) {
					try {
						existingDisposer();
					} catch {}
					existingServerDisposers.delete(publicName);
				}
				const definition = {
					name: publicName,
					description: tool.description ?? "",
					parameters: tool.inputSchema,
					output: {
						schema: {
							type: "object",
							properties: {
								content: {
									type: "array",
									items: {}
								},
								structuredContent: {},
								_sessionToken: { type: "string" }
							},
							required: ["content"],
							additionalProperties: false
						},
						render: (_args, value) => [{
							type: "text",
							text: extractText(value.content, tool.name)
						}],
						presentationMeta: (_args, value) => {
							if (!resourceUri) return {};
							let sessionToken;
							let cleanResult = value;
							if (typeof value === "object" && value !== null) {
								const { _sessionToken,...rest } = value;
								sessionToken = typeof _sessionToken === "string" ? _sessionToken : void 0;
								cleanResult = rest;
							}
							return { mcpApp: {
								serverName,
								rawToolName: tool.name,
								resourceUri,
								sessionToken,
								result: cleanResult
							} };
						}
					},
					execute: async (args, exec) => {
						const argumentsValue = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
						const timeout = resolveToolCallTimeoutMs(serverConfig, this.defaultTimeoutMs);
						const result = await client.callTool({
							name: tool.name,
							arguments: argumentsValue
						}, void 0, {
							signal: exec?.signal,
							timeout
						});
						if (result.isError) throw new Error(extractText(result.content, tool.name) || `Tool "${tool.name}" failed`);
						let sessionToken;
						if (resourceUri) sessionToken = this.sessionStore.createSession(serverName, tool.name, resourceUri, allowedReverseTools, {
							agentId: exec?.agent?.id,
							callId: exec?.rootCallId ?? exec?.callId
						}).sessionToken;
						return {
							content: result.content,
							...result.structuredContent !== void 0 ? { structuredContent: result.structuredContent } : {},
							...sessionToken ? { _sessionToken: sessionToken } : {}
						};
					}
				};
				const disposer = this.toolsService.register(definition);
				nextServerDisposers.set(publicName, disposer);
				nextServerFingerprints.set(publicName, fingerprint);
			} catch (toolErr) {
				console.error(`mcp-apps: failed to register tool "${tool.name}":`, toolErr);
			}
		} finally {
			for (const [removedPublicName, dispose] of existingServerDisposers.entries()) {
				try {
					dispose();
				} catch {}
				this.uiTools.delete(removedPublicName);
			}
			for (const [pubName, descriptor] of this.uiTools.entries()) if (descriptor.serverName === serverName && !nextServerUiTools.has(pubName)) this.uiTools.delete(pubName);
			for (const [pubName, descriptor] of nextServerUiTools.entries()) this.uiTools.set(pubName, descriptor);
			this.disposers.set(serverName, nextServerDisposers);
			this.fingerprints.set(serverName, nextServerFingerprints);
			this.toolCounts.set(serverName, nextServerToolCount);
			this.toolSummaries.set(serverName, nextServerToolSummaries);
			this.onUiToolsChanged?.();
		}
	}
	evictServer(serverName) {
		const serverDisposers = this.disposers.get(serverName);
		if (serverDisposers) {
			for (const [, dispose] of serverDisposers.entries()) try {
				dispose();
			} catch {}
			this.disposers.delete(serverName);
			this.fingerprints.delete(serverName);
		}
		this.toolCounts.delete(serverName);
		this.toolSummaries.delete(serverName);
		for (const [pubName, descriptor] of this.uiTools.entries()) if (descriptor.serverName === serverName) this.uiTools.delete(pubName);
		this.onUiToolsChanged?.();
	}
	disposeAll() {
		for (const [serverName] of this.disposers.entries()) this.evictServer(serverName);
		this.uiTools.clear();
		this.fingerprints.clear();
		this.toolCounts.clear();
		this.toolSummaries.clear();
	}
	getUiToolsSnapshot() {
		return Array.from(this.uiTools.values());
	}
	/**
	* Tool counts for one server: `toolCount` is every tool this plugin
	* exposes in some form as of the last sync (model-visible tools
	* registered with the host, plus app-only tools that are never
	* registered with the host but are still reachable via a `ui://`
	* resource), `uiToolCount` is the subset backed by a `ui://` resource.
	* `uiToolCount` is always <= `toolCount`. Note `toolCount` can exceed
	* `this.disposers.get(serverName)?.size`, since app-only tools have no
	* disposer. Used by the read-only status endpoint; never exposes tool
	* names, arguments, or server config.
	*/
	getToolCounts(serverName) {
		const toolCount = this.toolCounts.get(serverName) ?? 0;
		let uiToolCount = 0;
		for (const descriptor of this.uiTools.values()) if (descriptor.serverName === serverName) uiToolCount++;
		return {
			toolCount,
			uiToolCount
		};
	}
	/**
	* Name/visibility/`hasUi` summary of every tool seen for a server in its
	* last sync (empty array if the server has never synced or was evicted).
	* Used by the read-only status endpoint; never includes `description` or
	* `inputSchema`.
	*/
	getToolSummaries(serverName) {
		return this.toolSummaries.get(serverName) ?? [];
	}
};
function extractText(content, toolName) {
	if (!Array.isArray(content)) return `(tool ${toolName} executed)`;
	return content.filter((item) => typeof item === "object" && item !== null && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n") || `(tool ${toolName} executed)`;
}

//#endregion
//#region src/transports/subprocess.ts
function createStdioTransport(config) {
	const expandedEnv = expandEnvVars(config.env, process.env, new Set(config.allowedVars));
	const inheritedEnv = scrubbedParentEnv();
	for (const blocked of EXTRA_BLOCKED_ENV_VARS) delete inheritedEnv[blocked];
	const safeEnv = {
		...inheritedEnv,
		...expandedEnv
	};
	const transport = new StdioClientTransport({
		command: config.command,
		args: config.args,
		env: safeEnv,
		cwd: config.cwd || void 0,
		maxBufferSize: config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES
	});
	return {
		transport,
		dispose: async () => {
			await transport.close().catch(() => void 0);
		}
	};
}

//#endregion
//#region src/transports/remote.ts
const LF = 10;
const CR = 13;
/**
* Wraps a `fetch` implementation so that response bodies are read through a
* byte-counting stream that errors once a single "message" exceeds
* `maxMessageBytes`. Counts actual bytes (not string length).
*
* For a plain (non-streaming) response, the whole body is one message, so
* the running count is never reset. For `text/event-stream` responses the
* stream never ends for the lifetime of the connection, so instead of
* capping the total stream we cap the size of each individual SSE event:
* the byte count resets every time a blank-line event boundary (`\n\n` /
* `\r\n\r\n`) is seen.
*/
function createByteCappedFetch(baseFetch, maxMessageBytes) {
	return async (url, init) => {
		const response = await baseFetch(url, init);
		if (!response.body) return response;
		const isEventStream = (response.headers.get("content-type") ?? "").includes("text/event-stream");
		const reader = response.body.getReader();
		let messageBytes = 0;
		let consecutiveNewlines = 0;
		const capped = new ReadableStream({
			async pull(controller) {
				let result;
				try {
					result = await reader.read();
				} catch (err) {
					controller.error(err);
					return;
				}
				if (result.done) {
					controller.close();
					return;
				}
				const value = result.value;
				if (!isEventStream) {
					messageBytes += value.byteLength;
					if (messageBytes > maxMessageBytes) {
						const err = /* @__PURE__ */ new Error(`Response body exceeded maximum message size of ${maxMessageBytes} bytes`);
						controller.error(err);
						await reader.cancel(err).catch(() => void 0);
						return;
					}
					controller.enqueue(value);
					return;
				}
				for (let i = 0; i < value.length; i++) {
					const byte = value[i];
					messageBytes++;
					if (byte === LF) {
						consecutiveNewlines++;
						if (consecutiveNewlines >= 2) messageBytes = 0;
					} else if (byte !== CR) consecutiveNewlines = 0;
					if (messageBytes > maxMessageBytes) {
						const err = /* @__PURE__ */ new Error(`SSE event exceeded maximum message size of ${maxMessageBytes} bytes`);
						controller.error(err);
						await reader.cancel(err).catch(() => void 0);
						return;
					}
				}
				controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			}
		});
		return new Response(capped, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers
		});
	};
}
function createRemoteTransport(config, authProvider, signal) {
	const url = new URL(config.url);
	const hostname = url.hostname.replace(/^\[|\]$/g, "");
	const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
	if (url.protocol === "http:" && !isLoopback) throw new Error(`Insecure transport: http:// is forbidden except on loopback (${url.hostname})`);
	const expandedHeaders = expandEnvVars(config.headers, process.env, new Set(config.allowedVars));
	const maxMessageBytes = config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
	const cappedFetch = createByteCappedFetch(fetch, maxMessageBytes);
	const requestInit = {
		headers: expandedHeaders,
		signal
	};
	switch (config.transport) {
		case "streamable-http": return new StreamableHTTPClientTransport(url, {
			requestInit,
			fetch: cappedFetch,
			authProvider
		});
		case "sse": return new SSEClientTransport(url, {
			requestInit,
			eventSourceInit: { fetch: cappedFetch },
			fetch: cappedFetch,
			authProvider
		});
		default: throw new Error(`Unsupported remote transport: ${config.transport}`);
	}
}

//#endregion
//#region src/transports/oauth-token-store.ts
/** Resolved lazily (not at module load) so tests can point `homedir()` elsewhere before the first call. */
function oauthDir() {
	return join(homedir(), ".dsh", "mcp-apps", "oauth");
}
/** A pending PKCE authorize attempt's verifier is dropped once older than this. */
const PENDING_VERIFIER_TTL_MS = 600 * 1e3;
function emptyState() {
	return { pendingVerifiers: {} };
}
function pathFor(serverName) {
	return join(oauthDir(), `${serverName}.json`);
}
/**
* No encryption: plaintext JSON restricted by filesystem permissions
* (0700 dir, 0600 file), the same trust model this plugin already applies to
* `headers`/`env` secrets — access-controlled and redacted from status/error
* output, never encrypted at rest.
*
* `mode` on `mkdirSync`/`writeFileSync` only applies when that call actually
* creates the directory/file, so permissions are re-applied with an explicit
* `chmodSync` on every write too — otherwise a pre-existing directory/file
* left with looser permissions (e.g. from an older version of this plugin)
* would never be corrected.
*/
function ensureDir() {
	const dir = oauthDir();
	mkdirSync(dir, {
		recursive: true,
		mode: 448
	});
	chmodSync(dir, 448);
}
function pruneExpired(state) {
	const cutoff = Date.now() - PENDING_VERIFIER_TTL_MS;
	const pendingVerifiers = {};
	for (const [authState, verifier] of Object.entries(state.pendingVerifiers)) if (verifier.createdAt >= cutoff) pendingVerifiers[authState] = verifier;
	return {
		...state,
		pendingVerifiers
	};
}
function readState(serverName) {
	try {
		const raw = readFileSync(pathFor(serverName), "utf8");
		return pruneExpired({
			pendingVerifiers: {},
			...JSON.parse(raw)
		});
	} catch {
		return emptyState();
	}
}
/**
* Writes via a temp file + rename in the same directory so a reader never
* observes a partially written file (`rename` is atomic on the same
* filesystem) — the closest this in-process, lock-free store gets to
* guarding against another process writing the same file concurrently.
*/
function writeState(serverName, state) {
	ensureDir();
	const finalPath = pathFor(serverName);
	const tmpPath = `${finalPath}.tmp-${randomUUID()}`;
	writeFileSync(tmpPath, JSON.stringify(state), { mode: 384 });
	chmodSync(tmpPath, 384);
	renameSync(tmpPath, finalPath);
}
var OAuthTokenStore = class {
	getClientInformation(serverName) {
		return readState(serverName).clientInformation;
	}
	setClientInformation(serverName, clientInformation) {
		writeState(serverName, {
			...readState(serverName),
			clientInformation
		});
	}
	getTokens(serverName) {
		return readState(serverName).tokens;
	}
	setTokens(serverName, tokens) {
		writeState(serverName, {
			...readState(serverName),
			tokens
		});
	}
	getPendingVerifier(serverName, authState) {
		return readState(serverName).pendingVerifiers[authState];
	}
	setPendingVerifier(serverName, authState, codeVerifier) {
		const state = readState(serverName);
		writeState(serverName, {
			...state,
			pendingVerifiers: {
				...state.pendingVerifiers,
				[authState]: {
					codeVerifier,
					createdAt: Date.now()
				}
			}
		});
	}
	deletePendingVerifier(serverName, authState) {
		const state = readState(serverName);
		if (!(authState in state.pendingVerifiers)) return;
		const pendingVerifiers = { ...state.pendingVerifiers };
		delete pendingVerifiers[authState];
		writeState(serverName, {
			...state,
			pendingVerifiers
		});
	}
	/** Clears everything stored for a server (`invalidateCredentials('all')`, or a future explicit "disconnect" action). */
	clear(serverName) {
		writeState(serverName, emptyState());
	}
	clearTokens(serverName) {
		writeState(serverName, {
			...readState(serverName),
			tokens: void 0
		});
	}
	clearClientInformation(serverName) {
		writeState(serverName, {
			...readState(serverName),
			clientInformation: void 0
		});
	}
};

//#endregion
//#region src/transports/oauth-provider.ts
function toWireTokens(tokens) {
	return {
		access_token: tokens.accessToken,
		refresh_token: tokens.refreshToken,
		token_type: tokens.tokenType ?? "Bearer",
		scope: tokens.scope,
		expires_in: tokens.expiresAt !== void 0 ? Math.max(0, Math.round((tokens.expiresAt - Date.now()) / 1e3)) : void 0
	};
}
function toStoredTokens(tokens) {
	return {
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		tokenType: tokens.token_type,
		scope: tokens.scope,
		expiresAt: tokens.expires_in !== void 0 ? Date.now() + tokens.expires_in * 1e3 : void 0
	};
}
/**
* Per-server `OAuthClientProvider`, backed by {@link OAuthTokenStore}.
*
* `codeVerifier()`/`saveCodeVerifier()` below are never actually invoked by
* this plugin's own flow and exist only to satisfy the interface (both are
* required, not optional) — see `ServerPool.getAuthorizeUrl` for why and how
* this plugin bypasses the SDK's `auth()` orchestrator instead.
*/
var RemoteOAuthProvider = class {
	serverName;
	options;
	store;
	/** This DSH host's configured `externalUrl` (`Config.externalUrl`) — never derived from a request, since it's baked into dynamic client registration and must stay stable across authorize/callback/refresh. */
	externalUrl;
	inFlightCodeVerifier;
	constructor(serverName, options, externalUrl, store = new OAuthTokenStore()) {
		this.serverName = serverName;
		this.options = options === true ? {} : options;
		this.externalUrl = externalUrl.replace(/\/$/, "");
		this.store = store;
	}
	get redirectUrl() {
		return `${this.externalUrl}/api/mcp-apps/oauth/callback?server=${encodeURIComponent(this.serverName)}`;
	}
	get clientMetadata() {
		return {
			client_name: "dsh-mcp-apps",
			redirect_uris: [this.redirectUrl],
			grant_types: ["authorization_code", "refresh_token"],
			token_endpoint_auth_method: this.options.clientSecret ? "client_secret_post" : "none",
			scope: this.options.scopes?.join(" ")
		};
	}
	clientInformation() {
		if (this.options.clientId) return {
			client_id: this.options.clientId,
			client_secret: this.options.clientSecret
		};
		return this.store.getClientInformation(this.serverName);
	}
	saveClientInformation(clientInformation) {
		if (this.options.clientId) return;
		this.store.setClientInformation(this.serverName, clientInformation);
	}
	tokens() {
		const stored = this.store.getTokens(this.serverName);
		return stored ? toWireTokens(stored) : void 0;
	}
	saveTokens(tokens) {
		this.store.setTokens(this.serverName, toStoredTokens(tokens));
	}
	/** No-op — see `ServerPool.getAuthorizeUrl` for how the authorize URL actually reaches the caller. */
	redirectToAuthorization() {}
	saveCodeVerifier(codeVerifier) {
		this.inFlightCodeVerifier = codeVerifier;
	}
	codeVerifier() {
		if (!this.inFlightCodeVerifier) throw new Error(`No PKCE code verifier available for server "${this.serverName}"`);
		return this.inFlightCodeVerifier;
	}
	invalidateCredentials(scope) {
		switch (scope) {
			case "all":
				this.store.clear(this.serverName);
				break;
			case "client":
				this.store.clearClientInformation(this.serverName);
				break;
			case "tokens":
				this.store.clearTokens(this.serverName);
				break;
			case "verifier":
				this.inFlightCodeVerifier = void 0;
				break;
			case "discovery": break;
		}
	}
};

//#endregion
//#region src/transports/server-pool.ts
/** Replacement text for a redacted secret or a stripped URL query/fragment/userinfo. */
const REDACTED = "[redacted]";
/** `lastErrors` entries are truncated to this many characters (plus an ellipsis) before storage. */
const MAX_ERROR_MESSAGE_LENGTH = 300;
/** Matches a `scheme://...` token so its userinfo/query/fragment can be stripped without touching the rest of the message. */
const URL_TOKEN_PATTERN = /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/\S+/g;
/** `scheme://[user:pass@]host/path?query#fragment` -> `scheme://host/path` (userinfo, query and fragment dropped). */
function sanitizeUrlToken(token) {
	const schemeEnd = token.indexOf("://");
	if (schemeEnd === -1) return token;
	const scheme = token.slice(0, schemeEnd + 3);
	let rest = token.slice(schemeEnd + 3);
	const queryOrFragmentIndex = rest.search(/[?#]/);
	if (queryOrFragmentIndex !== -1) rest = rest.slice(0, queryOrFragmentIndex);
	const pathStart = rest.indexOf("/");
	let authority = pathStart === -1 ? rest : rest.slice(0, pathStart);
	const path = pathStart === -1 ? "" : rest.slice(pathStart);
	const userinfoEnd = authority.lastIndexOf("@");
	if (userinfoEnd !== -1) authority = authority.slice(userinfoEnd + 1);
	return `${scheme}${authority}${path}`;
}
/**
* Sanitizes a raw connect/reconnect failure message before it is stored in
* `lastErrors` and served back over the unauthenticated `servers/status` RPC.
*
* The MCP SDK's connect failures can embed a remote server's configured
* `url` verbatim (a `fetch failed: https://host/mcp?token=...` style
* message), so every URL-shaped token in the message has its userinfo,
* query string and fragment stripped, keeping only `scheme://host/path`.
* `secretValues` additionally redacts any literal occurrence of this
* server's own expanded env values (stdio) or header values (remote), and
* of the recognizable parts of those values {@link expandSecretCandidates}
* derives (e.g. just the token out of a `Bearer <token>` header, and its
* percent-encoded form) — belt-and-suspenders for a subprocess or library
* that happens to echo one back in an error. Finally, whitespace/newlines
* are collapsed and the result is truncated to
* {@link MAX_ERROR_MESSAGE_LENGTH} characters.
*/
function sanitizeErrorMessage(message, secretValues = []) {
	let sanitized = message;
	const candidates = [...new Set(secretValues.flatMap(expandSecretCandidates))].sort((a, b) => b.length - a.length);
	for (const secret of candidates) {
		if (secret.length < 3) continue;
		sanitized = sanitized.split(secret).join(REDACTED);
	}
	sanitized = sanitized.replace(URL_TOKEN_PATTERN, sanitizeUrlToken);
	sanitized = sanitized.replace(/\s+/g, " ").trim();
	if (sanitized.length > MAX_ERROR_MESSAGE_LENGTH) sanitized = `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH)}…`;
	return sanitized;
}
/**
* Extracts a concise, human-readable error description from an error,
* including root-cause details for Node.js `TypeError: fetch failed` or network errors
* (e.g. ConnectTimeoutError, ECONNREFUSED) without dumping multi-line stack traces.
*/
function formatErrorMessage(err) {
	if (err instanceof Error) {
		const cause = err.cause;
		if (cause instanceof Error) {
			const causeMsg = cause.message;
			if (causeMsg && causeMsg !== err.message) return `${err.message} (${causeMsg})`;
		} else if (cause && typeof cause === "object") {
			const msg = cause.message;
			const code = cause.code;
			if (typeof msg === "string" && msg && msg !== err.message) return `${err.message} (${msg})`;
			if (typeof code === "string" && code) return `${err.message} (${code})`;
		}
		return err.message;
	}
	return String(err);
}
/** Leading `<scheme> <credential>` auth header words whose credential part is worth redacting on its own. */
const AUTH_SCHEME_WORDS = /^(bearer|basic|token|bot|apikey)\s+(.+)$/i;
/**
* Expands one configured secret value (e.g. a full `Authorization` header
* value like `Bearer abc123xyz`) into every literal form worth redacting on
* its own, since an error message rarely echoes the whole configured value
* verbatim — it's more likely to quote just the credential out of a header.
* Includes: the full value; each whitespace-separated part of it that's
* long enough to not be a common word (>= 8 chars); the credential after a
* leading auth scheme word (Bearer/Basic/Token/Bot/ApiKey), regardless of
* its own length as long as it's still >= 3 chars; and the percent-encoded
* form of each of those, when it differs (a URL-embedded token is often
* percent-encoded).
*/
function expandSecretCandidates(secret) {
	const candidates = new Set([secret]);
	for (const part of secret.split(/\s+/)) if (part.length >= 8) candidates.add(part);
	const schemeMatch = secret.match(AUTH_SCHEME_WORDS);
	if (schemeMatch) candidates.add(schemeMatch[2]);
	for (const candidate of [...candidates]) {
		const encoded = encodeURIComponent(candidate);
		if (encoded !== candidate) candidates.add(encoded);
	}
	return [...candidates];
}
/**
* Secret values configured for one server (expanded env for stdio, expanded
* headers for remote) — the set {@link sanitizeErrorMessage} redacts (after
* expanding each via {@link expandSecretCandidates}) if a connect/reconnect
* failure message happens to embed one, or a recognizable part of one,
* verbatim.
*/
function secretValuesFor(serverConfig, extra = []) {
	const dict = serverConfig.transport === "stdio" ? serverConfig.env : serverConfig.headers;
	return [...Object.values(expandEnvVars(dict, process.env, new Set(serverConfig.allowedVars))), ...extra];
}
const MAX_TOOLS_PER_SERVER = 256;
const MAX_RESOURCE_SIZE_BYTES = 10 * 1024 * 1024;
/**
* Byte length a base64 string decodes to, computed from the encoded string
* itself (each 4 base64 chars encode 3 bytes, minus 1 byte per trailing `=`
* padding char) rather than by actually decoding it. Lets callers enforce a
* size cap on a blob without allocating a full decoded copy just to measure
* it.
*/
function base64DecodedByteLength(base64) {
	const len = base64.length;
	if (len === 0) return 0;
	let padding = 0;
	if (base64.endsWith("==")) padding = 2;
	else if (base64.endsWith("=")) padding = 1;
	return Math.floor(len * 3 / 4) - padding;
}
/** Byte size of one resource content item: UTF-8 bytes for text, decoded-without-decoding bytes for a blob. */
function resourceContentByteSize(content) {
	if (content && typeof content === "object") {
		const c = content;
		if (typeof c.text === "string") return Buffer.byteLength(c.text, "utf8");
		if (typeof c.blob === "string") return base64DecodedByteLength(c.blob);
	}
	return 0;
}
/** Total byte size across every content item of a resource read result. */
function totalResourceContentBytes(contents) {
	return contents.reduce((sum, c) => sum + resourceContentByteSize(c), 0);
}
var ServerPool = class {
	ctx;
	config;
	toolManager;
	servers = /* @__PURE__ */ new Map();
	refreshSeq = /* @__PURE__ */ new Map();
	lastAppliedSeq = /* @__PURE__ */ new Map();
	lifecycleController = new AbortController();
	startupTasks = /* @__PURE__ */ new Map();
	/** Last connect/reconnect failure message per server, cleared on the next successful connect. Never holds env/headers/args. */
	lastErrors = /* @__PURE__ */ new Map();
	oauthTokenStore = new OAuthTokenStore();
	oauthProviders = /* @__PURE__ */ new Map();
	/** Set when a connect attempt against an oauth-enabled server's stored tokens throws `UnauthorizedError`; cleared on a successful connect or fresh tokens. Never holds a token value. */
	oauthNeedsAuth = /* @__PURE__ */ new Map();
	constructor(ctx, config, toolManager) {
		this.ctx = ctx;
		this.config = config;
		this.toolManager = toolManager;
	}
	initialSyncPromise = null;
	startAll() {
		if (!this.initialSyncPromise) this.initialSyncPromise = (async () => {
			const tasks = Object.entries(this.config.servers).map(async ([name$1, serverConfig]) => {
				const task = (async () => {
					try {
						if (this.lifecycleController.signal.aborted) return;
						await this.startServer(name$1, serverConfig, this.lifecycleController.signal);
					} catch (err) {
						if (!this.lifecycleController.signal.aborted) {
							const sanitized = sanitizeErrorMessage(formatErrorMessage(err), secretValuesFor(serverConfig, this.oauthSecretCandidates(name$1)));
							this.lastErrors.set(name$1, sanitized);
							console.warn(`mcp-apps: failed to connect to server "${name$1}": ${sanitized}`);
							this.scheduleReconnect(name$1);
						}
					} finally {
						this.startupTasks.delete(name$1);
					}
				})();
				this.startupTasks.set(name$1, task);
				return task;
			});
			await Promise.allSettled(tasks);
		})();
		return this.initialSyncPromise;
	}
	async waitForInitialSync(timeoutMs = 15e3) {
		if (this.initialSyncPromise) await Promise.race([this.initialSyncPromise, new Promise((resolve) => setTimeout(resolve, timeoutMs))]);
	}
	async startServer(serverName, serverConfig, signal) {
		const isAborted = () => signal?.aborted || this.lifecycleController.signal.aborted;
		if (isAborted()) return;
		const client = new Client({
			name: "dsh-mcp-apps",
			version: "0.2.12"
		}, { capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: [RESOURCE_MIME_TYPE] } } } });
		let managedStdio;
		let disposeTransport;
		if (serverConfig.transport === "stdio") {
			managedStdio = createStdioTransport(serverConfig);
			disposeTransport = managedStdio.dispose;
			try {
				await client.connect(managedStdio.transport);
			} catch (err) {
				await managedStdio.dispose().catch(() => void 0);
				await client.close().catch(() => void 0);
				throw err;
			}
		} else {
			let authProvider;
			if (serverConfig.oauth) {
				authProvider = this.getOrCreateOAuthProvider(serverName, serverConfig.oauth);
				if (!this.oauthTokenStore.getTokens(serverName)) return;
			}
			const remote = createRemoteTransport(serverConfig, authProvider, this.lifecycleController.signal);
			disposeTransport = () => remote.close();
			try {
				await client.connect(remote);
			} catch (err) {
				await remote.close().catch(() => void 0);
				await client.close().catch(() => void 0);
				if (err instanceof UnauthorizedError) {
					this.oauthNeedsAuth.set(serverName, true);
					return;
				}
				throw err;
			}
			this.oauthNeedsAuth.delete(serverName);
		}
		if (isAborted()) {
			await client.close().catch(() => void 0);
			await disposeTransport().catch(() => void 0);
			return;
		}
		const instance = {
			client,
			managedStdio,
			disposeTransport
		};
		this.servers.set(serverName, instance);
		client.onclose = () => this.handleServerClose(serverName);
		client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
			try {
				await this.refreshTools(serverName, client);
			} catch (err) {
				console.error(`mcp-apps: failed to re-sync tools for server "${serverName}":`, err);
			}
		});
		await this.refreshTools(serverName, client);
		this.lastErrors.delete(serverName);
	}
	async refreshTools(serverName, client) {
		const seq = (this.refreshSeq.get(serverName) ?? 0) + 1;
		this.refreshSeq.set(serverName, seq);
		const toolsResult = await client.listTools();
		if (this.lifecycleController.signal.aborted) return;
		if (this.servers.get(serverName)?.client !== client) return;
		if (toolsResult.tools.length > MAX_TOOLS_PER_SERVER) throw new Error(`Server "${serverName}" exceeded maximum tool limit (${MAX_TOOLS_PER_SERVER})`);
		if (seq < (this.lastAppliedSeq.get(serverName) ?? 0)) return;
		this.lastAppliedSeq.set(serverName, seq);
		const serverConfig = this.config.servers[serverName];
		this.toolManager.syncServerTools(serverName, client, toolsResult.tools, serverConfig);
	}
	getUiToolsSnapshot() {
		return this.toolManager.getUiToolsSnapshot();
	}
	/**
	* Read-only status of every configured server. Deliberately built from
	* only the fields on {@link ServerStatus} — never spreads `serverConfig`
	* or any part of it, so a future config field can't leak here by accident.
	*/
	getStatusSnapshot() {
		return Object.entries(this.config.servers).map(([name$1, serverConfig]) => {
			const { toolCount, uiToolCount } = this.toolManager.getToolCounts(name$1);
			return {
				name: name$1,
				transport: serverConfig.transport,
				connected: this.servers.has(name$1),
				toolCount,
				uiToolCount,
				lastError: this.lastErrors.get(name$1),
				tools: this.toolManager.getToolSummaries(name$1),
				oauth: serverConfig.transport === "stdio" || !serverConfig.oauth ? void 0 : { state: !this.oauthTokenStore.getTokens(name$1) ? "unauthenticated" : this.oauthNeedsAuth.get(name$1) ? "expired" : "authenticated" }
			};
		});
	}
	async listResources(serverName) {
		const instance = this.servers.get(serverName);
		if (!instance) throw new Error(`MCP server "${serverName}" is not connected`);
		return instance.client.listResources();
	}
	async readResourceRaw(serverName, uri, signal) {
		if (!uri) throw new Error("Missing resource URI");
		const instance = this.servers.get(serverName);
		if (!instance) throw new Error(`MCP server "${serverName}" is not connected`);
		const serverConfig = this.config.servers[serverName];
		const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs);
		const response = await instance.client.readResource({ uri }, {
			timeout,
			signal
		});
		if (totalResourceContentBytes(response.contents ?? []) > MAX_RESOURCE_SIZE_BYTES) throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`);
		return response;
	}
	async readResource(serverName, uri, signal) {
		if (!uri) throw new Error("Missing resource URI");
		const instance = this.servers.get(serverName);
		if (!instance) throw new Error(`MCP server "${serverName}" is not connected`);
		const serverConfig = this.config.servers[serverName];
		const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs);
		const response = await instance.client.readResource({ uri }, {
			timeout,
			signal
		});
		if (!response.contents || response.contents.length === 0) throw new Error(`Resource ${uri} returned invalid content items`);
		const item = response.contents.find((c) => {
			if (("mimeType" in c ? c.mimeType : void 0)?.includes("html")) return true;
			return "text" in c && typeof c.text === "string" && (c.text.includes("<html") || c.text.includes("<!DOCTYPE")) || "blob" in c && typeof c.blob === "string";
		}) ?? response.contents[0];
		if (!("text" in item && typeof item.text === "string") && !("blob" in item && typeof item.blob === "string")) throw new Error(`Resource ${uri} returned neither text nor blob HTML`);
		if (resourceContentByteSize(item) > MAX_RESOURCE_SIZE_BYTES) throw new Error(`Resource ${uri} exceeded maximum allowed size of 10MB`);
		let html;
		if ("text" in item && typeof item.text === "string") html = item.text;
		else if ("blob" in item && typeof item.blob === "string") html = Buffer.from(item.blob, "base64").toString("utf8");
		if (!html) throw new Error(`Resource ${uri} returned neither text nor blob HTML`);
		const meta = item._meta ?? item.meta;
		const ui = typeof meta === "object" && meta !== null ? meta.ui : void 0;
		const frame = resolveFrameConfig(this.config.frame);
		const preferredHeight = parsePreferredHeight(ui?.preferredHeight, frame.minHeight, frame.maxHeight);
		let permissions = ui?.permissions;
		if (permissions) {
			const allowed = new Set(serverConfig?.allowedPermissions ?? []);
			permissions = Object.fromEntries(Object.entries(permissions).filter(([key]) => {
				if ([
					"camera",
					"microphone",
					"geolocation"
				].includes(key)) return allowed.has(key);
				return true;
			}));
		}
		return {
			uri,
			html,
			csp: ui?.csp,
			permissions,
			...preferredHeight !== void 0 ? { preferredHeight } : {}
		};
	}
	async callTool(serverName, name$1, args, signal) {
		const instance = this.servers.get(serverName);
		if (!instance) throw new Error(`MCP server "${serverName}" is not connected`);
		const serverConfig = this.config.servers[serverName];
		const timeout = resolveToolCallTimeoutMs(serverConfig, this.config.defaultTimeoutMs);
		return instance.client.callTool({
			name: name$1,
			arguments: args ?? {}
		}, void 0, {
			timeout,
			signal
		});
	}
	reconnectAttempts = /* @__PURE__ */ new Map();
	reconnectTimers = /* @__PURE__ */ new Map();
	handleServerClose(serverName) {
		this.toolManager.evictServer(serverName);
		this.servers.delete(serverName);
		this.scheduleReconnect(serverName);
	}
	scheduleReconnect(serverName) {
		if (this.lifecycleController.signal.aborted) return;
		const serverConfig = this.config.servers[serverName];
		const opts = serverConfig?.reconnectOptions;
		if (!opts) return;
		const attempts = this.reconnectAttempts.get(serverName) ?? 0;
		if (attempts >= (opts.maxRetries ?? 5)) {
			console.warn(`mcp-apps: max reconnect attempts reached for "${serverName}"`);
			return;
		}
		const factor = opts.backoffFactor ?? 1.5;
		const initial = opts.initialDelayMs ?? 1e3;
		const maxDelay = opts.maxDelayMs ?? 3e4;
		const delay = Math.min(initial * Math.pow(factor, attempts), maxDelay);
		this.reconnectAttempts.set(serverName, attempts + 1);
		const existingTimer = this.reconnectTimers.get(serverName);
		if (existingTimer) clearTimeout(existingTimer);
		const timer = setTimeout(async () => {
			this.reconnectTimers.delete(serverName);
			if (this.lifecycleController.signal.aborted) return;
			if (this.startupTasks.has(serverName)) return;
			const task = (async () => {
				try {
					await this.startServer(serverName, serverConfig, this.lifecycleController.signal);
					this.reconnectAttempts.delete(serverName);
					this.lastErrors.delete(serverName);
				} catch (err) {
					const sanitized = sanitizeErrorMessage(formatErrorMessage(err), secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)));
					this.lastErrors.set(serverName, sanitized);
					console.warn(`mcp-apps: reconnect attempt ${attempts + 1} failed for "${serverName}": ${sanitized}`);
					this.scheduleReconnect(serverName);
				} finally {
					this.startupTasks.delete(serverName);
				}
			})();
			this.startupTasks.set(serverName, task);
			await task;
		}, delay);
		this.reconnectTimers.set(serverName, timer);
	}
	getOrCreateOAuthProvider(serverName, options) {
		let provider = this.oauthProviders.get(serverName);
		if (!provider) {
			provider = new RemoteOAuthProvider(serverName, options, this.config.externalUrl ?? "", this.oauthTokenStore);
			this.oauthProviders.set(serverName, provider);
		}
		return provider;
	}
	/** Extra redaction candidates for {@link sanitizeErrorMessage}: this server's current access/refresh token, if any. */
	oauthSecretCandidates(serverName) {
		const tokens = this.oauthTokenStore.getTokens(serverName);
		if (!tokens) return [];
		return [tokens.accessToken, tokens.refreshToken].filter((v) => typeof v === "string");
	}
	/** Sanitizes an error for one server the same way a connect/reconnect failure is (see `sanitizeErrorMessage`), for callers outside this class (e.g. the `oauth/*` RPC handlers in `src/index.ts`) that surface an error for an unauthenticated caller. */
	sanitizeError(serverName, err) {
		const serverConfig = this.config.servers[serverName];
		const rawMessage = err instanceof Error ? err.message : String(err);
		if (!serverConfig) return sanitizeErrorMessage(rawMessage);
		return sanitizeErrorMessage(rawMessage, secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)));
	}
	/** Serializes async work per server name (a promise chain keyed by `serverName`), so two concurrent `oauth/authorize` calls for the same not-yet-registered server can't each perform their own dynamic client registration and race to persist a different client. */
	oauthLocks = /* @__PURE__ */ new Map();
	withOAuthLock(serverName, fn) {
		const run = (this.oauthLocks.get(serverName) ?? Promise.resolve()).then(fn, fn);
		this.oauthLocks.set(serverName, run.then(() => void 0, () => void 0));
		return run;
	}
	/**
	* Resolves the authorize URL for an oauth-enabled server: performs RFC
	* 9728/8414 discovery, registers a dynamic client if none is configured or
	* already registered, then calls the SDK's low-level `startAuthorization`
	* directly instead of the `auth()` orchestrator — `auth()` is built to
	* drive an interactive flow itself (redirecting a user agent it controls),
	* but the authorize URL here has to be handed back over RPC for the
	* caller's own browser to open, so this plugin never lets `auth()` (or
	* `redirectToAuthorization`, see `RemoteOAuthProvider`) drive that part;
	* `completeOAuthCallback` below likewise calls `exchangeAuthorization`
	* directly rather than going through `auth()`.
	*
	* The redirect URI is built from `Config.externalUrl`, never from a
	* request: an inbound request's own URL/Host header is caller-controlled
	* and would let an anonymous caller poison this server's persisted OAuth
	* client registration (`registerClient` below) with an attacker-chosen
	* redirect target.
	*/
	async getAuthorizeUrl(serverName) {
		const serverConfig = this.config.servers[serverName];
		if (!serverConfig || serverConfig.transport === "stdio" || !serverConfig.oauth) throw new Error(`Server "${serverName}" is not configured for OAuth`);
		if (!this.config.externalUrl) throw new Error("OAuth requires `externalUrl` to be configured on this plugin (see README.md#configure)");
		const oauth = serverConfig.oauth;
		return this.withOAuthLock(serverName, async () => {
			const provider = this.getOrCreateOAuthProvider(serverName, oauth);
			const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } = await discoverOAuthServerInfo(serverConfig.url);
			let clientInformation = await provider.clientInformation();
			if (!clientInformation) {
				clientInformation = await registerClient(authorizationServerUrl, {
					metadata: authorizationServerMetadata,
					clientMetadata: provider.clientMetadata
				});
				await provider.saveClientInformation(clientInformation);
			}
			const scope = oauth === true ? void 0 : oauth.scopes?.join(" ");
			const state = crypto.randomUUID();
			const { authorizationUrl, codeVerifier } = await startAuthorization(authorizationServerUrl, {
				metadata: authorizationServerMetadata,
				clientInformation,
				redirectUrl: provider.redirectUrl,
				scope,
				state,
				resource: resourceMetadata ? new URL(resourceMetadata.resource) : void 0
			});
			this.oauthTokenStore.setPendingVerifier(serverName, state, codeVerifier);
			return authorizationUrl.toString();
		});
	}
	/**
	* Completes an authorization-code exchange for the `oauth/callback` route,
	* stores the resulting tokens, and re-triggers `startServer` for that one
	* server so it connects with them.
	*/
	async completeOAuthCallback(serverName, code, state) {
		const serverConfig = this.config.servers[serverName];
		if (!serverConfig || serverConfig.transport === "stdio" || !serverConfig.oauth) throw new Error(`Server "${serverName}" is not configured for OAuth`);
		const pending = this.oauthTokenStore.getPendingVerifier(serverName, state);
		if (!pending) throw new Error("No matching pending authorization for this state (it may have expired)");
		const provider = this.getOrCreateOAuthProvider(serverName, serverConfig.oauth);
		const clientInformation = await provider.clientInformation();
		if (!clientInformation) throw new Error(`No OAuth client registered for server "${serverName}"`);
		const { authorizationServerUrl, authorizationServerMetadata, resourceMetadata } = await discoverOAuthServerInfo(serverConfig.url);
		const tokens = await exchangeAuthorization(authorizationServerUrl, {
			metadata: authorizationServerMetadata,
			clientInformation,
			authorizationCode: code,
			codeVerifier: pending.codeVerifier,
			redirectUri: provider.redirectUrl,
			resource: resourceMetadata ? new URL(resourceMetadata.resource) : void 0
		});
		await provider.saveTokens(tokens);
		this.oauthTokenStore.deletePendingVerifier(serverName, state);
		this.oauthNeedsAuth.delete(serverName);
		this.retryAuth(serverName);
	}
	/** Re-triggers `startServer` for one server after fresh tokens are stored, reusing `startupTasks` bookkeeping to avoid double-connecting. */
	retryAuth(serverName) {
		if (this.lifecycleController.signal.aborted) return;
		if (this.startupTasks.has(serverName)) return;
		const serverConfig = this.config.servers[serverName];
		if (!serverConfig) return;
		const task = (async () => {
			try {
				await this.startServer(serverName, serverConfig, this.lifecycleController.signal);
				this.lastErrors.delete(serverName);
			} catch (err) {
				const sanitized = sanitizeErrorMessage(formatErrorMessage(err), secretValuesFor(serverConfig, this.oauthSecretCandidates(serverName)));
				this.lastErrors.set(serverName, sanitized);
				console.warn(`mcp-apps: post-auth connect failed for "${serverName}": ${sanitized}`);
			} finally {
				this.startupTasks.delete(serverName);
			}
		})();
		this.startupTasks.set(serverName, task);
	}
	/**
	* Manually retries connecting to a server (e.g. from the UI "Retry" button).
	* Resets reconnect backoff counters and cancels any pending timer.
	*/
	async retryServer(serverName) {
		const serverConfig = this.config.servers[serverName];
		if (!serverConfig) throw new Error(`Server "${serverName}" is not configured`);
		const timer = this.reconnectTimers.get(serverName);
		if (timer) {
			clearTimeout(timer);
			this.reconnectTimers.delete(serverName);
		}
		this.reconnectAttempts.delete(serverName);
		await this.startServer(serverName, serverConfig, this.lifecycleController.signal);
	}
	/**
	* Disconnects an OAuth-authenticated server, stops any reconnect attempts,
	* evicts its tools from the host, and clears stored credentials.
	*/
	async disconnectOAuth(serverName) {
		const serverConfig = this.config.servers[serverName];
		if (!serverConfig || serverConfig.transport === "stdio" || !serverConfig.oauth) throw new Error(`Server "${serverName}" is not configured for OAuth`);
		return this.withOAuthLock(serverName, async () => {
			const timer = this.reconnectTimers.get(serverName);
			if (timer) {
				clearTimeout(timer);
				this.reconnectTimers.delete(serverName);
			}
			this.reconnectAttempts.delete(serverName);
			const instance = this.servers.get(serverName);
			if (instance) {
				instance.client.onclose = void 0;
				this.servers.delete(serverName);
				this.toolManager.evictServer(serverName);
				try {
					await instance.client.close().catch(() => void 0);
					await instance.disposeTransport().catch(() => void 0);
				} catch (err) {
					console.error(`mcp-apps: error closing server "${serverName}" on disconnect:`, err);
				}
			}
			this.oauthTokenStore.clear(serverName);
			this.oauthProviders.delete(serverName);
			this.oauthNeedsAuth.delete(serverName);
			this.lastErrors.delete(serverName);
		});
	}
	async stopAll() {
		this.lifecycleController.abort();
		for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
		this.reconnectTimers.clear();
		this.reconnectAttempts.clear();
		await Promise.allSettled(Array.from(this.startupTasks.values()));
		for (const [name$1, instance] of this.servers.entries()) {
			try {
				await instance.client.close().catch(() => void 0);
				await instance.disposeTransport().catch(() => void 0);
			} catch (err) {
				console.error(`mcp-apps: error stopping server "${name$1}":`, err);
			}
			this.toolManager.evictServer(name$1);
		}
		this.servers.clear();
	}
};

//#endregion
//#region src/index.ts
const name = "mcp-apps";
const inject = ["tools", "connection"];
function apply(ctx, config) {
	const sessionStore = new AppSessionStore();
	let approvalService;
	let agentsService;
	if (Object.values(config.servers).some((server) => server.allowAppToolCalls === "approve")) {
		ctx.inject(["approval"], (serviceCtx) => {
			const service = serviceCtx.approval;
			approvalService = service;
			return () => {
				if (approvalService === service) approvalService = void 0;
			};
		});
		ctx.inject(["agents"], (serviceCtx) => {
			const service = serviceCtx.agents;
			agentsService = service;
			return () => {
				if (agentsService === service) agentsService = void 0;
			};
		});
	}
	const notifyUiToolsChanged = () => {
		try {
			ctx.emit("ui-tools/changed");
		} catch {}
	};
	const toolManager = new ServerToolManager(ctx.tools, sessionStore, notifyUiToolsChanged, config.defaultTimeoutMs);
	const pool = new ServerPool(ctx, config, toolManager);
	ctx.effect(() => {
		if (Object.keys(config.servers).length > 0) return () => {};
		const dispose = ctx.tools.register({
			name: SETUP_TOOL_NAME,
			description: SETUP_HINT,
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			},
			execute: async () => ({ content: [{
				type: "text",
				text: SETUP_HINT
			}] }),
			output: {
				schema: {
					type: "object",
					properties: { content: {
						type: "array",
						items: {}
					} },
					required: ["content"],
					additionalProperties: false
				},
				render: (_args, value) => Array.isArray(value?.content) ? value.content : []
			}
		});
		return () => {
			dispose();
		};
	});
	ctx.effect(() => {
		let isDraining = false;
		const inFlight = /* @__PURE__ */ new Set();
		const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"\"": "&quot;",
			"'": "&#39;"
		})[c]);
		const OAUTH_CALLBACK_HTML = (body) => `<!doctype html><html><body>${escapeHtml(body)}<script>window.close()<\/script></body></html>`;
		const requireSession = (params) => {
			const sessionToken = typeof params.sessionToken === "string" ? params.sessionToken : void 0;
			if (!sessionToken) return { error: failure("unauthorized", "Missing session token") };
			const session = sessionStore.get(sessionToken);
			if (!session) return { error: failure("unauthorized", "Invalid or expired session token") };
			if (params.server && typeof params.server === "string" && params.server !== session.serverName) return { error: failure("forbidden", "Resource belongs to a different server") };
			return { session };
		};
		const connectionFetch = ctx.connection.fetch;
		const handleEndpoint = async (endpoint, payload, signal) => {
			if (isDraining) return failure("unavailable", "Host plugin is unloading");
			const params = typeof payload === "object" && payload !== null ? payload : {};
			const task = (async () => {
				try {
					switch (endpoint) {
						case "tools/list-ui":
							await pool.waitForInitialSync();
							return {
								ok: true,
								value: pool.getUiToolsSnapshot()
							};
						case "servers/status":
							await pool.waitForInitialSync();
							return {
								ok: true,
								value: pool.getStatusSnapshot()
							};
						case "frame": return {
							ok: true,
							value: resolveFrameConfig(config.frame)
						};
						case "resources/list": {
							const session = requireSession(params);
							if ("error" in session) return session.error;
							return {
								ok: true,
								value: await pool.listResources(session.session.serverName)
							};
						}
						case "resources/read": {
							const session = requireSession(params);
							if ("error" in session) return session.error;
							const uri = typeof params.uri === "string" ? params.uri : void 0;
							return {
								ok: true,
								value: await pool.readResource(session.session.serverName, uri, signal)
							};
						}
						case "resources/read-raw": {
							const session = requireSession(params);
							if ("error" in session) return session.error;
							const uri = typeof params.uri === "string" ? params.uri : void 0;
							if (!uri) return failure("bad-request", "Missing uri parameter");
							return {
								ok: true,
								value: await pool.readResourceRaw(session.session.serverName, uri, signal)
							};
						}
						case "tools/call": {
							const sessionToken = typeof params.sessionToken === "string" ? params.sessionToken : void 0;
							if (!sessionToken) return failure("unauthorized", "Missing session token");
							const session = sessionStore.get(sessionToken);
							if (!session) return failure("unauthorized", "Invalid or expired session token");
							if (params.server && typeof params.server === "string" && params.server !== session.serverName) return failure("forbidden", "Tool belongs to a different server");
							const toolName = typeof params.name === "string" ? params.name : "";
							if (!session.allowedReverseTools.has(toolName)) return failure("forbidden", `Tool "${toolName}" is not permitted for this session`);
							if (config.servers[session.serverName]?.allowAppToolCalls === "approve") {
								const currentApproval = approvalService;
								const currentAgents = agentsService;
								const agent = session.agentId && currentAgents ? currentAgents.get(session.agentId) : void 0;
								if (!currentApproval || !currentAgents || !agent) return failure("unavailable", "Approval service or agent not available for tool call approval");
								if (agent.status !== "running") return failure("unavailable", `Cannot request approval while agent "${agent.id}" is idle`);
								try {
									const outcome = await currentApproval.request({
										agent,
										toolName,
										callId: session.callId,
										reason: `MCP App requested execution of tool "${toolName}"`,
										signal
									});
									if (approvalService !== currentApproval || agentsService !== currentAgents) return failure("unavailable", "Approval service or agent not available for tool call approval");
									if (outcome !== "allowed-once") {
										if (outcome === "unavailable") return failure("unavailable", `Approval service is unavailable for tool "${toolName}"`);
										if (outcome === "cancelled") return failure("cancelled", `Approval request for tool "${toolName}" was cancelled`);
										return failure("forbidden", `Tool call "${toolName}" was rejected by approval policy (${outcome})`);
									}
								} catch (err) {
									return failure("unavailable", `Approval request failed: ${err instanceof Error ? err.message : String(err)}`);
								}
							}
							const args = typeof params.arguments === "object" && params.arguments !== null ? params.arguments : {};
							return {
								ok: true,
								value: await pool.callTool(session.serverName, toolName, args, signal)
							};
						}
						case "oauth/authorize": {
							const server = typeof params.server === "string" ? params.server : void 0;
							if (!server) return failure("bad-request", "Missing server parameter");
							try {
								return {
									ok: true,
									value: { authorizeUrl: await pool.getAuthorizeUrl(server) }
								};
							} catch (err) {
								return failure("internal-error", pool.sanitizeError(server, err));
							}
						}
						case "oauth/disconnect": {
							const server = typeof params.server === "string" ? params.server : void 0;
							if (!server) return failure("bad-request", "Missing server parameter");
							try {
								await pool.disconnectOAuth(server);
								notifyUiToolsChanged();
								return {
									ok: true,
									value: { disconnected: true }
								};
							} catch (err) {
								return failure("internal-error", pool.sanitizeError(server, err));
							}
						}
						case "servers/retry": {
							const server = typeof params.server === "string" ? params.server : void 0;
							if (!server) return failure("bad-request", "Missing server parameter");
							try {
								await pool.retryServer(server);
								notifyUiToolsChanged();
								return {
									ok: true,
									value: { retried: true }
								};
							} catch (err) {
								return failure("internal-error", pool.sanitizeError(server, err));
							}
						}
						default: return failure("bad-request", `Unknown endpoint "${endpoint}"`);
					}
				} catch (err) {
					return failure("internal-error", err instanceof Error ? err.message : String(err));
				}
			})();
			inFlight.add(task);
			try {
				return await task;
			} finally {
				inFlight.delete(task);
			}
		};
		const unregisterPostRoutes = [
			"tools/list-ui",
			"servers/status",
			"frame",
			"resources/list",
			"resources/read",
			"resources/read-raw",
			"tools/call",
			"oauth/authorize",
			"oauth/disconnect",
			"servers/retry"
		].map((endpoint) => connectionFetch.register({
			path: `/api/mcp-apps/${endpoint}`,
			methods: ["POST"],
			requestBody: "buffered",
			fetch: async (request) => {
				let message;
				try {
					message = await request.json();
				} catch {
					return new Response("body is not JSON", { status: 400 });
				}
				const parsed = clientRequestSchema.safeParse(message);
				if (!parsed.success) return new Response("invalid Connection RPC envelope", { status: 400 });
				const envelope = parsed.data;
				const expectedMethod = `mcp-apps/${endpoint}`;
				if (envelope.method !== expectedMethod) return new Response("invalid Connection RPC envelope", { status: 400 });
				const result = await handleEndpoint(endpoint, envelope.payload, request.signal);
				return Response.json({
					type: "server-response",
					rpcId: envelope.rpcId,
					result
				});
			}
		}));
		const handleOAuthCallback = async (rawUrl) => {
			const url = new URL(rawUrl, "http://127.0.0.1");
			const server = url.searchParams.get("server");
			const code = url.searchParams.get("code");
			const state = url.searchParams.get("state");
			const idpError = url.searchParams.get("error");
			if (idpError) return {
				status: 400,
				html: OAUTH_CALLBACK_HTML(`Authorization failed: ${pool.sanitizeError(server ?? "", new Error(idpError))}`)
			};
			if (!server || !code || !state) return {
				status: 400,
				html: OAUTH_CALLBACK_HTML("Authorization callback is missing required parameters.")
			};
			try {
				await pool.completeOAuthCallback(server, code, state);
			} catch (err) {
				return {
					status: 400,
					html: OAUTH_CALLBACK_HTML(`Authorization failed: ${pool.sanitizeError(server, err)}`)
				};
			}
			notifyUiToolsChanged();
			return {
				status: 200,
				html: OAUTH_CALLBACK_HTML("Authorization complete. You can close this window.")
			};
		};
		const unregisterCallbackRoute = connectionFetch.register({
			path: "/api/mcp-apps/oauth/callback",
			methods: ["GET"],
			requestBody: "buffered",
			fetch: async (request) => {
				const { status, html } = await handleOAuthCallback(request.url);
				return new Response(html, {
					status,
					headers: { "content-type": "text/html; charset=utf-8" }
				});
			}
		});
		let unregisterWebServerRoute;
		const registerOnWebServer = (webServer) => {
			try {
				const disposer = webServer.register({
					kind: "exact",
					path: "/api/mcp-apps/oauth/callback",
					handler: async (req, res) => {
						if (req.method !== "GET") {
							res.writeHead(405).end();
							return;
						}
						const { status, html } = await handleOAuthCallback(req.url ?? "/");
						res.writeHead(status, {
							"content-type": "text/html; charset=utf-8",
							"cache-control": "no-store"
						}).end(html);
					}
				});
				console.info("mcp-apps: registered OAuth callback route directly on webServer");
				return disposer;
			} catch (err) {
				console.warn("mcp-apps: failed to register OAuth callback on webServer:", err);
				return;
			}
		};
		if (config.externalUrl && typeof ctx.inject === "function") ctx.inject(["webServer"], (webCtx) => {
			unregisterWebServerRoute = registerOnWebServer(webCtx.webServer);
		});
		pool.startAll();
		return async () => {
			isDraining = true;
			const cleanupErrors = [];
			const cleanup = async (operation) => {
				try {
					await operation();
				} catch (err) {
					cleanupErrors.push(err);
				}
			};
			for (const unregister of [
				...unregisterPostRoutes,
				unregisterCallbackRoute,
				unregisterWebServerRoute
			].filter(Boolean)) await cleanup(() => unregister());
			let drainTimer;
			await cleanup(() => Promise.race([Promise.allSettled(Array.from(inFlight)), new Promise((resolve) => {
				drainTimer = setTimeout(resolve, 2e3);
			})]));
			if (drainTimer) clearTimeout(drainTimer);
			await cleanup(() => pool.stopAll());
			await cleanup(() => toolManager.disposeAll());
			await cleanup(() => sessionStore.dispose());
			if (cleanupErrors.length > 0) throw cleanupErrors[0];
		};
	}, "mcp-apps: lifecycle coordinator");
}
function failure(code, message) {
	return {
		ok: false,
		error: {
			code,
			message,
			details: {}
		}
	};
}

//#endregion
export { Config, apply, inject, name };