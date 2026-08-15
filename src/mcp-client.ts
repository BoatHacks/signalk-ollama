/**
 * Minimal MCP (Model Context Protocol, modelcontextprotocol.io) client over
 * the Streamable HTTP transport — just enough to initialize a session, list
 * a server's tools, and call them from the chat tool-calling loop in
 * service.ts. Not a general-purpose SDK: no resources, prompts, sampling, or
 * subscriptions — signalk-mcp-container (and any other MCP server this
 * plugin talks to) is used purely as a tool source for Ollama's tool-calling
 * API.
 */

import { errMsg } from "signalk-container-helper";
import type { OllamaToolDefinition } from "./ollama-api.js";

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpToolResultContent {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface McpToolResult {
  content?: McpToolResultContent[];
  isError?: boolean;
}

export function toOllamaTool(tool: McpToolDefinition): OllamaToolDefinition {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema ?? { type: "object", properties: {} },
    },
  };
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

let nextRequestId = 1;

/**
 * Parse an SSE stream body into its individual events, each event's `data:`
 * line(s) joined per the spec (multiple `data:` lines in one event
 * concatenate with `\n`). Comment lines (`:...`) and other SSE fields
 * (`event:`, `id:`, `retry:`) are ignored — only the payload is needed here.
 */
function parseSseDataFrames(text: string): string[] {
  const frames: string[] = [];
  for (const rawEvent of text.split(/\r?\n\r?\n/)) {
    const dataLines = rawEvent
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length > 0) frames.push(dataLines.join("\n"));
  }
  return frames;
}

/**
 * POST one JSON-RPC message. The Streamable HTTP transport lets a server
 * answer either `application/json` (one response object) or
 * `text/event-stream` — one or more SSE events, e.g. progress notifications
 * for a long-running tool call followed eventually by the actual response.
 * Both are handled here; for SSE, every event is parsed and the one whose
 * `id` matches this request's id is used (notifications carry no id and are
 * skipped). A session id returned via the `Mcp-Session-Id` response header
 * is echoed back on every later call, per the spec.
 */
async function postJsonRpc(
  url: string,
  method: string,
  params: Record<string, unknown> | undefined,
  sessionId: string | null,
  isNotification = false,
): Promise<{ result: unknown; sessionId: string | null }> {
  const body: Record<string, unknown> = { jsonrpc: "2.0", method };
  if (params !== undefined) body.params = params;
  const requestId = isNotification ? undefined : nextRequestId++;
  if (requestId !== undefined) body.id = requestId;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new Error(`MCP ${method} request failed: ${errMsg(err)}`, {
      cause: err,
    });
  }
  const returnedSession = res.headers.get("mcp-session-id") ?? sessionId;

  if (isNotification) {
    if (!res.ok) {
      throw new Error(`MCP ${method} notification failed: HTTP ${res.status}`);
    }
    return { result: undefined, sessionId: returnedSession };
  }
  if (!res.ok) {
    throw new Error(`MCP ${method} failed: HTTP ${res.status}`);
  }

  const contentType = res.headers.get("content-type") ?? "";
  let payload: JsonRpcResponse | undefined;
  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const frames = parseSseDataFrames(text);
    if (frames.length === 0) {
      throw new Error(`MCP ${method}: SSE response carried no data frame`);
    }
    for (const frame of frames) {
      const parsed = JSON.parse(frame) as JsonRpcResponse;
      if (parsed.id === requestId) {
        payload = parsed;
        break;
      }
    }
    if (!payload) {
      throw new Error(
        `MCP ${method}: SSE response carried ${frames.length} event(s) but none matched request id ${requestId}`,
      );
    }
  } else {
    payload = (await res.json()) as JsonRpcResponse;
  }
  if (payload.error) {
    throw new Error(`MCP ${method} error: ${payload.error.message}`);
  }
  return { result: payload.result, sessionId: returnedSession };
}

/**
 * One MCP server connection. Lazily initializes (and caches) a session on
 * first use; `reset()` drops that cache so the next call re-initializes —
 * call it after a request fails in case the server-side session expired.
 */
export class McpConnectionClient {
  private sessionId: string | null = null;
  private initialized: Promise<void> | null = null;

  constructor(
    readonly name: string,
    readonly url: string,
  ) {}

  private ensureInitialized(): Promise<void> {
    this.initialized ??= this.initialize();
    return this.initialized;
  }

  private async initialize(): Promise<void> {
    const { sessionId } = await postJsonRpc(
      this.url,
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "signalk-ollama", version: "1.0.0" },
      },
      this.sessionId,
    );
    this.sessionId = sessionId;
    await postJsonRpc(
      this.url,
      "notifications/initialized",
      undefined,
      this.sessionId,
      true,
    );
  }

  async listTools(): Promise<McpToolDefinition[]> {
    await this.ensureInitialized();
    const { result } = await postJsonRpc(
      this.url,
      "tools/list",
      {},
      this.sessionId,
    );
    const tools = (result as { tools?: McpToolDefinition[] } | undefined)
      ?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    await this.ensureInitialized();
    const { result } = await postJsonRpc(
      this.url,
      "tools/call",
      { name, arguments: args },
      this.sessionId,
    );
    return (result ?? {}) as McpToolResult;
  }

  /** Drop the cached session so the next call re-initializes from scratch. */
  reset(): void {
    this.sessionId = null;
    this.initialized = null;
  }
}
