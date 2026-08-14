/**
 * Client for the bits of the Ollama HTTP API this plugin drives directly:
 * listing/pulling/deleting models, and proxying chat for the bundled
 * webapp's playground. Not a general-purpose Ollama client — most callers
 * of the LLM itself are sibling services that talk to Ollama's API on
 * their own; the playground is the one exception this plugin hosts itself.
 */

import { errMsg } from "signalk-container-helper";

export interface OllamaTag {
  name: string;
}

/** Ollama's tool-calling request shape (`tools: [...]` on /api/chat). */
export interface OllamaToolDefinition {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface PullEvent {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  error?: string;
}

/** A model-requested tool invocation, as Ollama reports it on an assistant message. */
export interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Set on an assistant message that requested tool calls. */
  tool_calls?: ToolCall[];
}

export interface ChatChunk {
  message?: { role: string; content: string; tool_calls?: ToolCall[] };
  done?: boolean;
  eval_count?: number;
  eval_duration?: number;
  error?: string;
}

/**
 * Read a fetch response body as newline-delimited JSON, invoking `onLine`
 * for each parsed object. Shared by pullModel and chatStream — both are
 * "POST, stream:true, one JSON object per line" against Ollama's API.
 */
async function readNdjson<T extends { error?: string }>(
  res: Response,
  requestLabel: string,
  onLine: (event: T) => void,
): Promise<void> {
  if (!res.body) {
    throw new Error(`${requestLabel} returned no response body`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      const event = JSON.parse(line) as T;
      if (event.error) throw new Error(event.error);
      onLine(event);
    }
  }
}

/** "llama3.2" and "llama3.2:latest" name the same pulled model. */
export function normalizeModelName(name: string): string {
  return name.includes(":") ? name : `${name}:latest`;
}

/** Model names Ollama already has pulled, normalized. Throws on transport/HTTP errors. */
export async function listLocalModels(baseUrl: string): Promise<Set<string>> {
  const res = await fetch(`${baseUrl}/api/tags`);
  if (!res.ok) {
    throw new Error(`GET /api/tags failed: HTTP ${res.status}`);
  }
  const body = (await res.json()) as { models?: OllamaTag[] };
  const names = new Set<string>();
  for (const model of body.models ?? []) {
    if (typeof model.name === "string") names.add(model.name);
  }
  return names;
}

/**
 * Stream a `POST /api/pull`, invoking `onProgress` for each NDJSON line.
 * Resolves once Ollama reports the final "success" status; rejects on a
 * transport error, non-2xx response, or an `{error}` line in the stream —
 * Ollama reports failures (unknown model, disk full, registry unreachable)
 * inside a 200 response body rather than as an HTTP status.
 */
export async function pullModel(
  baseUrl: string,
  model: string,
  onProgress: (event: PullEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });
  } catch (err) {
    throw new Error(`pull request for ${model} failed: ${errMsg(err)}`, {
      cause: err,
    });
  }
  if (!res.ok) {
    throw new Error(`pull request for ${model} failed: HTTP ${res.status}`);
  }
  let sawSuccess = false;
  await readNdjson<PullEvent>(res, `pull request for ${model}`, (event) => {
    if (event.status === "success") sawSuccess = true;
    onProgress(event);
  });
  if (!sawSuccess) {
    throw new Error(`pull stream for ${model} ended without a success status`);
  }
}

export interface ChatStreamOptions {
  signal?: AbortSignal;
  /** Tools offered to the model (Ollama tool-calling); omitted when empty. */
  tools?: OllamaToolDefinition[];
}

/**
 * Stream a `POST /api/chat`, invoking `onChunk` for each NDJSON line —
 * the plugin's own webapp playground is the one caller; other consumers of
 * the LLM talk to Ollama's API directly. Resolves once the stream ends;
 * rejects on a transport error, non-2xx response, or an `{error}` line.
 */
export async function chatStream(
  baseUrl: string,
  model: string,
  messages: ChatMessage[],
  onChunk: (chunk: ChatChunk) => void,
  options: ChatStreamOptions = {},
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        ...(options.tools?.length ? { tools: options.tools } : {}),
      }),
      signal: options.signal,
    });
  } catch (err) {
    throw new Error(`chat request failed: ${errMsg(err)}`, { cause: err });
  }
  if (!res.ok) {
    throw new Error(`chat request failed: HTTP ${res.status}`);
  }
  await readNdjson<ChatChunk>(res, "chat request", onChunk);
}

/** Remove a locally-pulled model. */
export async function deleteModel(
  baseUrl: string,
  model: string,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/delete`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model }),
  });
  if (!res.ok) {
    throw new Error(`delete of ${model} failed: HTTP ${res.status}`);
  }
}
